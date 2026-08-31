const MODEL = 'claude-sonnet-5';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
// Generous headroom: Sonnet 5 runs adaptive thinking by default when `thinking` is
// omitted, and its tokenizer is denser than older models — a tight budget here risks
// truncating mid-array on a screenshot with many icons, an error no test (they all stub
// fetch) can catch. Paying for headroom that goes unused costs nothing extra; only
// tokens actually generated are billed.
const MAX_TOKENS = 8000;

export interface VisionLotItem {
  x: number;
  y: number;
  w: number;
  h: number;
  rarity: 'blue' | 'purple' | 'red';
  quantity: number;
}

// Fraction-of-image box tightly around the icon + its rarity frame + its own ×N
// quantity badge — matches grid-slice.ts's Box shape exactly, so the caller can crop
// it with the same cropBox() feast already uses for its iconBox. Boss name and
// place/rank are explicitly excluded — the admin only cares about the loot itself.
//
// Rewritten 2026-09-01 after a live test misidentified rank badges (the round 1/2/3
// shield icons) as reward icons, and once even grabbed a chat-overlay text fragment as
// if it were an icon — the original wording only said "ignore place/medal" without
// describing what a real reward icon actually looks like, so the model had nothing
// concrete to tell them apart by. Now spells out the exact visual shape and gives
// explicit negative examples instead of a bare "ignore X".
const PROMPT = `Это скриншот экрана "Трофеи" из мобильной игры — список побеждённых боссов, у каждого своя строка с наградами.

Как выглядит настоящая иконка награды (то, что нужно вернуть): небольшой квадрат/ромб/шестиугольник со скруглёнными углами и цветной рамкой редкости (синяя, фиолетовая или красная), внутри — картинка предмета; часто под иконкой ещё подписан уровень («40 ур.») и/или тег «Уник.»; в правом нижнем углу самой иконки может быть маленький бейджик с числом «×N» — это количество. Такие иконки идут подряд одной горизонтальной группой в конце строки босса.

Чего в списке НЕ должно быть, даже если оно похоже по цвету или форме:
- круглый/щитовидный значок места в бою (золотой/серебряный/бронзовый с цифрой 1, 2 или 3 внутри, либо текст «Место 4») — он стоит слева от имени босса и НЕ является наградой;
- само имя босса и подпись типа «Иллюзия» / «Истинный облик» рядом с ним;
- дата и время в углу строки;
- любой текст поверх скриншота, не относящийся к списку трофеев (например, всплывающие сообщения чата, ники игроков, подсказки вида «Нажмите...») — если видишь такое, полностью игнорируй этот участок картинки, туда никакую рамку не ставь.

Если сомневаешься, иконка это награды или что-то другое (место, чат, текст) — не включай это в ответ. Лучше пропустить сомнительный элемент, чем ошибочно вернуть значок места или кусок постороннего текста как награду.

Для КАЖДОЙ настоящей иконки награды на скриншоте (по всем строкам) верни:
- рамку (x, y, w, h — доли от размера всей картинки, 0..1), плотно обхватывающую саму иконку награды вместе с её рамкой редкости и числом-бейджиком в углу, без уровня/тега под ней и без соседних иконок;
- rarity — цвет рамки редкости иконки: "blue", "purple" или "red";
- quantity — число с маленького бейджика "×N" в углу иконки (если бейджика не видно, используй 1).`;

// baseUrl defaults to Anthropic's own endpoint, but can be pointed at a wire-compatible
// proxy (same x-api-key header, same /v1/messages request/response shape, just a
// different domain) — some resellers front Anthropic's API this way, which is simpler to
// pay through than a direct Anthropic account for some. No trailing slash expected.
export async function extractInvasionLoot(
  imageBuffer: Buffer,
  apiKey: string,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<VisionLotItem[]> {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      tools: [
        {
          name: 'extract_trophy_loot',
          description: 'Records every reward icon found on the trophies screenshot.',
          input_schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                    rarity: { type: 'string', enum: ['blue', 'purple', 'red'] },
                    quantity: { type: 'integer', minimum: 1 },
                  },
                  required: ['x', 'y', 'w', 'h', 'rarity', 'quantity'],
                },
              },
            },
            required: ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_trophy_loot' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBuffer.toString('base64') } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; input?: unknown }[]; stop_reason?: string };
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Anthropic API response was truncated (max_tokens) — the screenshot likely has too many icons for one call');
  }
  const toolUse = data.content?.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input?: { items?: unknown[] } }
    | undefined;
  if (!toolUse || !Array.isArray(toolUse.input?.items)) {
    throw new Error('Anthropic API response did not include the expected tool_use block');
  }

  return toolUse.input.items.map((raw, i) => validateItem(raw, i));
}

function validateItem(raw: unknown, index: number): VisionLotItem {
  const item = raw as Partial<VisionLotItem>;
  const isFraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
  if (!isFraction(item.x) || !isFraction(item.y) || !isFraction(item.w) || !isFraction(item.h)) {
    throw new Error(`item ${index}: x/y/w/h must be numbers between 0 and 1`);
  }
  // A box right at the image edge (e.g. x=1) can produce a crop region that extends past
  // the source image — cropBox doesn't fully guard against this and would throw a raw
  // sharp error instead of a clean, catchable validation message.
  if (item.x + item.w > 1 || item.y + item.h > 1) {
    throw new Error(`item ${index}: box extends past the image edge (x+w or y+h > 1)`);
  }
  if (item.rarity !== 'blue' && item.rarity !== 'purple' && item.rarity !== 'red') {
    throw new Error(`item ${index}: rarity must be blue, purple, or red`);
  }
  if (!isPositiveInt(item.quantity)) {
    throw new Error(`item ${index}: quantity must be a positive integer`);
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h, rarity: item.rarity, quantity: item.quantity };
}
