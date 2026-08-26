import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

async function waitFor(check: () => boolean, timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('POST /api/events/:id/screenshots', () => {
  const botToken = 'test-token';
  let dataDir: string;
  let db: Db;
  let app: FastifyInstance;
  let baseUrl: string;
  let adminInitData: string;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'screenshots-test-'));
    db = openDb(':memory:');
    app = buildServer({ db, botToken, adminTelegramIds: [1], dataDir });
    await app.listen({ port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    adminInitData = signUserInitData(1, 'admin', botToken);
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it(
    'responds immediately with blank/default items, then fills in color/name/price in the background',
    async () => {
      const createEventRes = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
        body: JSON.stringify({ title: 'Ивент', durationMinutes: 25 }),
      });
      const { id: eventId } = await createEventRes.json();

      // Solid red, not the schema default 'blue' — lets the test tell "not processed
      // yet" (still blue) apart from "background extraction ran" (turned red) without
      // racing on timing.
      const imageBuffer = await sharp({
        create: { width: 300, height: 120, channels: 3, background: { r: 209, g: 67, b: 78 } },
      })
        .png()
        .toBuffer();

      const form = new FormData();
      form.append('rows', '2');
      form.append('template', 'feast');
      form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

      const start = Date.now();
      const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
      const elapsed = Date.now() - start;

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.itemIds).toHaveLength(2);
      // The response must not block on OCR (which alone takes seconds) — this is the
      // fix for the reported timeout: slicing is fast, extraction happens after.
      expect(elapsed).toBeLessThan(5000);

      const rightAfter = db.prepare('SELECT color, name, price FROM items WHERE id = ?').get(body.itemIds[0]) as any;
      expect(rightAfter.color).toBe('blue'); // schema default, not yet overwritten
      expect(rightAfter.name).toBe('');

      // Wait for every sliced item, not just the first — the background loop is
      // sequential, and a stray "still open" file would race the test's own cleanup.
      await waitFor(() =>
        body.itemIds.every((id: number) => (db.prepare('SELECT color FROM items WHERE id = ?').get(id) as any).color === 'red')
      );

      const row = db.prepare('SELECT image_path, color, name, price FROM items WHERE id = ?').get(body.itemIds[0]) as any;
      expect(row.image_path.startsWith('items/')).toBe(true);
      expect(row.color).toBe('red');
      expect(typeof row.name).toBe('string');
      expect(typeof row.price).toBe('string');
    },
    90000
  );

  it(
    'accepts multiple files in one request and slices every one of them',
    async () => {
      const createEventRes = await fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
        body: JSON.stringify({ title: 'Ивент 2', durationMinutes: 25 }),
      });
      const { id: eventId } = await createEventRes.json();

      // Black is closer to reference-red than reference-blue/purple by Euclidean
      // distance — used the same way as the first test, to detect "background
      // extraction ran" without racing on timing.
      const imageA = await sharp({ create: { width: 300, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .png()
        .toBuffer();
      const imageB = await sharp({ create: { width: 300, height: 90, channels: 3, background: { r: 0, g: 0, b: 0 } } })
        .png()
        .toBuffer();

      const form = new FormData();
      form.append('rows', '1');
      form.append('template', 'feast');
      form.append('file', new Blob([imageA], { type: 'image/png' }), 'a.png');
      form.append('file', new Blob([imageB], { type: 'image/png' }), 'b.png');

      const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.itemIds).toHaveLength(2); // 1 row from each of the 2 files

      const screenshotCount = db.prepare('SELECT COUNT(*) as c FROM screenshots WHERE event_id = ?').get(eventId) as {
        c: number;
      };
      expect(screenshotCount.c).toBe(2);

      // Wait out the background extraction before the test ends, so afterEach's
      // directory cleanup doesn't race files still being read for OCR/color-detect.
      await waitFor(() =>
        body.itemIds.every((id: number) => (db.prepare('SELECT color FROM items WHERE id = ?').get(id) as any).color === 'red')
      );
    },
    90000
  );

  it('rejects an unknown template', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент 3', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '1');
    form.append('template', 'bogus');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(400);
  });
});
