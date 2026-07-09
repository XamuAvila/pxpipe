# Caveman-slab A/B: does dropping articles/fillers from the imaged slab hurt recall?

Pre-registered before any model call (repo norm; mirrors `eval/gist-recall/`).
Date: 2026-07-09. Model under test: `claude-fable-5` via the `claude` CLI on the
Max subscription (proxy bypassed, no API key). Render settings: the proxy's
current production constants (`DENSE_CONTENT_COLS=312`,
`DENSE_CONTENT_CHARS_PER_IMAGE=28080`, `DENSE_RENDER_STYLE`).

## Question

`caveman` (opt-in, `PXPIPE_CAVEMAN=1`) deterministically drops EN/PT articles
and fillers from prose **before it is rendered to an image**. In production it
acts on exactly one surface: the static system-prompt + tool-docs **slab**
(`src/core/transform.ts:1629`, gated on `classifyContent === 'other'`) and the
reminder path (`:1841`). It does **not** touch imaged history / tool_results.

The cost side is settled (`README.md` → "Caveman prose compression": one A/B run
showed cache_create −22.9%, prefix_flips=0). The open question is quality: when
the slab's prose is caveman-compressed and then imaged at production density,
can the model still recall the instructions and facts that slab carries?

This is the eval that gates flipping caveman on by default
(`src/core/transform.ts:132` — "off by default until the A/B shows gist/verbatim
[holds]").

## Why this design and not gist-recall

`eval/gist-recall/` tests text-vs-image recall on **history** transcripts.
caveman never acts on history in production, so that harness — even with a new
arm — would measure caveman on a path it does not run on. This eval puts the
facts in the **slab** (system prompt + tool docs), the exact surface caveman
compresses.

## Isolation choice (conservative)

Both arms render the slab through the **production renderer**
(`renderTextToPngsWithCharLimit` + `DENSE_*` constants — identical to
`eval/gist-recall/render.mjs`). The **only** difference between arms is the
caveman pass:

- **Arm PLAIN:** `render(slab)`
- **Arm CAVEMAN:** `render(cavemanize(slab))`

This deliberately **omits** the full `transformAnthropicMessages` pipeline's
"fact sheet" (which mirrors exact identifiers as text alongside the image,
`transform.ts:1627`) and the profitability gate. Both of those only ever make
caveman *safer* in production. Measuring without them is the **worst case**: if
recall holds here, it holds in production with the safety net on top. A miss
here is an upper bound on real risk, not a production defect on its own.

## Design (pre-registered)

Synthetic-but-realistic agent slabs: a system-prompt header + a TOOL REFERENCE
block (same first-party framing as `transform.ts:1612`), filled with plausible
agent-policy / tool-doc **prose** (so caveman actually acts on it), with facts
injected at controlled depths. Values are randomized per seed so nothing is
memorizable from training data. The model reads the imaged slab and must answer
or reply exactly `UNKNOWN`. Deterministic string grading (reused from
`eval/gist-recall/grade.py`), no LLM grader.

Tier 1: 10 slabs × ~15k chars, 5 answerable fact types + 1 unanswerable each.

Fact types (each stated once, in prose, inside the slab):

| type | slab statement (seeded) | probe | gold |
|---|---|---|---|
| decision | store layer standardized on `{pick}`, `{reject}` banned | which package for the store layer? | `{pick}` |
| numeric | default retry budget `{ms}`ms | retry budget in ms? | `{ms}` |
| path | config read only from `{path}` | which file path is config read from? | `{path}` |
| name | escalate blocked deploys to `{name}` | who to escalate blocked deploys to? | `{name}` |
| negation | `{flag}` disabled in prod (staging dashboard is stale) | is `{flag}` enabled in prod? ENABLED/OFF | `OFF` |
| unanswerable | (never stated) | plausible off-topic question | `UNKNOWN` |

Unanswerable probes measure the failure mode that matters most for agents:
silent confabulation (answering confidently about a fact never stated).

## Prediction (registered)

- caveman drops articles/fillers, never letters-only content words or
  identifiers with digits/slashes/dots (`caveman.ts` protects those). So the
  gold tokens themselves survive the pass. The risk is comprehension: removing
  redundancy from instruction prose may make the fact harder to bind/recall.
- Expectation: PLAIN ≈ CAVEMAN on decision/name/negation; numeric/path lowest
  risk (identifiers pass through caveman untouched). A large CAVEMAN drop on any
  type = caveman is unsafe for the slab and stays off.

## Cost of the run

Tier 1 = 10 slabs × 6 probes × 2 arms = **120 CLI model calls** on the Max
subscription (fable-5), 6-way parallel. No API key, no metered API spend.

## Reproduce

```bash
python3 gen.py        # build slabs + probes  (free)
node build.mjs        # render PLAIN + CAVEMAN PNGs, report chars dropped (free)
python3 run.py        # 120 model calls on the Max subscription
python3 grade.py      # deterministic scoring by arm + fact type
```

Raw model answers land in `work/results.jsonl`.

## Results (2026-07-09, fable-5, N=50 answerable + 10 unanswerable per arm)

| arm | answerable | said-UNKNOWN | wrong | confabulated (unanswerable) |
|---|---|---|---|---|
| plain | 31/50 (62%) | 11 | 8 | 3/10 |
| caveman | 32/50 (64%) | 14 | 4 | 0/10 |

By fact type (correct/n): decision 5/5, numeric 5/5, path 4/6, name 7/7,
negation 10/9 (plain/caveman). Tied within noise on every type.

**Verdict: caveman does not measurably hurt recall vs plain imaging** — the two
arms tie across every fact type, and caveman confabulated less (0 vs 3). This is
the recall gate from `src/core/transform.ts:132`; it passes relative to plain
imaging.

**Two honest caveats:**

1. **Floor effect.** Both arms scored only ~63%, the mirror of gist-recall's
   ceiling. Cause is the current production density (`DENSE_CONTENT_COLS=312`,
   `28080` chars/image, a 15k-char slab in a single dense page) — much denser
   than gist-recall's 180 cols / 4 pages. Plain imaging fails the same way, so
   the floor is the dense render, not caveman. This A/B proves "caveman ≈ plain,"
   not "imaged slabs are reliable at this density."
2. **Conservative omission = worst case.** The failures are dominated by
   verbatim misreads of numbers (`3400→9000`) and paths
   (`src/scheduler/io.ts→/etc/scheduler/io.tz`). Those are exactly the exact
   identifiers production's fact sheet keeps as **text** (`transform.ts:1627`),
   which this eval deliberately omitted. In production those facts would not be
   imaged at all, so the real caveman risk is bounded well below this floor.

**Follow-ups:** re-run at gist-recall density (multi-page, fewer cols) to lift
the floor and sharpen the caveman delta; and/or run through the full
`transformAnthropicMessages` path so the fact sheet is in play, measuring true
end-to-end production recall rather than the worst case.
