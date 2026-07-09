#!/usr/bin/env python3
# Caveman-slab A/B runner. Both arms call headless `claude -p` directly — the
# same invocation bench/run.sh uses and that is proven to work on this machine
# (subscription OAuth, no API key). The proxy override is stripped so traffic
# does NOT go through pxpipe (which would re-transform the very images we
# measure). --setting-sources project + --strict-mcp-config isolate the run from
# the global CLAUDE.md and MCP so nothing but the imaged slab drives the answer.
# The imaged slab is presented as this session's operating instructions; the
# model must answer from it or reply UNKNOWN.
import json, os, subprocess, glob
from concurrent.futures import ThreadPoolExecutor

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'work')
MODEL = os.environ.get('MODEL', 'claude-fable-5')
CLAUDE = os.environ.get('CLAUDE_BIN', 'claude')
probes = json.load(open(f'{WORK}/probes.json'))
env = {k: v for k, v in os.environ.items() if k != 'ANTHROPIC_BASE_URL'}

def ask(prompt):
    try:
        r = subprocess.run(
            [CLAUDE, '-p', prompt, '--model', MODEL, '--output-format', 'json',
             '--allowedTools', 'Read', '--setting-sources', 'project',
             '--strict-mcp-config', '--dangerously-skip-permissions'],
            capture_output=True, text=True, timeout=300, env=env)
        if r.returncode != 0:
            return f'<ERROR exit {r.returncode}: {r.stderr.strip()[:200]}>'
        j = json.loads(r.stdout)
        return (j.get('result') or '').strip()
    except Exception as e:
        return f'<ERROR {e}>'

def one(job):
    arm, p = job
    sid, q = p['slab'], p['q']
    pngs = sorted(glob.glob(f'{WORK}/{arm}_s{sid}_p*.png'))
    suffix = (f"\n\nQuestion: {q}\nIf the operating instructions do not contain the answer, "
              f"reply exactly UNKNOWN. Reply with only the answer, nothing else.")
    prompt = (f"Your operating instructions and tool reference for this session are provided as "
              f"{len(pngs)} images: " + ' '.join(pngs) + ". Read all of them in order; do not use "
              "any other tool or write code, just read the images visually. Answer using only what "
              "those instructions state.") + suffix
    ans = ask(prompt)
    return dict(arm=arm, **p, answer=ans)

jobs = [(arm, p) for arm in ['plain', 'caveman'] for p in probes]
print(f'{len(jobs)} calls, model {MODEL}', flush=True)
out = open(f'{WORK}/results.jsonl', 'w')
with ThreadPoolExecutor(max_workers=6) as ex:
    for i, res in enumerate(ex.map(one, jobs)):
        out.write(json.dumps(res) + '\n'); out.flush()
        print(f"[{i+1}/{len(jobs)}] {res['arm']:8s} s{res['slab']} {res['type']:12s} -> {res['answer'][:60]!r}", flush=True)
print('done')
