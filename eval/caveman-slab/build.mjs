// Render each slab to PNGs at the proxy's production density, twice:
//   PLAIN   = render(slab)
//   CAVEMAN = render(cavemanize(slab))
// The only difference between arms is the caveman pass, so any recall delta is
// attributable to caveman alone. Reports chars dropped per slab as a validity
// gate — if caveman drops ~nothing, the test is void.
import {
  renderTextToPngsWithCharLimit,
  DENSE_CONTENT_COLS,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_RENDER_STYLE,
} from '../../dist/core/render.js';
import { cavemanize } from '../../dist/core/caveman.js';
import { readFileSync, writeFileSync } from 'node:fs';

const N_SLABS = 10;
const imgTokens = (imgs) =>
  imgs.reduce((a, im) => a + Math.round((im.width * im.height) / 750), 0);

async function renderArm(text) {
  return renderTextToPngsWithCharLimit(
    text,
    DENSE_CONTENT_COLS,
    DENSE_CONTENT_CHARS_PER_IMAGE,
    DENSE_RENDER_STYLE,
  );
}

let totalRaw = 0, totalCave = 0, tokPlain = 0, tokCave = 0, pagesPlain = 0, pagesCave = 0;
for (let s = 0; s < N_SLABS; s++) {
  const raw = readFileSync(`eval/caveman-slab/work/slab${s}.txt`, 'utf8');
  const cave = cavemanize(raw);
  totalRaw += raw.length;
  totalCave += cave.length;

  const plain = await renderArm(raw);
  const caved = await renderArm(cave);
  plain.forEach((im, i) => writeFileSync(`eval/caveman-slab/work/plain_s${s}_p${i}.png`, im.png));
  caved.forEach((im, i) => writeFileSync(`eval/caveman-slab/work/caveman_s${s}_p${i}.png`, im.png));
  pagesPlain += plain.length; pagesCave += caved.length;
  tokPlain += imgTokens(plain); tokCave += imgTokens(caved);

  const dropped = raw.length - cave.length;
  console.log(
    `slab${s}: ${raw.length}->${cave.length} chars (-${dropped}, -${(100 * dropped / raw.length).toFixed(1)}%)  ` +
    `pages ${plain.length}/${caved.length}  imgTok ${imgTokens(plain)}/${imgTokens(caved)}`,
  );
}

const dropPct = (100 * (totalRaw - totalCave) / totalRaw).toFixed(1);
console.log(
  `\nTOTAL chars ${totalRaw}->${totalCave} (-${dropPct}%)  ` +
  `pages ${pagesPlain}/${pagesCave}  imgTokens ${tokPlain}/${tokCave} (-${(100 * (tokPlain - tokCave) / tokPlain).toFixed(1)}%)`,
);
if (totalCave >= totalRaw) {
  console.error('VALIDITY FAIL: caveman dropped nothing — test is void.');
  process.exit(1);
}
