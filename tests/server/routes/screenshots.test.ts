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

  it('slices the screenshot and detects color synchronously, in the response itself', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({
      create: { width: 300, height: 120, channels: 3, background: { r: 209, g: 67, b: 78 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '1');
    form.append('template', 'feast');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(1);

    const row = db.prepare('SELECT image_path, color, name, quantity FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.image_path.startsWith('items/')).toBe(true);
    expect(row.color).toBe('red'); // matches the solid-red fixture, no polling needed
    expect(row.name).toBe(''); // no lot-library entry for this icon yet, so nothing to prefill
    expect(row.quantity).toBe(1);
  });

  it('prefills name/category from the lot library on a later upload of the same-looking icon', async () => {
    const solidGreen = await sharp({
      create: { width: 300, height: 120, channels: 3, background: { r: 40, g: 180, b: 60 } },
    })
      .png()
      .toBuffer();

    async function uploadOneRow(eventId: number) {
      const form = new FormData();
      form.append('rows', '1');
      form.append('template', 'feast');
      form.append('file', new Blob([solidGreen], { type: 'image/png' }), 'lot.png');
      const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
      const body = await res.json();
      return body.itemIds[0] as number;
    }

    const eventA = (
      await (
        await fetch(`${baseUrl}/api/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
          body: JSON.stringify({ title: 'Ивент A', durationMinutes: 25 }),
        })
      ).json()
    ).id;
    const firstItemId = await uploadOneRow(eventA);

    // Admin tags the lot once — this is the write side of the library.
    const putRes = await fetch(`${baseUrl}/api/items/${firstItemId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ name: 'Камень душ', category: 'stone' }),
    });
    expect(putRes.status).toBe(200);

    // A different event, same-looking icon — should come back pre-tagged without the
    // admin touching it, instead of landing as a blank 'item' again.
    const eventB = (
      await (
        await fetch(`${baseUrl}/api/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
          body: JSON.stringify({ title: 'Ивент B', durationMinutes: 25 }),
        })
      ).json()
    ).id;
    const secondItemId = await uploadOneRow(eventB);

    const row = db.prepare('SELECT name, category FROM items WHERE id = ?').get(secondItemId) as any;
    expect(row.name).toBe('Камень душ');
    expect(row.category).toBe('stone');
  });

  it('never reuses an icon file path even when SQLite recycles the screenshot id (delete-then-recreate workflow)', async () => {
    // The admin's actual workflow: delete the previous test event, then create a new
    // one, before every test. That empties the `screenshots` table, and its `id` is a
    // plain INTEGER PRIMARY KEY (no AUTOINCREMENT) — SQLite hands out id=1 again for
    // the very next insert instead of continuing to count up. Icon files are named
    // from that id, so a naive scheme would reuse the exact same file path as the
    // deleted event's screenshot — and since DELETE never removes old files from disk,
    // a client caching that URL would keep serving the stale image after it's
    // overwritten. Bug found 2026-08-28.
    const solidBlue = await sharp({ create: { width: 300, height: 120, channels: 3, background: { r: 74, g: 144, b: 217 } } })
      .png()
      .toBuffer();

    async function createEventAndUpload() {
      const { id: eventId } = await (
        await fetch(`${baseUrl}/api/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
          body: JSON.stringify({ title: 'Тест', durationMinutes: 25 }),
        })
      ).json();

      const form = new FormData();
      form.append('rows', '1');
      form.append('template', 'feast');
      form.append('file', new Blob([solidBlue], { type: 'image/png' }), 'lot.png');
      const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
      const itemId = (await res.json()).itemIds[0] as number;
      return { eventId, itemId };
    }

    const first = await createEventAndUpload();
    const firstImagePath = (db.prepare('SELECT image_path FROM items WHERE id = ?').get(first.itemId) as any).image_path;
    const firstScreenshotId = (
      db.prepare('SELECT screenshot_id FROM items WHERE id = ?').get(first.itemId) as any
    ).screenshot_id;

    await fetch(`${baseUrl}/api/events/${first.eventId}`, { method: 'DELETE', headers: { 'x-telegram-init-data': adminInitData } });
    // Confirms the premise: the table really is empty, so the next insert can recycle id 1.
    expect(db.prepare('SELECT COUNT(*) as count FROM screenshots').get()).toEqual({ count: 0 });

    const second = await createEventAndUpload();
    const secondImagePath = (db.prepare('SELECT image_path FROM items WHERE id = ?').get(second.itemId) as any).image_path;
    const secondScreenshotId = (
      db.prepare('SELECT screenshot_id FROM items WHERE id = ?').get(second.itemId) as any
    ).screenshot_id;

    expect(secondScreenshotId).toBe(firstScreenshotId); // the premise: SQLite did recycle the id
    expect(secondImagePath).not.toBe(firstImagePath); // but the file path must still be unique
  });

  it('never merges lots across templates, even when their icons happen to look identical', async () => {
    // Same event, same-looking icon, but uploaded once as feast and once as
    // invasion — these must stay two separate lots. The admin does upload both
    // templates into one event to test them side by side (bug found 2026-08-28:
    // cross-upload dedup ignored template, so a new lot from one template could
    // silently get folded into an unrelated lot from the other, showing the
    // wrong picture/color and never creating the lot that was actually uploaded).
    const solidPurple = await sharp({
      create: { width: 300, height: 120, channels: 3, background: { r: 156, g: 74, b: 201 } },
    })
      .png()
      .toBuffer();

    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент mixed', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    async function upload(templateName: string) {
      const form = new FormData();
      form.append('rows', '1');
      form.append('template', templateName);
      form.append('file', new Blob([solidPurple], { type: 'image/png' }), 'lot.png');
      const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
      return (await res.json()).itemIds[0] as number;
    }

    const feastItemId = await upload('feast');
    const invasionItemId = await upload('invasion');

    expect(feastItemId).not.toBe(invasionItemId);
    const rows = db
      .prepare("SELECT id, quantity FROM items WHERE event_id = ? AND status = 'pool'")
      .all(eventId) as { id: number; quantity: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.quantity === 1)).toBe(true);
  });

  it('merges duplicate rows within one screenshot into a single lot with a quantity', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент dup', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    // Both rows solid red — same item repeated, as a common drop would look.
    const imageBuffer = await sharp({
      create: { width: 300, height: 120, channels: 3, background: { r: 209, g: 67, b: 78 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '2');
    form.append('template', 'feast');
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.itemIds).toHaveLength(1); // 2 identical-looking rows -> 1 lot

    const row = db.prepare('SELECT quantity, color FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.quantity).toBe(2);
    expect(row.color).toBe('red');
  });

  it('accepts multiple files in one request, slicing and deduping across all of them', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент 2', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    // Different colors so each file's row stays a distinct lot (dedup shouldn't merge
    // genuinely different items just because they arrived in the same request).
    const imageA = await sharp({ create: { width: 300, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();
    const imageB = await sharp({ create: { width: 300, height: 90, channels: 3, background: { r: 255, g: 255, b: 0 } } })
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
    expect(body.itemIds).toHaveLength(2); // 1 row from each of the 2 files, visually distinct

    const screenshotCount = db.prepare('SELECT COUNT(*) as c FROM screenshots WHERE event_id = ?').get(eventId) as {
      c: number;
    };
    expect(screenshotCount.c).toBe(2);
  });

  it('merges a duplicate row across two different files in the same upload', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент cross-file dup', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    // Same solid color in both files — the admin selected two screenshots that both
    // happen to show the same common drop.
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
    expect(body.itemIds).toHaveLength(1);

    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.quantity).toBe(2);
  });

  it('merges a duplicate row uploaded in a separate later request into the existing pool lot', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент cross-upload dup', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({ create: { width: 300, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const uploadOnce = () => {
      const form = new FormData();
      form.append('rows', '1');
      form.append('template', 'feast');
      form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');
      return fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
    };

    const firstRes = await uploadOnce();
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json();
    expect(firstBody.itemIds).toHaveLength(1);

    const secondRes = await uploadOnce();
    expect(secondRes.status).toBe(200);
    const secondBody = await secondRes.json();
    expect(secondBody.itemIds).toEqual(firstBody.itemIds); // same lot, not a new one

    const itemCount = db.prepare("SELECT COUNT(*) as c FROM items WHERE event_id = ? AND status = 'pool'").get(eventId) as {
      c: number;
    };
    expect(itemCount.c).toBe(1);

    const row = db.prepare('SELECT quantity FROM items WHERE id = ?').get(firstBody.itemIds[0]) as any;
    expect(row.quantity).toBe(2);
  });

  it('does not merge into a lot that has already been auctioned', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент no-merge-after-resolve', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({ create: { width: 300, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const uploadOnce = () => {
      const form = new FormData();
      form.append('rows', '1');
      form.append('template', 'feast');
      form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');
      return fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
        method: 'POST',
        headers: { 'x-telegram-init-data': adminInitData },
        body: form,
      });
    };

    const firstRes = await uploadOnce();
    const firstBody = await firstRes.json();
    db.prepare("UPDATE items SET status = 'auctioned' WHERE id = ?").run(firstBody.itemIds[0]);

    const secondRes = await uploadOnce();
    const secondBody = await secondRes.json();
    expect(secondBody.itemIds).not.toEqual(firstBody.itemIds); // new lot, old one is already resolved

    const poolCount = db.prepare("SELECT COUNT(*) as c FROM items WHERE event_id = ? AND status = 'pool'").get(eventId) as {
      c: number;
    };
    expect(poolCount.c).toBe(1);
  });

  it('crops the item image down to just the icon badge for templates with a measured iconBox', async () => {
    const createEventRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-init-data': adminInitData },
      body: JSON.stringify({ title: 'Ивент 4', durationMinutes: 25 }),
    });
    const { id: eventId } = await createEventRes.json();

    const imageBuffer = await sharp({ create: { width: 720, height: 1565, channels: 3, background: { r: 0, g: 0, b: 0 } } })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append('rows', '1');
    form.append('template', 'invasion'); // has an iconBox; 'feast' above doesn't
    form.append('file', new Blob([imageBuffer], { type: 'image/png' }), 'reward.png');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/screenshots`, {
      method: 'POST',
      headers: { 'x-telegram-init-data': adminInitData },
      body: form,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const row = db.prepare('SELECT image_path, color FROM items WHERE id = ?').get(body.itemIds[0]) as any;
    expect(row.image_path).toMatch(/-icon\.png$/);
    expect(row.color).toBe('red'); // black fixture is closer to red than blue/purple
  });

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
