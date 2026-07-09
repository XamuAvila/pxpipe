/**
 * Caveman pass — deterministic, rule-based prose compression for text bound
 * to the optical (PNG) channel.
 *
 * Why: image cost is pixel-area billing (`width × height / 750`), and pixel
 * area at fixed density is proportional to char count — so every char dropped
 * BEFORE rendering compounds with the render savings. Articles, filler
 * adverbs, and politeness phrases carry near-zero gist, which is the only
 * fidelity level the optical channel promises anyway (FINDINGS.md: pxpipe is
 * a lossy gist-compressor).
 *
 * The trade-off (FINDINGS.md capacity argument): natural-language redundancy
 * is the error-correcting code of the lossy optical read — telegraphic text
 * gives the language prior less signal to repair under-resolved glyphs. This
 * pass is therefore an opt-in EXPERIMENT (`PXPIPE_CAVEMAN=1`) until the A/B
 * harness shows gist/verbatim recall does not regress.
 *
 * Hard requirements:
 *  - DETERMINISTIC and idempotent. The slab image bytes are the prompt-cache
 *    key; any nondeterminism here busts the cache every turn. No LLM, no
 *    randomness, no locale/config dependence.
 *  - VERBATIM-SAFE. Never touches: fenced/indented code, markdown table
 *    rows, inline `code` spans, double-quoted spans, or any token that is
 *    not purely alphabetic — ids, hashes, paths, URLs, env vars, numbers,
 *    ALL-CAPS and CamelCase tokens all pass through untouched. Only whole
 *    lowercase (or Capitalized) words from the curated EN/PT lists drop.
 */

// --- word lists -------------------------------------------------------------

/** Multi-letter articles, EN + PT.
 *  Deliberately EXCLUDES 'as': it is a PT plural article but also a
 *  load-bearing EN conjunction ("treat as data") — dropping it inverts
 *  meaning in the EN prose that dominates real slabs. */
const ARTICLES: ReadonlySet<string> = new Set([
  // EN
  'the',
  'an',
  // PT
  'um',
  'uma',
  'uns',
  'umas',
  'os',
]);

/** Single-letter articles ('a' EN/PT, 'o' PT): drop only the exact-lowercase
 *  form. An isolated capital "A"/"O" is more likely an option label, list
 *  marker, or grade than an article. */
const SINGLE_LETTER_ARTICLES: ReadonlySet<string> = new Set(['a', 'o']);

/** Intensity/filler adverbs and politeness words whose removal cannot invert
 *  meaning. Deliberately EXCLUDES hedges that flip polarity when removed
 *  ('quite': "not quite right" ≠ "not right") and quantifiers that carry
 *  real information ('only', 'just', 'muito'/'muitos'). */
const FILLERS: ReadonlySet<string> = new Set([
  // EN
  'really',
  'actually',
  'basically',
  'simply',
  'essentially',
  'certainly',
  'definitely',
  'obviously',
  'literally',
  'very',
  'please',
  'kindly',
  // PT
  'realmente',
  'basicamente',
  'simplesmente',
  'essencialmente',
  'certamente',
  'definitivamente',
  'obviamente',
  'literalmente',
]);

/** Politeness/verbosity phrases rewritten before word drops. Applied only to
 *  unprotected prose segments; each replacement is idempotent (its output
 *  never re-matches its pattern). */
const PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bplease note that\b/gi, ''],
  [/\bnote that\b/gi, ''],
  [/\bkeep in mind that\b/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\bas well as\b/gi, 'and'],
  [/\bmake sure that\b/gi, 'ensure'],
  // PT
  [/\bpor favor\b/gi, ''],
  [/\ba fim de\b/gi, 'para'],
  [/\bnote que\b/gi, ''],
  [/\btenha em mente que\b/gi, ''],
];

// --- protections ------------------------------------------------------------

/** Fence opener/closer (``` or ~~~), optionally indented. */
const FENCE_LINE = /^\s*(```|~~~)/;

/** Markdown code by indentation (4 spaces or a tab). */
const INDENTED_CODE = /^(?: {4}|\t)/;

/** Markdown table row. */
const TABLE_ROW = /^\s*\|/;

/** Spans that must survive byte-exact even inside prose: inline `code`
 *  and double-quoted strings (quoted error messages get grepped verbatim).
 *  Single quotes are NOT protected — apostrophes ("don't") would open
 *  phantom spans. Capture group so `split` keeps the spans. */
const PROTECTED_SPAN = /(`[^`\n]+`|"[^"\n]*")/g;

/** Letters-only token (Unicode-aware: PT diacritics included). Anything with
 *  a digit, slash, dot, underscore, etc. never matches — that single check
 *  protects ids, paths, URLs, hashes, numbers, and env vars. */
const LETTERS_ONLY = /^\p{L}+$/u;

// --- core -------------------------------------------------------------------

function isDroppableWord(token: string): boolean {
  if (!LETTERS_ONLY.test(token)) return false;
  const lower = token.toLowerCase();
  const isLower = token === lower;
  // Allow exact-lowercase and Capitalized ("The"); reject ALL-CAPS and
  // mixed-case (PATH, iOS) — those read as identifiers, not grammar.
  const isCapitalized =
    !isLower &&
    token[0] === token[0]!.toUpperCase() &&
    token.slice(1) === token.slice(1).toLowerCase();
  if (!isLower && !isCapitalized) return false;
  if (ARTICLES.has(lower) || FILLERS.has(lower)) return true;
  return isLower && SINGLE_LETTER_ARTICLES.has(lower);
}

/** Compress one unprotected prose segment. Preserves the segment's exact
 *  leading/trailing whitespace (it may butt up against a protected span);
 *  interior whitespace collapses to single spaces — acceptable for prose,
 *  and the slab path runs `compactSlabWhitespace` afterwards anyway. */
function compressSegment(seg: string): string {
  let s = seg;
  for (const [re, sub] of PHRASES) s = s.replace(re, sub);
  const lead = s.match(/^\s*/)![0];
  if (lead.length === s.length) return s; // empty or all-whitespace
  const trail = s.match(/\s*$/)![0];
  const body = s.slice(lead.length, s.length - trail.length);
  const words = body.split(/\s+/).filter((w) => w.length > 0 && !isDroppableWord(w));
  return lead + words.join(' ') + trail;
}

function compressLine(line: string): string {
  if (INDENTED_CODE.test(line) || TABLE_ROW.test(line)) return line;
  if (!/\p{L}/u.test(line)) return line; // nothing droppable, skip regex work
  const parts = line.split(PROTECTED_SPAN);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    // Odd indexes are the captured protected spans — byte-exact passthrough.
    out += i % 2 === 1 ? part : compressSegment(part);
  }
  return out;
}

/**
 * Deterministically strip low-information words from prose. Code (fenced,
 * indented, inline), table rows, quoted spans, and every non-alphabetic
 * token pass through byte-exact. Line structure is preserved (no line merges
 * or splits) so renderer row accounting and paging stay comparable.
 *
 * Callers gate on `classifyContent(text) === 'other'` — running this over
 * JSON/logs would be a no-op waste of CPU at best.
 */
export function cavemanize(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      continue; // the fence marker itself stays verbatim
    }
    if (inFence) continue;
    const compressed = compressLine(line);
    if (compressed !== line) lines[i] = compressed;
  }
  return lines.join('\n');
}
