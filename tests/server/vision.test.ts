import { describe, it, expect, afterEach, vi } from 'vitest';
import { extractInvasionLoot } from '../../src/server/vision';

describe('extractInvasionLoot', () => {
  const fakeImage = Buffer.from('fake-image-bytes');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }) {
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('throws without calling fetch when apiKey is empty', async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({}) });
    await expect(extractInvasionLoot(fakeImage, '')).rejects.toThrow('ANTHROPIC_API_KEY is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the image as base64 with a forced tool_choice, and parses a valid tool_use response', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'extract_trophy_loot',
            input: {
              items: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.1, rarity: 'purple', quantity: 2 }],
            },
          },
        ],
      }),
    });

    const result = await extractInvasionLoot(fakeImage, 'test-key');
    // Expanded by the asymmetric margin applied post-validation (see SIDE_MARGIN_RATIO /
    // TOP_MARGIN_RATIO / Y_DRIFT_MARGIN_RATIO / MARGIN_RATIO in vision.ts, round 13):
    // marginX = 0.1*0.03 = 0.003, marginTop = 0.1*0.3 + 0.2*0.2 = 0.07 (adds a term for the
    // item's own y = 0.2, on top of round 12's per-icon-height term), marginBottom =
    // 0.1*0.08 = 0.008. x shrinks by marginX, y shrinks by marginTop, w grows by 2*marginX,
    // h grows by marginTop+marginBottom. toBeCloseTo for the floating-point fields — plain
    // toEqual is exact-equality and flaky against binary floating-point rounding.
    expect(result).toHaveLength(1);
    expect(result[0].x).toBeCloseTo(0.097);
    expect(result[0].y).toBeCloseTo(0.13);
    expect(result[0].w).toBeCloseTo(0.106);
    expect(result[0].h).toBeCloseTo(0.178);
    expect(result[0].rarity).toBe('purple');
    expect(result[0].quantity).toBe(2);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('test-key');
    expect(options.headers['anthropic-version']).toBeTruthy();

    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'extract_trophy_loot' });
    // Forced tool_choice + default (adaptive) thinking is rejected outright by the API
    // ("forced tool_choice is incompatible with thinking") — must be explicitly disabled.
    expect(body.thinking).toEqual({ type: 'disabled' });
    const imageBlock = body.messages[0].content.find((b: any) => b.type === 'image');
    expect(imageBlock.source.media_type).toBe('image/jpeg');
    expect(imageBlock.source.data).toBe(fakeImage.toString('base64'));
    const textBlock = body.messages[0].content.find((b: any) => b.type === 'text');
    expect(textBlock.text.toLowerCase()).toContain('трофеи');
    expect(textBlock.text.toLowerCase()).toMatch(/игнорир/); // instructed to ignore boss name/rank
  });

  it('clamps a too-tall box down to the max height-to-width ratio (bleeding into the next row)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        // h = 0.3 against w = 0.1 is a 3x ratio — symptomatic of the box reaching past
        // the icon into the next panel row, which a live test showed really happens.
        content: [{ type: 'tool_use', input: { items: [{ x: 0.2, y: 0.2, w: 0.1, h: 0.3, rarity: 'blue', quantity: 1 }] } }],
      }),
    });

    const [result] = await extractInvasionLoot(fakeImage, 'test-key');
    // Clamped h (before margin) is w * 1.2 = 0.12 (round 10: tightened from 1.4), then the
    // usual top/bottom margins are added on top of that clamped value, not the original 0.3.
    // Round 13 adds a y-proportional term to the top margin, so the total top margin here
    // is bigger than a pure per-icon-height ratio would give — h ends up close to (but
    // still below) the original unclamped h of 0.3, so compare against that instead of a
    // now-stale absolute threshold.
    expect(result.h).toBeLessThan(0.3);
    expect(result.y).toBeCloseTo(0.2 - (0.12 * 0.3 + 0.2 * 0.2)); // top edge, height + y-drift margin
  });

  it('clamps the margin expansion so a box near the image edge never exceeds 0..1', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.01, y: 0.01, w: 0.1, h: 0.1, rarity: 'red', quantity: 1 }] } }],
      }),
    });

    const [result] = await extractInvasionLoot(fakeImage, 'test-key');
    // Unpadded margin would push x/y slightly negative here without the clamp — confirms
    // it never goes negative even this close to the edge.
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.w).toBeLessThanOrEqual(1);
    expect(result.y + result.h).toBeLessThanOrEqual(1);
  });

  it('calls a custom baseUrl instead of api.anthropic.com when one is passed', async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1 }] } }],
      }),
    });

    await extractInvasionLoot(fakeImage, 'test-key', 'https://router.example');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://router.example/v1/messages');
  });

  it('throws with the status code when the API responds non-2xx', async () => {
    mockFetchOnce({ ok: false, status: 500, text: async () => 'server error' });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow(/500/);
  });

  it('throws when the response has no tool_use block', async () => {
    mockFetchOnce({ ok: true, json: async () => ({ content: [{ type: 'text', text: 'oops' }] }) });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('tool_use');
  });

  it('throws when an item fails validation (bad rarity)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'green', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('rarity');
  });

  it('throws when an item has a non-integer quantity', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1.5 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('quantity');
  });

  it('throws when a box coordinate is out of the 0..1 range', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 1.5, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('x/y/w/h');
  });

  it('throws when the response was truncated (stop_reason max_tokens)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', input: { items: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1, rarity: 'blue', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('truncated');
  });

  it('throws when a box extends past the image edge (x+w > 1)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', input: { items: [{ x: 0.8, y: 0.1, w: 0.5, h: 0.1, rarity: 'blue', quantity: 1 }] } }],
      }),
    });
    await expect(extractInvasionLoot(fakeImage, 'test-key')).rejects.toThrow('edge');
  });
});
