import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { AppDeps } from '../types';
import { requireAdmin } from '../auth';
import { sliceImageToCells } from '../grid-slice';

export function registerScreenshotRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post<{ Params: { id: string } }>(
    '/events/:id/screenshots',
    { preHandler: requireAdmin(deps) },
    async (request, reply) => {
      const eventId = Number(request.params.id);
      const data = await request.file();
      if (!data) {
        reply.code(400).send({ error: 'file is required' });
        return;
      }

      const fields = data.fields as Record<string, { value?: string } | undefined>;
      const rows = Number(fields.rows?.value);
      const cols = Number(fields.cols?.value);
      if (!Number.isInteger(rows) || rows < 1 || !Number.isInteger(cols) || cols < 1) {
        reply.code(400).send({ error: 'rows and cols must be positive integers, sent before the file field' });
        return;
      }

      const uploadsDir = path.join(deps.dataDir, 'uploads');
      const originalsDir = path.join(uploadsDir, 'originals');
      await fs.mkdir(originalsDir, { recursive: true });
      const originalPath = path.join(originalsDir, `${eventId}-${Date.now()}.png`);
      await pipeline(data.file, createWriteStream(originalPath));

      const userId = request.telegramUser!.telegramId;
      const screenshotId = deps.db
        .prepare('INSERT INTO screenshots (event_id, original_path, rows, cols, uploaded_by) VALUES (?, ?, ?, ?, ?)')
        .run(eventId, originalPath, rows, cols, userId).lastInsertRowid as number;

      const itemsDir = path.join(uploadsDir, 'items');
      const cellPaths = await sliceImageToCells(originalPath, rows, cols, itemsDir, `ss${screenshotId}`);
      const relativePaths = cellPaths.map((p) => path.relative(uploadsDir, p).split(path.sep).join('/'));

      const insertItem = deps.db.prepare(
        "INSERT INTO items (event_id, screenshot_id, name, image_path, status) VALUES (?, ?, '', ?, 'pool')"
      );
      const itemIds = relativePaths.map(
        (relPath) => insertItem.run(eventId, screenshotId, relPath).lastInsertRowid as number
      );

      return { screenshotId, itemIds };
    }
  );
}
