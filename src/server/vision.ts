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
// Rewritten 2026-09-01 (round 4) — the user hand-annotated real screenshots with the
// exact expected icons (circled), settling two things rounds 1-3 got wrong or
// overcorrected: (1) valid reward icons come in TWO shapes — diamond/hex combat-item
// icons (level pill + Уник. tag naturally attached below) AND plain treasure-chest icons
// (just a corner number, no level/tag) — round 3 only described the diamond kind; (2)
// round 3's "exclude the level pill/tag from the box" instruction was itself part of the
// problem — the user confirmed a label directly under its own icon is fine to include,
// what actually must never happen is a box containing ONLY a label/tag with no product
// picture in it (that's what was showing up as phantom extra "lots"). Dropping the
// exclusion requirement in favor of the simpler, confirmed-correct "must contain a
// picture" rule.
//
// Round 5: round 4 fixed WHICH icons get returned, but a live test then showed boxes
// with correct x/top-edge landing right on the icon, then stretching way too far down —
// past the icon and its label, through the panel's inter-row gap, into the next boss
// row's text. Content selection was right; only the box height (h) was wrong. Added an
// explicit height ceiling (icon ≈ square, icon+label ≈ up to 1.3x taller than wide) and
// "prefer a slightly short box over one that bleeds into the next row."
//
// Round 7 (reverting round 6): round 6 asked the model to add its own margin around the
// box, which made box *positioning* worse (boxes started drifting/shifting instead of
// just growing evenly) — the model isn't reliable at both locating AND padding a box in
// one step. Reverted the prompt to round 5's tight/snug framing and moved the margin to
// a deterministic post-processing step in validateItem() instead — expanding a box the
// model already got right is trivial arithmetic, not something worth asking an LLM to do.
const PROMPT = `Это скриншот экрана "Трофеи" из мобильной игры. На экране один светлый (кремовый/бежевый) прямоугольный ПАНЕЛЬ-блок со списком побеждённых боссов, каждый — отдельная строка внутри этой панели. Всё, что находится ВНЕ этой светлой панели (тёмный фон игры сверху/снизу/по краям экрана, чат альянса, любые всплывающие сообщения, подсказка «Нажмите на пустую область, чтобы закрыть», нижняя строка футера «Участники битвы альянсов могут торговаться за трофеи») — полностью игнорируй, туда рамки не ставь.

Внутри панели, в каждой строке слева направо идёт:
1. Круглый или щитовидный значок места (золотой/серебряный/бронзовый с цифрой 1/2/3, либо просто текст «Место 4») — это НЕ награда, никогда не включай его в ответ.
2. Название босса текстом (например «Элементаль огня», «Ледяной медведь») и рядом подпись вроде «Иллюзия» / «Истинный облик» — тоже текст, не награда.
3. Правее, в конце строки — сама группа иконок наград: несколько небольших иконок подряд, у каждой контрастная цветная РАМКА-ромб/шестиугольник (синяя, фиолетовая или красная). Бывает двух видов: (а) иконка боевого предмета — картинка предмета, под ней часто подписан уровень («40 ур.») и/или зелёный тег «Уник.»; (б) иконка сундука — картинка сундука/шкатулки, без подписи уровня, просто с числом в углу. Оба вида — настоящие награды, и нужно вернуть каждую иконку из этой группы (и вида (а), и вида (б)) — по одной рамке на каждую отдельную иконку.

Единственное жёсткое правило про рамку: внутри неё обязательно должна быть САМА КАРТИНКА предмета или сундука. Если под иконкой (а) есть подпись уровня/тег «Уник.» — можно включить её в ту же рамку, что и картинку над ней (это нормально), но НИКОГДА не возвращай отдельную рамку, в которой есть ТОЛЬКО подпись уровня, ТОЛЬКО тег «Уник.», ИЛИ только текст/буквы без картинки предмета внутри — такая рамка не считается наградой.

Каждая отдельная иконка — это свой отдельный элемент в ответе. Не объединяй несколько иконок одной строки в одну общую рамку, и не дроби одну иконку на несколько рамок.

Ключевое отличие значка места (пункт 1) от иконки награды (пункт 3): значок места круглый/щитовидный и стоит САМЫМ ПЕРВЫМ слева в строке, рядом с именем босса; иконка награды ромбовидная/шестиугольная (или сундук) и стоит в конце строки, после текста. Если элемент круглый и рядом с именем босса — это место, не награда, никогда его не возвращай, даже если у него тоже есть цветная обводка.

Если по какому-то элементу не уверен, реальная это иконка награды или нет — пропусти его. Лучше вернуть меньше элементов, чем включить значок места или кусок постороннего текста/чата.

ВАЖНО про высоту рамки (h): рамка должна плотно облегать иконку и заканчиваться сразу под её подписью уровня/тегом «Уник.», если она есть (у сундука — сразу под самим сундуком). Она НЕ должна тянуться вниз дальше этого — между строками разных боссов в панели есть пустой отступ, и рамка не должна залезать в этот отступ и тем более в текст/значок места СЛЕДУЮЩЕЙ строки босса. По высоте иконка (а) вместе с подписью под ней — это примерно квадрат или чуть выше квадрата (высота не больше чем в 1.3 раза больше ширины), иконка сундука (б) без подписи — примерно квадрат (высота ≈ ширина). Если сомневаешься насчёт высоты — лучше сделать рамку чуть меньше (даже если чуть обрежет край иконки), чем оставить лишнее пустое место или соседний элемент внизу.

Для КАЖДОЙ настоящей иконки награды (пункт 3 выше, по всем строкам панели) верни:
- рамку (x, y, w, h — доли от размера всей картинки, 0..1), плотно обхватывающую иконку (картинку предмета/сундука, её цветную рамку редкости, число-бейджик «×N» в углу, и — для иконок вида (а) — подпись уровня/тег под ней, если есть) и не более того;
- rarity — цвет рамки редкости иконки: "blue", "purple" или "red";
- quantity — число с маленького бейджика "×N" в углу иконки (если бейджика не видно, используй 1).`;

// Applied to the model's (already-validated) box after it returns — expanding a
// correctly-located box outward by a fixed ratio is trivial, deterministic arithmetic,
// unlike asking the model to locate AND pad the box in one step (round 6 tried that and
// it made box *positioning* worse, not just the margin). Clamped to stay within the
// source image — never expands past x/y = 0 or x+w/y+h = 1.
const MARGIN_RATIO = 0.08;

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
      // Forced tool_choice (below) is incompatible with thinking on this model — Sonnet 5
      // runs adaptive thinking by default when `thinking` is omitted, which the API
      // rejects outright when combined with a forced tool: "forced tool_choice is
      // incompatible with thinking ... use auto/none or disable thinking" (confirmed via
      // a live 400 from a real deployment). Structured box/rarity/quantity extraction
      // doesn't need deep reasoning anyway.
      thinking: { type: 'disabled' },
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

  const marginX = item.w * MARGIN_RATIO;
  const marginY = item.h * MARGIN_RATIO;
  const x = Math.max(0, item.x - marginX);
  const y = Math.max(0, item.y - marginY);
  const w = Math.min(1 - x, item.w + 2 * marginX);
  const h = Math.min(1 - y, item.h + 2 * marginY);

  return { x, y, w, h, rarity: item.rarity, quantity: item.quantity };
}
