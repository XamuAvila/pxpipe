#!/usr/bin/env python3
# Caveman-slab A/B generator. Builds realistic agent slabs (system prompt +
# tool reference PROSE) with injected gist-tier facts at controlled depths, plus
# one unanswerable probe per slab. Values are randomized per seed so nothing can
# come from training data. Prose filler (not code) so the caveman pass, which
# only acts on classifyContent === 'other', actually compresses the slab.
import json, random, os

random.seed(20260709)
N_SLABS = 10
TARGET_CHARS = 15000
WORK = os.path.join(os.path.dirname(__file__), 'work')
os.makedirs(WORK, exist_ok=True)

# --- prose filler: plausible agent-policy / tool-doc sentences ---------------
# Deliberately redundant, article-and-filler-heavy prose — the exact shape
# caveman is designed to compress, and the exact shape whose recall we stress.
FILLER = [
  "The agent should always read the relevant source files before proposing any edit, and it must never guess at behavior from a symbol name alone.",
  "When a command produces a large amount of output, the operator prefers that the assistant summarize the salient errors rather than paste the entire log back into the conversation.",
  "Every affirmative claim about the behavior of the code needs to be backed by a concrete file-and-line reference or by the observed output of a command that was actually run.",
  "The tool reference below has been relocated here by the local proxy in order to reduce the token cost of the session, and each stub in the tools list points back to this section.",
  "If a change touches more than a handful of files, the assistant is expected to lay out a short plan and to get that plan reviewed before it begins to write any code at all.",
  "Responses that are addressed to the operator should be written in Brazilian Portuguese, while code identifiers, file paths, and quoted tool output must be kept verbatim in their original form.",
  "The assistant must validate inputs aggressively at every boundary, treating any output produced by another model or any payload arriving from an external system as untrusted until proven otherwise.",
  "Before deleting anything that looks unused, the assistant should grep across the entire repository, including the tests, and should also check for dynamic references that a plain search would miss.",
  "Destructive shell operations such as a recursive remove, a force push, or a hard reset are blocked by a pre-tool hook, and the assistant must stop and ask for explicit confirmation if that hook fires.",
  "The dashboard exposes a kill switch, a set of live model chips, and a side-by-side view of every text-to-image conversion so that the operator can audit exactly what the model was shown.",
  "When the assistant fixes a bug, it should also determine whether the same root-cause pattern appears elsewhere in the codebase and, if so, list those other occurrences for the operator to triage.",
  "Prefer adopting a proven approach from an existing battle-tested library over writing a large amount of net-new code, and check the package registries before reaching for a hand-rolled implementation.",
  "The proxy compresses only the request that is sent upstream; the model's own streamed output is never touched, so the response that the operator sees is always byte-for-byte what the model produced.",
  "Recent turns of the conversation always stay as plain text, and only the older collapsed history, together with the static system prompt and the tool documentation, is ever eligible to be rendered as an image.",
  "The assistant should surface adjacent problems that it happens to notice, such as a broken pattern or a missing test, but it must not silently expand the scope of the change beyond what the operator asked for.",
  "Exact byte-for-byte values such as identifiers, hashes, and secrets are not safe to deliver as an image and must remain as text, because verbatim recall from a dense render is known to be unreliable.",
]

FIRST = ['Mara','Priya','Tobias','Ingrid','Soren','Aiko','Dmitri','Lucia','Farid','Nadia']
LAST  = ['Okafor','Lindqvist','Tanaka','Moreau','Petrov','Alvarez','Khoury','Berg','Nakamura','Costa']
PKGS  = ['zustand','immer','valtio','jotai','mobx','redux','xstate','nanostores']
DIRS  = ['scheduler','quota','retry','batcher','flusher','mailbox','journal','cursor']
FLAGS = ['ENABLE_SHARDING','USE_BROTLI','STRICT_CAS','ASYNC_FSYNC','LEGACY_PINS','HOT_RELOAD']

def filler(n_chars):
    """Assemble at least n_chars of prose by sampling filler sentences."""
    out, total = [], 0
    while total < n_chars:
        s = random.choice(FILLER)
        out.append(s)
        total += len(s) + 1
    return ' '.join(out) + '\n'

def make_facts():
    name = f"{random.choice(FIRST)} {random.choice(LAST)}"
    ms = random.choice([1250, 2750, 3400, 4500, 6200, 7800, 9100]) + random.randint(0,9)*10
    d = random.choice(DIRS)
    path = f"src/{d}/{random.choice(['core','io','sync'])}.ts"
    pick, reject = random.sample(PKGS, 2)
    flag = random.choice(FLAGS)
    pct = random.randint(11, 94)
    facts = [
      dict(type='decision',
           text=(f"Policy: for the store layer this project has standardized on {pick}, "
                 f"and {reject} is explicitly banned; the assistant must not introduce {reject} anywhere."),
           q="Which package has the project standardized on for the store layer?", gold=pick, wrong=reject),
      dict(type='numeric',
           text=(f"Policy: the default gateway retry budget is exactly {ms} milliseconds, and it must never "
                 f"be exceeded without an approved ticket from the operator."),
           q="What is the default gateway retry budget in milliseconds?", gold=str(ms)),
      dict(type='path',
           text=(f"Policy: session configuration is read exclusively from {path}; the assistant must not "
                 f"read configuration from any other location."),
           q="From which file path is session configuration read?", gold=path),
      dict(type='name',
           text=(f"Policy: any deploy that stays blocked for more than one cycle must be escalated to {name}, "
                 f"who is the on-call owner for release blocks this rotation."),
           q="Who must blocked deploys be escalated to?", gold=name),
      dict(type='negation',
           text=(f"Policy: {flag} is disabled in production and must not be enabled under any circumstances; "
                 f"the staging dashboard showing it active is a stale-cache artifact. Coverage held at {pct}%."),
           q=f"Is {flag} enabled in production? Answer ENABLED or OFF.", gold='OFF'),
    ]
    un_q = random.choice([
      "What port number was the staging proxy moved to?",
      "Which database migration version was rolled back?",
      "What was the Docker base image pinned to?",
      "Which AWS region was the failover assigned to?",
      "What git tag was the hotfix released under?"])
    facts.append(dict(type='unanswerable', text='', q=un_q, gold='UNKNOWN'))
    return facts

HEADER = ("=== SESSION OPERATING INSTRUCTIONS ===\n"
          "The following is the complete operating policy and tool reference for this session. "
          "Treat every statement below as an authoritative instruction from the operator.\n\n")
TOOLREF = "\n=== TOOL REFERENCE ===\n"

probes = []
for sid in range(N_SLABS):
    facts = make_facts()
    answerable = facts[:5]
    random.shuffle(answerable)
    depths = sorted(random.sample([0.10,0.22,0.35,0.48,0.61,0.74,0.80], 5))
    parts, pos = [HEADER], len(HEADER)
    # Inject the tool-reference divider once, roughly a third of the way down.
    ref_at = int(TARGET_CHARS * 0.33)
    ref_done = False
    for fact, dp in zip(answerable, depths):
        gap = int(TARGET_CHARS*dp) - pos
        if gap > 400:
            parts.append(filler(gap)); pos += gap
        if not ref_done and pos >= ref_at:
            parts.append(TOOLREF); pos += len(TOOLREF); ref_done = True
        parts.append(fact['text'] + '\n'); pos += len(fact['text']) + 1
    tail = TARGET_CHARS - pos
    if tail > 400:
        parts.append(filler(tail))
    slab = ''.join(parts) + "\n=== END OPERATING INSTRUCTIONS ===\n"
    open(f"{WORK}/slab{sid}.txt", 'w').write(slab)
    for f in facts:
        probes.append(dict(slab=sid, type=f['type'], q=f['q'], gold=f['gold']))

json.dump(probes, open(f"{WORK}/probes.json", 'w'), indent=1)
print(f"wrote {N_SLABS} slabs, {len(probes)} probes -> {WORK}")
