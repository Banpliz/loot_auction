// One-off diagnostic: computes dedup.ts's exact 16x16 icon signature for the N most
// recently modified *-icon.png crops in a directory, prints a pairwise distance matrix
// (same metric dedup.ts's signatureDistance uses) so visually-similar icons cluster
// together at a glance, and prints each signature as a JSON array ready to paste into a
// reference constant (e.g. dedup.ts's CHEST_REFERENCE_SIGNATURE) if needed.
//
// Usage: node scripts/icon-signature-report.js [data/uploads/items] [N]

import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';

const [, , dirArg, countArg] = process.argv;
const dir = dirArg || 'data/uploads/items';
const count = countArg ? parseInt(countArg, 10) : 12;
const SIGNATURE_SIZE = 16;

function signatureDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function main() {
  const entries = await fs.readdir(dir);
  const iconFiles = entries.filter((f) => f.endsWith('-icon.png'));
  const withMtime = await Promise.all(
    iconFiles.map(async (f) => {
      const full = path.join(dir, f);
      const stat = await fs.stat(full);
      return { name: f, full, mtime: stat.mtimeMs };
    })
  );
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const recent = withMtime.slice(0, count);

  const withSig = await Promise.all(
    recent.map(async (f) => ({
      name: f.name,
      sig: await sharp(f.full).resize(SIGNATURE_SIZE, SIGNATURE_SIZE, { fit: 'fill' }).raw().toBuffer(),
    }))
  );

  console.log(`\n${withSig.length} most recently modified *-icon.png files in ${dir}:\n`);
  withSig.forEach((f, i) => console.log(`[${i}] ${f.name}`));

  console.log('\nPairwise distance matrix (dedup.ts calls anything under 16 "the same icon"):\n');
  const header = '     ' + withSig.map((_, i) => String(i).padStart(6)).join('');
  console.log(header);
  for (let i = 0; i < withSig.length; i++) {
    const row = withSig.map((_, j) => signatureDistance(withSig[i].sig, withSig[j].sig).toFixed(1).padStart(6));
    console.log(`[${i}]`.padEnd(5) + row.join(''));
  }

  console.log('\nRaw signatures (JSON arrays, in case one needs to become a reference constant):\n');
  withSig.forEach((f, i) => {
    console.log(`[${i}] ${f.name}:`);
    console.log(JSON.stringify([...f.sig]));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
