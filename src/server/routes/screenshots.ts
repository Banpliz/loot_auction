import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells, cropBox } from '../grid-slice';
import { isTemplate, LAYOUT_TEMPLATES } from '../layout-templates';
import { detectColor } from '../color-detect';
import { computeIconSignature, groupBySignature, isSameIcon, type IconSignature } from '../dedup';

interface SlicedRow {
  screenshotId: number;
  cellPath: string;
  imagePath: string;
}

export function registerScreenshotRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { id: string } }>(
    '/events/:id/screenshots',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);

      // Read every part regardless of order. Multiple files can arrive in one request
      // (admin picks several screenshots at once); rows/template apply to all of them.
      let rows: number | undefined;
      let template: string | undefined;
      const fileBuffers: Buffer[] = [];

      for await (const part of request.parts()) {
        if (part.type === 'file') {
          fileBuffers.push(await part.toBuffer());
        } else if (part.fieldname === 'rows') {
          rows = Number(part.value);
        } else if (part.fieldname === 'template') {
          template = part.value as string;
        }
      }

      if (fileBuffers.length === 0) {
        reply.code(400).send({ error: 'at least one file is required' });
        return;
      }
      if (!Number.isInteger(rows) || rows! < 1 || rows! > 50) {
        reply.code(400).send({ error: 'rows must be a positive integer between 1 and 50' });
        return;
      }
      if (!isTemplate(template)) {
        reply.code(400).send({ error: 'template must be feast or invasion' });
        return;
      }

      const uploadsDir = path.join(deps.dataDir, 'uploads');
      const originalsDir = path.join(uploadsDir, 'originals');
      const itemsDir = path.join(uploadsDir, 'items');
      await fs.mkdir(originalsDir, { recursive: true });

      const userId = request.telegramUser!.telegramId;
      const insertScreenshot = deps.db.prepare(
        'INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, ?, ?, ?)'
      );
      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, image_path, color, quantity, status) VALUES (?, ?, ?, ?, ?, 'pool')"
      );

      const { iconBox } = LAYOUT_TEMPLATES[template];
      const slicedRows: SlicedRow[] = [];

      for (let f = 0; f < fileBuffers.length; f++) {
        const originalPath = path.join(originalsDir, `${eventId}-${Date.now()}-${f}.png`);
        await fs.writeFile(originalPath, fileBuffers[f]);

        const screenshotId = insertScreenshot.run(eventId, originalPath, rows, template, userId)
          .lastInsertRowid as number;

        const cellPaths = await sliceImageToCells(
          originalPath,
          rows!,
          1,
          itemsDir,
          `ss${screenshotId}`,
          LAYOUT_TEMPLATES[template].contentTop,
          LAYOUT_TEMPLATES[template].rowHeight
        );
        for (let i = 0; i < cellPaths.length; i++) {
          const cellPath = cellPaths[i];
          // The icon badge alone identifies the item, so it's what gets shown as the
          // lot's image (and compared below to spot duplicate rows); the full row strip
          // stays only as the source for color detection. Templates without a measured
          // iconBox yet fall back to using the whole row for both.
          const imagePath = iconBox
            ? await cropBox(cellPath, iconBox, path.join(itemsDir, `ss${screenshotId}-${i}-icon.png`))
            : cellPath;
          slicedRows.push({ screenshotId, cellPath, imagePath });
        }
      }

      // The same item often appears as several separate rows in the source screenshot
      // (a common drop won by many people) — grouping identical-looking icons into one
      // lot with a quantity, instead of one lot per row, is the whole point of this
      // endpoint; see dedup.ts for how "identical-looking" is decided and its one known
      // blind spot (two different items that share the exact same icon art, like a
      // chest whose graphic doesn't change between tiers, still merge).
      const withSignatures = await Promise.all(
        slicedRows.map(async (row) => ({ signature: await computeIconSignature(row.imagePath), value: row }))
      );
      const signatureByPath = new Map(withSignatures.map((s) => [s.value.imagePath, s.signature]));
      const groups = groupBySignature<SlicedRow>(withSignatures as { signature: IconSignature; value: SlicedRow }[]);

      // Дубли бьют не только внутри одной загрузки, но и между отдельными
      // выгрузками скриншотов (тот же лот попал на два разных скрина) — поэтому
      // здесь ещё раз сверяем иконку с тем, что уже лежит в пуле этого ивента,
      // и вместо нового лота просто добавляем количество к найденному.
      const existingPoolItems = deps.db
        .prepare("SELECT id, image_path as imagePath, quantity FROM items WHERE event_id = ? AND status = 'pool'")
        .all(eventId) as { id: number; imagePath: string; quantity: number }[];
      const existingSignatures = await Promise.all(
        existingPoolItems.map(async (item) => ({
          item,
          signature: await computeIconSignature(path.join(uploadsDir, item.imagePath)),
        }))
      );
      const bumpQuantity = deps.db.prepare('UPDATE items SET quantity = quantity + ? WHERE id = ?');

      const itemIds: number[] = [];
      for (const group of groups) {
        const representative = group[0];
        const signature = signatureByPath.get(representative.imagePath)!;

        const existingMatch = existingSignatures.find((es) => isSameIcon(es.signature, signature));
        if (existingMatch) {
          bumpQuantity.run(group.length, existingMatch.item.id);
          existingMatch.item.quantity += group.length;
          itemIds.push(existingMatch.item.id);
          continue;
        }

        const relPath = path.relative(uploadsDir, representative.imagePath).split(path.sep).join('/');

        // Color detection is a plain pixel sample (no OCR, no network) — cheap enough
        // to do inline instead of the background-job dance OCR used to need.
        let color: 'blue' | 'purple' | 'red' = 'blue';
        try {
          color = await detectColor(representative.cellPath, template);
        } catch (err) {
          request.log.warn({ err }, 'color detection failed, defaulting to blue');
        }

        const itemId = insertItem
          .run(eventId, representative.screenshotId, relPath, color, group.length)
          .lastInsertRowid as number;
        itemIds.push(itemId);
        existingSignatures.push({ item: { id: itemId, imagePath: relPath, quantity: group.length }, signature });
      }

      return { itemIds };
    }
  );
}
