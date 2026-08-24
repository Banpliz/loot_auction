import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDb, type Db } from '../../../src/server/db';
import { buildServer } from '../../../src/server/server';
import { signUserInitData } from '../../test-helpers';
import type { FastifyInstance } from 'fastify';

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

  it('slices an uploaded screenshot into rows*cols pool items', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '2');
    form.append('cols', '5');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(10);

    const row = db.prepare('SELECT image_path FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.image_path.startsWith('items/')).toBe(true);
  });
});
