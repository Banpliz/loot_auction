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
    expect(result).toEqual([{ x: 0.1, y: 0.2, w: 0.1, h: 0.1, rarity: 'purple', quantity: 2 }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers['x-api-key']).toBe('test-key');
    expect(options.headers['anthropic-version']).toBeTruthy();

    const body = JSON.parse(options.body);
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'extract_trophy_loot' });
    const imageBlock = body.messages[0].content.find((b: any) => b.type === 'image');
    expect(imageBlock.source.media_type).toBe('image/jpeg');
    expect(imageBlock.source.data).toBe(fakeImage.toString('base64'));
    const textBlock = body.messages[0].content.find((b: any) => b.type === 'text');
    expect(textBlock.text.toLowerCase()).toContain('трофеи');
    expect(textBlock.text.toLowerCase()).toMatch(/игнорир/); // instructed to ignore boss name/rank
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
