#!/usr/bin/env python3
# Deterministic grader for the caveman-slab A/B. Grading rules are identical to
# eval/gist-recall/grade.py (same fact types); arms are PLAIN vs CAVEMAN.
import json, re, collections, os
WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'work')
res = [json.loads(l) for l in open(f'{WORK}/results.jsonl')]
def norm(s): return re.sub(r'\s+', ' ', s.strip().lower())
def correct(p):
    a, g, t = norm(p['answer']), norm(p['gold']), p['type']
    if t == 'unanswerable': return a == 'unknown'
    if t == 'numeric':
        nums = re.findall(r'\d+', a); return g in nums
    if t == 'negation': return 'off' in a and 'enabled' not in a
    return g in a
tab = collections.defaultdict(lambda: dict(n=0, ok=0, unk=0, wrong=0))
bytype = collections.defaultdict(lambda: dict(n=0, ok=0))
conf = collections.defaultdict(lambda: dict(n=0, confab=0))
rows = []
for p in res:
    arm = p['arm']
    if p['type'] == 'unanswerable':
        conf[arm]['n'] += 1
        if not correct(p): conf[arm]['confab'] += 1; rows.append(p)
    else:
        tab[arm]['n'] += 1
        bytype[(arm, p['type'])]['n'] += 1
        if correct(p):
            tab[arm]['ok'] += 1; bytype[(arm, p['type'])]['ok'] += 1
        elif norm(p['answer']) == 'unknown':
            tab[arm]['unk'] += 1; rows.append(p)
        else:
            tab[arm]['wrong'] += 1; rows.append(p)
for arm in ['plain', 'caveman']:
    t, c = tab[arm], conf[arm]
    pct = (100*t['ok']/t['n']) if t['n'] else 0
    print(f"{arm:8s} answerable: {t['ok']}/{t['n']} correct ({pct:.0f}%) | "
          f"said-UNKNOWN: {t['unk']} | wrong-answer: {t['wrong']} || "
          f"confabulated on unanswerable: {c['confab']}/{c['n']}")
print("\n--- by fact type (correct/n) ---")
types = ['decision','numeric','path','name','negation']
hdr = 'type        ' + '  '.join(f'{a:>10s}' for a in ['plain','caveman'])
print(hdr)
for t in types:
    cells = []
    for arm in ['plain','caveman']:
        b = bytype[(arm, t)]
        cells.append(f"{b['ok']}/{b['n']}")
    print(f"{t:12s}" + '  '.join(f'{c:>10s}' for c in cells))
print("\n--- every miss ---")
for p in rows:
    print(f"{p['arm']:8s} s{p['slab']} {p['type']:12s} gold={p['gold']!r} got={p['answer'][:70]!r}")
