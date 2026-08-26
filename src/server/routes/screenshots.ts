import type { FastifyInstance, FastifyBaseLogger } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells } from '../grid-slice';
import { isTemplate, LAYOUT_TEMPLATES, type Template } from '../layout-templates';
import { detectColor } from '../color-detect';
import { recognizeStrip } from '../ocr';

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
        "INSERT INTO items (event_id, screenshot_id, image_path, status) VALUES (?, ?, ?, 'pool')"
      );

      const itemIds: number[] = [];
      const pendingExtraction: { itemId: number; stripPath: string }[] = [];

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
        for (const cellPath of cellPaths) {
          const relPath = path.relative(uploadsDir, cellPath).split(path.sep).join('/');
          const itemId = insertItem.run(eventId, screenshotId, relPath).lastInsertRowid as number;
          itemIds.push(itemId);
          pendingExtraction.push({ itemId, stripPath: cellPath });
        }
      }

      // ponytail: color/OCR extraction runs after the response is sent (not awaited) —
      // it can take tens of seconds across many rows, long enough to trip a mobile
      // connection or tunnel timeout if the client had to wait on it. Items start with
      // the schema's blank/blue defaults and get updated in place as extraction
      // completes; the admin's review list picks it up on its next refresh. If the
      // server restarts mid-batch, whatever hasn't finished stays blank — admin fills
      // it in by hand, same as any other extraction miss.
      extractInBackground(deps, request.log, pendingExtraction, template).catch((err) => {
        request.log.error({ err }, 'background color/OCR extraction crashed');
      });

      return { itemIds };
    }
  );
}

async function extractInBackground(
  deps: AppDeps,
  log: FastifyBaseLogger,
  items: { itemId: number; stripPath: string }[],
  template: Template
) {
  const updateItem = deps.db.prepare('UPDATE items SET name = ?, price = ?, color = ? WHERE id = ?');
  for (const { itemId, stripPath } of items) {
    let color: 'blue' | 'purple' | 'red' = 'blue';
    try {
      color = await detectColor(stripPath, template);
    } catch (err) {
      log.warn({ err }, 'color detection failed, defaulting to blue');
    }

    let name = '';
    let price = '';
    try {
      const extracted = await recognizeStrip(stripPath, template, path.join(deps.dataDir, 'ocr-cache'));
      name = extracted.name;
      price = extracted.price;
    } catch (err) {
      log.warn({ err }, 'OCR failed, leaving name/price blank');
    }

    updateItem.run(name, price, color, itemId);
  }
}
