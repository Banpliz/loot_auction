import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells, cropBox } from '../grid-slice';
import { isTemplate, LAYOUT_TEMPLATES } from '../layout-templates';
import { detectColor, type RarityColor } from '../color-detect';
import { computeIconSignature, groupBySignature, isSameIcon, isGenericChestIcon, type IconSignature } from '../dedup';
import { findInLibrary } from '../lot-library';
import { isEventDraft } from './items';
import { extractInvasionLoot, readQuantities, type VisionLotItem } from '../vision';
import { detectInvasionFrames, cropBadge, withCosmeticMargin } from '../invasion-cv';

interface LotCandidate {
  screenshotId: number;
  imagePath: string;
  color: RarityColor;
  quantity: number;
}

export function registerScreenshotRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { id: string } }>(
    '/events/:id/screenshots',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      if (!isEventDraft(deps, eventId)) {
        reply.code(409).send({ error: 'event is not in draft' });
        return;
      }

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
      if (!isTemplate(template)) {
        reply.code(400).send({ error: 'template must be feast or invasion' });
        return;
      }
      // invasion's layout is read by a Claude vision call instead of a manual row count —
      // see vision.ts — so rows is only required (and only used) for feast.
      if (template === 'feast' && (!Number.isInteger(rows) || rows! < 1 || rows! > 50)) {
        reply.code(400).send({ error: 'rows must be a positive integer between 1 and 50' });
        return;
      }
      if (template === 'invasion' && !deps.anthropicApiKey) {
        reply.code(400).send({ error: 'ANTHROPIC_API_KEY is not configured for invasion screenshots' });
        return;
      }

      const uploadsDir = path.join(deps.dataDir, 'uploads');
      const originalsDir = path.join(uploadsDir, 'originals');
      const itemsDir = path.join(uploadsDir, 'items');
      await fs.mkdir(originalsDir, { recursive: true });
      // feast's sliceImageToCells creates itemsDir as a side effect, but invasion's path
      // below calls cropBox directly on it without going through that helper — needs its
      // own mkdir or the first cropBox write fails with ENOENT.
      await fs.mkdir(itemsDir, { recursive: true });

      const userId = request.telegramUser!.telegramId;
      const insertScreenshot = deps.db.prepare(
        'INSERT INTO screenshots (event_id, original_path, rows, template, uploaded_by) VALUES (?, ?, ?, ?, ?)'
      );
      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, image_path, color, category, name, quantity, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pool')"
      );

      // Only feast still uses the fixed pixel-grid layout; invasion's icons/quantities
      // come from extractInvasionLoot instead (see vision.ts) — variable row/icon count,
      // quantity read off each icon's own badge rather than inferred by counting rows.
      const feastLayout = template === 'feast' ? LAYOUT_TEMPLATES.feast! : undefined;
      const candidates: LotCandidate[] = [];

      for (let f = 0; f < fileBuffers.length; f++) {
        const uploadStamp = Date.now();
        const originalPath = path.join(originalsDir, `${eventId}-${uploadStamp}-${f}.png`);
        await fs.writeFile(originalPath, fileBuffers[f]);

        // rows is meaningless for invasion — 0 is a placeholder, never read back (the
        // column stays NOT NULL; not worth a migration for a value nothing uses).
        const screenshotId = insertScreenshot.run(eventId, originalPath, feastLayout ? rows : 0, template, userId)
          .lastInsertRowid as number;

        // The prefix folds in uploadStamp, not just screenshotId, on purpose: `id` is a
        // plain SQLite INTEGER PRIMARY KEY (no AUTOINCREMENT), which reuses low numbers
        // once the table is emptied out — exactly what happens in the admin's own
        // workflow of deleting the previous test event before every new one. Deleting an
        // event drops its DB rows but leaves the old icon files on disk (see the cleanup
        // ponytail note in DELETE /events/:id), so a reused id would reuse the exact same
        // file path — and a client that cached that URL from the earlier test (Telegram's
        // WebView does this) would keep showing the old picture after it's overwritten,
        // even though the server and DB both already have the right one. Bug found
        // 2026-08-28: fresh event, brand-new screenshots, but the admin grid showed items
        // from an unrelated, already-deleted test event.
        const baseName = `ss${screenshotId}-${uploadStamp}`;

        if (feastLayout) {
          const cellPaths = await sliceImageToCells(
            originalPath,
            rows!,
            1,
            itemsDir,
            baseName,
            feastLayout.contentTop,
            feastLayout.rowHeight
          );
          for (let i = 0; i < cellPaths.length; i++) {
            const cellPath = cellPaths[i];
            // The icon badge alone identifies the item, so it's what gets shown as the
            // lot's image (and compared below to spot duplicate rows); the full row strip
            // stays only as the source for color detection.
            const imagePath = feastLayout.iconBox
              ? await cropBox(cellPath, feastLayout.iconBox, path.join(itemsDir, `${baseName}-${i}-icon.png`))
              : cellPath;
            let color: RarityColor = 'blue';
            try {
              color = await detectColor(cellPath, 'feast');
            } catch (err) {
              request.log.warn({ err }, 'color detection failed, defaulting to blue');
            }
            candidates.push({ screenshotId, imagePath, color, quantity: 1 });
          }
        } else {
          let visionItems: VisionLotItem[];
          try {
            // Code-side detection first (deterministic panel/frame geometry, no model call) —
            // only the digit-reading call below touches Vision. null means the pipeline isn't
            // confident it found a panel or any frames at all, so the whole screenshot falls
            // back to the original full-image Vision path unchanged.
            const frames = await detectInvasionFrames(fileBuffers[f]);
            if (frames) {
              const badgeCrops = await Promise.all(frames.map((frame) => cropBadge(fileBuffers[f], frame)));
              const quantities = await readQuantities(badgeCrops, deps.anthropicApiKey!, deps.anthropicBaseUrl);
              // cropBadge above deliberately gets the raw, unpadded frame (its ratios are
              // calibrated against the tight bounding box); only the final icon crop the
              // admin sees gets the cosmetic margin.
              visionItems = frames.map((frame, i) => ({ ...withCosmeticMargin(frame), quantity: quantities[i] }));
            } else {
              visionItems = await extractInvasionLoot(fileBuffers[f], deps.anthropicApiKey!, deps.anthropicBaseUrl);
            }
          } catch (err) {
            request.log.error({ err }, 'invasion recognition failed');
            reply.code(502).send({ error: `Не удалось распознать скриншот: ${(err as Error).message}` });
            return;
          }
          for (let i = 0; i < visionItems.length; i++) {
            const item = visionItems[i];
            const imagePath = await cropBox(originalPath, item, path.join(itemsDir, `${baseName}-${i}-icon.png`));
            candidates.push({ screenshotId, imagePath, color: item.rarity, quantity: item.quantity });
          }
        }
      }

      // The same item often appears more than once (a common drop, or split across two
      // boss rows) — grouping identical-looking icons into one lot with a quantity,
      // instead of one lot per icon, is the whole point of this endpoint; see dedup.ts
      // for how "identical-looking" is decided.
      const withSignatures = await Promise.all(
        candidates.map(async (c) => ({ signature: await computeIconSignature(c.imagePath), value: c }))
      );
      const signatureByPath = new Map(withSignatures.map((s) => [s.value.imagePath, s.signature]));

      // The generic chest icon reuses the exact same art regardless of what's actually
      // inside it, so two chests that merely LOOK identical can be genuinely different
      // lots — grouping them together within one upload would silently hide one. Already
      // excluded from cross-upload matching below for the same reason; chests now skip
      // groupBySignature entirely and each becomes its own singleton group instead.
      const chestEntries = withSignatures.filter((s) => isGenericChestIcon(s.signature));
      const nonChestEntries = withSignatures.filter((s) => !isGenericChestIcon(s.signature));
      const groups: LotCandidate[][] = [
        ...groupBySignature<LotCandidate>(nonChestEntries as { signature: IconSignature; value: LotCandidate }[]),
        ...chestEntries.map((s) => [s.value]),
      ];

      // Дубли бьют не только внутри одной загрузки, но и между отдельными
      // выгрузками скриншотов (тот же лот попал на два разных скрина) — поэтому
      // здесь ещё раз сверяем иконку с тем, что уже лежит в пуле этого ивента,
      // и вместо нового лота просто добавляем количество к найденному.
      //
      // Обязательно только среди лотов ТОГО ЖЕ шаблона: один ивент может
      // содержать вперемешку лоты и пира, и вторжения (админ загружает оба на
      // тест), а их иконки — из совершенно разных наборов рамок/фонов, так что
      // сравнивать 16×16-отпечаток одного шаблона с другим — рулетка (порог 8
      // рассчитан на JPEG-артефакты одного и того же скриншота, а не на
      // совпадение между разными играми). Без фильтра по шаблону новый лот
      // вторжения мог случайно "слиться" со старым лотом пира — новый лот не
      // создавался, количество бампалось чужому, и в списке видна была старая
      // картинка/цвет вместо только что загруженной (баг, найден 2026-08-28).
      const existingPoolItems = deps.db
        .prepare(
          `SELECT i.id, i.image_path as imagePath, i.quantity
           FROM items i JOIN screenshots s ON s.id = i.screenshot_id
           WHERE i.event_id = ? AND i.status = 'pool' AND s.template = ?`
        )
        .all(eventId, template) as { id: number; imagePath: string; quantity: number }[];
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
        const quantity = group.reduce((sum, c) => sum + c.quantity, 0);

        // The generic chest icon is excluded from cross-upload matching (see
        // isGenericChestIcon) — it looks identical across genuinely different
        // chest lots, so treating repeats across separate uploads as "the same
        // chest" would silently swallow real lots. Within this one upload,
        // groupBySignature above still merged any true repeats normally.
        const existingMatch = isGenericChestIcon(signature)
          ? undefined
          : existingSignatures.find((es) => isSameIcon(es.signature, signature));
        if (existingMatch) {
          bumpQuantity.run(quantity, existingMatch.item.id);
          existingMatch.item.quantity += quantity;
          itemIds.push(existingMatch.item.id);
          continue;
        }

        const relPath = path.relative(uploadsDir, representative.imagePath).split(path.sep).join('/');

        // A generic chest icon can't be trusted to identify what's actually inside it
        // (see isGenericChestIcon above), so it's excluded from library lookup the same
        // way it's excluded from cross-upload dedup — otherwise every chest lot would
        // get stamped with whatever name/category the first one was ever tagged.
        const known = isGenericChestIcon(signature) ? undefined : findInLibrary(deps.db, signature);

        const itemId = insertItem
          .run(
            eventId,
            representative.screenshotId,
            relPath,
            representative.color,
            known?.category ?? 'item',
            known?.name ?? '',
            quantity
          )
          .lastInsertRowid as number;
        itemIds.push(itemId);
        existingSignatures.push({ item: { id: itemId, imagePath: relPath, quantity }, signature });
      }

      return { itemIds };
    }
  );
}
