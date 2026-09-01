// One-off diagnostic: prints the most common colors in an image, quantized to
// buckets of 16 per channel, sorted by pixel count. Point it at a real uploaded
// invasion screenshot to get real panel/rarity-frame RGB values instead of guessing
// from looking at a screenshot in chat.
//
// Usage: node scripts/color-histogram.js path/to/screenshot.png [topN]

import sharp from 'sharp';

const [, , imagePath, topNArg] = process.argv;
if (!imagePath) {
  console.error('Usage: node scripts/color-histogram.js path/to/screenshot.png [topN]');
  process.exit(1);
}
const topN = topNArg ? parseInt(topNArg, 10) : 25;
const BUCKET = 16;

async function main() {
  const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const counts = new Map();

  for (let i = 0; i < width * height; i++) {
    const off = i * channels;
    const r = data[off], g = data[off + 1], b = data[off + 2];
    const key = `${Math.round(r / BUCKET) * BUCKET},${Math.round(g / BUCKET) * BUCKET},${Math.round(b / BUCKET) * BUCKET}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const total = width * height;
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

  console.log(`Image: ${width}x${height}, ${total} pixels\n`);
  console.log('RGB (bucketed)      pixels    % of image');
  for (const [key, count] of sorted) {
    const pct = ((count / total) * 100).toFixed(2);
    console.log(`[${key}]`.padEnd(20), String(count).padEnd(10), `${pct}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
