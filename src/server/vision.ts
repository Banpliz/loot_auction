import sharp from 'sharp';

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
//
// Round 18: a live test returned phantom boxes over the bottom TAB BAR ("Трофеи / Данные
// альянса / Данные боя") — solid-color or tab-label crops with no icon in them at all. Named
// it explicitly in the ignore-list, alongside the footer text and chat.
//
// Round 20 (reverting round 18): the very next live test came back almost entirely broken —
// nearly every box across a whole batch landed on boss-name text, footer text, or tab-bar
// fragments instead of icons, far worse than the single narrow miss round 18 targeted. The
// prompt was already long and detailed; one more clause is the only content-affecting change
// between a mostly-working batch and this near-total collapse, so it's the prime suspect —
// reverted rather than risk compounding a guess on top of a guess. The tab-bar miss goes back
// to being an occasional annoyance instead of a hypothesis that costs the whole prompt.
const PROMPT = `Это скриншот экрана "Трофеи" из мобильной игры. На экране один светлый (кремовый/бежевый) прямоугольный ПАНЕЛЬ-блок со списком побеждённых боссов, каждый — отдельная строка внутри этой панели. Всё, что находится ВНЕ этой светлой панели (тёмный фон игры сверху/снизу/по краям экрана, чат альянса, любые всплывающие сообщения, подсказка «Нажмите на пустую область, чтобы закрыть», нижняя строка футера «Участники битвы альянсов могут торговаться за трофеи») — полностью игнорируй, туда рамки не ставь.

Внутри панели, в каждой строке слева направо идёт:
1. Круглый или щитовидный значок места (золотой/серебряный/бронзовый с цифрой 1/2/3, либо просто текст «Место 4») — это НЕ награда, никогда не включай его в ответ.
2. Название босса текстом (например «Элементаль огня», «Ледяной медведь») и рядом подпись вроде «Иллюзия» / «Истинный облик» — тоже текст, не награда.
3. Правее, в конце строки — сама группа иконок наград: несколько небольших иконок подряд, у каждой контрастная цветная РАМКА-ромб/шестиугольник (синяя, фиолетовая или красная). Бывает двух видов: (а) иконка боевого предмета — картинка предмета, под ней часто подписан уровень («40 ур.») и/или зелёный тег «Уник.»; (б) иконка сундука — картинка сундука/шкатулки, без подписи уровня, просто с числом в углу. Оба вида — настоящие награды, и нужно вернуть каждую иконку из этой группы (и вида (а), и вида (б)) — по одной рамке на каждую отдельную иконку.

Единственное жёсткое правило про рамку: внутри неё обязательно должна быть САМА КАРТИНКА предмета или сундука. Если под иконкой (а) есть подпись уровня/тег «Уник.» — можно включить её в ту же рамку, что и картинку над ней (это нормально), но НИКОГДА не возвращай отдельную рамку, в которой есть ТОЛЬКО подпись уровня, ТОЛЬКО тег «Уник.», ИЛИ только текст/буквы без картинки предмета внутри — такая рамка не считается наградой.

Каждая отдельная иконка — это свой отдельный элемент в ответе. Не объединяй несколько иконок одной строки в одну общую рамку, и не дроби одну иконку на несколько рамок.

Ключевое отличие значка места (пункт 1) от иконки награды (пункт 3): значок места круглый/щитовидный и стоит САМЫМ ПЕРВЫМ слева в строке, рядом с именем босса; иконка награды ромбовидная/шестиугольная (или сундук) и стоит в конце строки, после текста. Если элемент круглый и рядом с именем босса — это место, не награда, никогда его не возвращай, даже если у него тоже есть цветная обводка.

Если по какому-то элементу не уверен, реальная это иконка награды или нет — пропусти его. Лучше вернуть меньше элементов, чем включить значок места или кусок постороннего текста/чата.

ВАЖНО про верхний край рамки (y): рамка должна начинаться СРАЗУ там, где визуально начинается сама иконка (верхняя точка её цветной рамки редкости) — не выше. Не добавляй пустое место НАД иконкой «про запас» и не начинай рамку от верха строки — если между верхним краем твоей рамки и первым видимым пикселем иконки есть заметный зазор пустого фона панели, рамка начинается слишком рано, подвинь y вниз, к самой иконке.

ВАЖНО про высоту рамки (h): рамка должна плотно облегать иконку и заканчиваться сразу под её подписью уровня/тегом «Уник.», если она есть (у сундука — сразу под самим сундуком). Она НЕ должна тянуться вниз дальше этого — между строками разных боссов в панели есть пустой отступ, и рамка не должна залезать в этот отступ и тем более в текст/значок места СЛЕДУЮЩЕЙ строки босса. По высоте иконка (а) вместе с подписью под ней — это примерно квадрат или чуть выше квадрата (высота не больше чем в 1.3 раза больше ширины), иконка сундука (б) без подписи — примерно квадрат (высота ≈ ширина). Если сомневаешься насчёт высоты — лучше сделать рамку чуть меньше (даже если чуть обрежет край иконки), чем оставить лишнее пустое место сверху или снизу, или задеть соседний элемент.

Для КАЖДОЙ настоящей иконки награды (пункт 3 выше, по всем строкам панели) верни:
- рамку (x, y, w, h — доли от размера всей картинки, 0..1), плотно обхватывающую иконку (картинку предмета/сундука, её цветную рамку редкости, число-бейджик «×N» в углу, и — для иконок вида (а) — подпись уровня/тег под ней, если есть) и не более того;
- rarity — цвет рамки редкости иконки: "blue", "purple" или "red";
- quantity — число с маленького бейджика "×N" в углу иконки (если бейджика не видно, используй 1).`;

// Applied to the model's (already-validated) box after it returns — expanding a
// correctly-located box outward by a fixed ratio is trivial, deterministic arithmetic,
// unlike asking the model to locate AND pad the box in one step (round 6 tried that and
// it made box *positioning* worse, not just the margin). Clamped to stay within the
// source image — never expands past x/y = 0 or x+w/y+h = 1.
//
// Round 8: a live test showed the model's y (top edge) already runs early — noticeable
// blank panel space above the icon before it starts, icon squeezed toward the bottom of
// the crop. Adding a full-size top margin on top of that made it worse, so the top gets
// a smaller margin than the other three sides instead of matching them.
//
// Round 11: round 8 overcorrected — live tests now show the opposite problem, the top of
// the icon itself getting cut off (worse on later lots in the same batch), plus the crop
// reaching sideways into the next icon in the same row. The two get separate constants
// because rows have real empty panel gap between them (room to pad top/bottom safely) but
// icons within one row sit close together (little room to pad sideways without touching
// the neighbor) — one shared ratio for both directions was never going to fit both cases.
//
// Round 12: 0.07 wasn't nearly enough — a live test across one batch showed the model's y
// (top edge) running progressively later for lots further down the same screenshot, up to
// cutting well into the icon's own graphic on later rows, not just its label. A margin
// proportional to the icon's own (small) height can't out-run an error that grows with
// vertical position in the source image, so the ratio goes up a lot, not a little — a
// wider crop with some cream background above is a strictly smaller problem than losing
// part of the reward icon itself.
const MARGIN_RATIO = 0.08;
const SIDE_MARGIN_RATIO = 0.03;
const TOP_MARGIN_RATIO = 0.3;

// Round 13: round 12 fixed the FIRST lot in a batch (matches the reference exactly now),
// but confirmed the top-edge drift keeps growing lot over lot within the same screenshot —
// a flat margin, however large, is a constant and can never catch up with an error that
// scales with how far down the source image the icon sits. Add a second, independent term
// proportional to the item's own y so lower rows get proportionally more cushion than the
// top row does.
//
// Round 14: 0.2 was a massive overshoot, not a slight one — a live test showed crops for
// lower rows swallowing the ENTIRE previous row's boss-name text with no icon graphic left
// in frame at all, confirming the drift itself is much smaller than guessed. Cut the
// coefficient to roughly a fifth; still pending a live measurement, but the failure mode of
// "too much" is now demonstrated to be far worse than the failure mode of "too little" this
// round is correcting for, so erring toward under-shooting again is the safer direction.
const Y_DRIFT_MARGIN_RATIO = 0.04;

// Round 9: pure prompt wording turned out unstable run-to-run — fixing "too much blank
// space above" (round 8) brought back "bleeds into the next row's text" (round 5's bug)
// for some icons in the same batch. Rather than keep chasing wording, enforce the one
// geometric fact we already know for certain (icons are roughly square, at most ~1.3x
// taller than wide) as a hard code-level ceiling instead of a prompt suggestion.
//
// Round 10: a live test on 1.4 still showed some crops reaching past the icon into the
// next row's boss-name text — 1.4 was too loose a ceiling. Icon+label is realistically
// closer to 1.2x taller than wide; tightened the ratio itself rather than touching
// margins (margins apply on top of this clamp, so loosening them can't fix an
// underlying box that's already too tall).
const MAX_HEIGHT_TO_WIDTH_RATIO = 1.2;

// Round 15: the height ceiling above stops a box from reaching too far DOWN into the next
// row, but nothing stopped one from reaching too far RIGHT into the next icon in the same
// row — live tests consistently showed a sliver of the neighboring icon inside the crop on
// the right edge. Icons are never wider than they are tall (square at widest, per the
// prompt's own description and the height ceiling above), so the same anchored-shrink trick
// applies to width: clamp it to the icon's own (unclamped) height and keep the left edge
// fixed, trimming any excess strictly off the right side where the bleed was reported.
//
// Round 16: 1.0 was way too tight — a live test showed real icons (the diamond/hex frame
// shapes are naturally a bit wider than tall) getting visibly zoomed in and cropped, losing
// part of the actual picture. Cropping into the icon itself is a worse failure than a small
// sliver of the neighbor showing, so loosen this to only catch genuinely extreme cases.
const MAX_WIDTH_TO_HEIGHT_RATIO = 1.5;

// Round 21: even with content selection mostly working, live tests keep showing a handful
// of phantom boxes over the panel's blank cream background or the bottom tab bar's solid
// color — no icon in them at all. Round 18 tried fixing this by naming the tab bar in the
// prompt and it made content selection MUCH worse batch-wide (reverted, round 20), so this
// is a code-side check instead: a real reward icon (rarity-frame + artwork, or a chest) always
// has real color variance; a blank panel or a solid UI-chrome crop is close to flat. Reject
// crops whose pixel stdev falls under this — measured on a 0-255 channel scale.
const MIN_CONTENT_STDEV = 10;

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

  // Round 19: one malformed item (bad rarity, NaN coordinates, whatever) used to throw and
  // abort the WHOLE screenshot — and since the caller uploads several screenshots in one
  // request and only writes results to the DB after every screenshot succeeds, one bad item
  // anywhere in the batch discarded every other screenshot's already-good results too, a
  // live test hit exactly this. Skip just the one bad item instead of failing the batch.
  const items: VisionLotItem[] = [];
  for (let i = 0; i < toolUse.input.items.length; i++) {
    try {
      const item = validateItem(toolUse.input.items[i], i);
      // Round 21: also drop the item if its own crop turns out to have no real content —
      // see MIN_CONTENT_STDEV above. A geometrically valid box is not proof of a real icon.
      if (await hasVisualContent(imageBuffer, item)) {
        items.push(item);
      } else {
        console.warn(`extractInvasionLoot: skipping item ${i}: crop has no real visual content (blank/solid-color box)`);
      }
    } catch (err) {
      console.warn(`extractInvasionLoot: skipping invalid item ${i}: ${(err as Error).message}`);
    }
  }
  return items;
}

const QUANTITY_PROMPT = `Каждое изображение выше — маленький кроп бейджика с числом
(количество предмета) в мобильной игре, пронумерованный по порядку начиная с 0
("Изображение 0", "Изображение 1", ...). Для КАЖДОГО изображения верни ровно одну запись:
index (номер изображения, как подписано выше) и quantity — число, которое там написано.
Если число нечитаемо или бейджика не видно на конкретном изображении — верни quantity: 1
для этого index, но всё равно включи запись. Не пропускай ни один index и не добавляй
лишних.`;

// One batched call: every badge crop goes in as its own small image, numbered in the
// prompt text so the model can report an explicit index per result. The response is
// matched to input crops BY THAT INDEX, never by array position — a batched multi-image
// request desyncing image N from output N is a real failure mode (see Global Constraints
// in the plan this shipped from), so any response whose indices don't exactly cover
// 0..badgeCrops.length-1 is treated as a failed call, not silently reordered or truncated.
export async function readQuantities(
  badgeCrops: Buffer[],
  apiKey: string,
  baseUrl: string = DEFAULT_BASE_URL
): Promise<number[]> {
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (badgeCrops.length === 0) {
    return [];
  }

  const content: Record<string, unknown>[] = [];
  badgeCrops.forEach((crop, i) => {
    content.push({ type: 'text', text: `Изображение ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: crop.toString('base64') } });
  });
  content.push({ type: 'text', text: QUANTITY_PROMPT });

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: 'disabled' },
      tools: [
        {
          name: 'read_quantities',
          description: 'Records the quantity number read off each small badge image.',
          input_schema: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    index: { type: 'integer', minimum: 0 },
                    quantity: { type: 'integer', minimum: 1 },
                  },
                  required: ['index', 'quantity'],
                },
              },
            },
            required: ['items'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'read_quantities' },
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic API request failed (${res.status}): ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { content?: { type: string; input?: unknown }[]; stop_reason?: string };
  if (data.stop_reason === 'max_tokens') {
    throw new Error('Anthropic API response was truncated (max_tokens)');
  }
  const toolUse = data.content?.find((block) => block.type === 'tool_use') as
    | { type: 'tool_use'; input?: { items?: unknown[] } }
    | undefined;
  if (!toolUse || !Array.isArray(toolUse.input?.items)) {
    throw new Error('Anthropic API response did not include the expected tool_use block');
  }

  const byIndex = new Map<number, number>();
  for (const raw of toolUse.input.items) {
    const item = raw as { index?: unknown; quantity?: unknown };
    if (
      typeof item.index === 'number' &&
      Number.isInteger(item.index) &&
      typeof item.quantity === 'number' &&
      Number.isInteger(item.quantity) &&
      item.quantity >= 1
    ) {
      byIndex.set(item.index, item.quantity);
    }
  }

  // Missing-index check runs BEFORE the size check: it gives a precise "index N missing"
  // message for the common case (the model just dropped one). The size check afterward
  // catches what the missing-index loop can't — every 0..N-1 present, but padded with an
  // extra/out-of-range index too, which is just as untrustworthy as a missing one, so it
  // isn't given a free pass by inspecting the count.
  const quantities: number[] = [];
  for (let i = 0; i < badgeCrops.length; i++) {
    const quantity = byIndex.get(i);
    if (quantity === undefined) {
      throw new Error(`readQuantities: response missing index ${i}`);
    }
    quantities.push(quantity);
  }

  if (byIndex.size !== badgeCrops.length) {
    throw new Error(
      `readQuantities: response had ${byIndex.size} distinct indices, expected exactly ${badgeCrops.length}`
    );
  }

  return quantities;
}

async function hasVisualContent(imageBuffer: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<boolean> {
  const { width, height } = await sharp(imageBuffer).metadata();
  if (!width || !height) return true; // can't check — don't block on a metadata read failure

  const left = Math.max(0, Math.min(width - 1, Math.round(box.x * width)));
  const top = Math.max(0, Math.min(height - 1, Math.round(box.y * height)));
  const cropWidth = Math.max(1, Math.min(width - left, Math.round(box.w * width)));
  const cropHeight = Math.max(1, Math.min(height - top, Math.round(box.h * height)));

  const { channels } = await sharp(imageBuffer).extract({ left, top, width: cropWidth, height: cropHeight }).stats();
  const avgStdev = channels.reduce((sum, c) => sum + c.stdev, 0) / channels.length;
  return avgStdev >= MIN_CONTENT_STDEV;
}

function validateItem(raw: unknown, index: number): VisionLotItem {
  const item = raw as Partial<VisionLotItem>;
  const isFraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
  const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1;
  if (!isFraction(item.x) || !isFraction(item.y) || !isFraction(item.w) || !isFraction(item.h)) {
    throw new Error(`item ${index}: x/y/w/h must be numbers between 0 and 1`);
  }
  if (item.rarity !== 'blue' && item.rarity !== 'purple' && item.rarity !== 'red') {
    throw new Error(`item ${index}: rarity must be blue, purple, or red`);
  }
  if (!isPositiveInt(item.quantity)) {
    throw new Error(`item ${index}: quantity must be a positive integer`);
  }

  // Round 17: a box right at the image edge (e.g. a bottom-row icon the model estimates as
  // slightly taller than the space left below it) used to abort the ENTIRE upload with a
  // validation error — a live test hit this on one icon out of a whole batch, losing every
  // other icon in it too. A box merely touching or slightly overshooting the edge is
  // trivially recoverable by trimming it to fit, so clamp instead of rejecting; only a
  // genuinely nonsensical box (caught by the isFraction checks above) still throws.
  const rawW = Math.min(item.w, 1 - item.x);
  const rawH = Math.min(item.h, 1 - item.y);

  // Hard ceiling, enforced in code rather than trusted from the model: icons are always
  // roughly square to a bit taller than wide (see the prompt's own description), never a
  // tall rectangle. A model-returned h taller than this relative to w is symptomatic of
  // exactly one thing seen live — the box reaching past the icon into the next panel
  // row's text — so clamp it down (anchored at the same top edge) rather than trust it.
  const clampedH = Math.min(rawH, rawW * MAX_HEIGHT_TO_WIDTH_RATIO);
  // Anchored at the left edge (x unchanged), same reasoning as the height ceiling above —
  // trims a too-wide box strictly off the right, which is where the bleed was reported.
  const clampedW = Math.min(rawW, rawH * MAX_WIDTH_TO_HEIGHT_RATIO);

  const marginX = clampedW * SIDE_MARGIN_RATIO;
  const marginTop = clampedH * TOP_MARGIN_RATIO + item.y * Y_DRIFT_MARGIN_RATIO;
  const marginBottom = clampedH * MARGIN_RATIO;
  const x = Math.max(0, item.x - marginX);
  const y = Math.max(0, item.y - marginTop);
  const w = Math.min(1 - x, clampedW + 2 * marginX);
  const h = Math.min(1 - y, clampedH + marginTop + marginBottom);

  return { x, y, w, h, rarity: item.rarity, quantity: item.quantity };
}
