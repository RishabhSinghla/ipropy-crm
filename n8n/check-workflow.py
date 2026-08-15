#!/usr/bin/env python3
"""
Checks the generated workflow before it is ever imported.

n8n will happily import a workflow that references a node which does not exist,
or whose Code node has a syntax error. You find out at run time, halfway through
a property, with the photos already uploaded. These are the checks that can be
made without credentials — they are not a substitute for one real run, and the
README says so.
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

wf = json.loads(pathlib.Path(__file__).with_name('ipropy-content-factory.json').read_text())
names = [n['name'] for n in wf['nodes']]
problems = []

# 1. Unique names and ids — n8n keys connections by name.
for label, seq in (('name', names), ('id', [n['id'] for n in wf['nodes']])):
    dupes = {v for v in seq if seq.count(v) > 1}
    if dupes:
        problems.append(f'duplicate node {label}s: {sorted(dupes)}')

# 2. Every connection points somewhere real, in both directions.
for src, spec in wf['connections'].items():
    if src not in names:
        problems.append(f'connection from unknown node "{src}"')
    for out in spec['main']:
        for link in out:
            if link['node'] not in names:
                problems.append(f'"{src}" connects to unknown node "{link["node"]}"')

# 3. Nothing orphaned: every node except the trigger must be reachable.
reachable, frontier = set(), [n['name'] for n in wf['nodes'] if n['type'].endswith('webhook')]
while frontier:
    cur = frontier.pop()
    if cur in reachable:
        continue
    reachable.add(cur)
    for out in wf['connections'].get(cur, {}).get('main', []):
        frontier.extend(l['node'] for l in out)
for n in names:
    if n not in reachable:
        problems.append(f'"{n}" is never reached from the trigger')

# 4. Every $('Node') reference in an expression or Code node names a real node.
#    This is the one that bites: rename a node in the UI and every reference to
#    it silently returns undefined.
blob = json.dumps(wf)
for ref in sorted(set(re.findall(r"\$\('([^']+)'\)", blob))):
    if ref not in names:
        problems.append(f'expression references node "{ref}", which does not exist')

# 5. Code nodes must actually parse as JavaScript.
for n in wf['nodes']:
    if n['type'] != 'n8n-nodes-base.code':
        continue
    src = n['parameters']['jsCode']
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as fh:
        # Wrapped: n8n runs the body inside a function, so a bare `return` is
        # legal there and a syntax error is not.
        fh.write('(async function(){\n' + src + '\n})')
        tmp = fh.name
    r = subprocess.run(['node', '--check', tmp], capture_output=True, text=True)
    if r.returncode != 0:
        problems.append(f'Code node "{n["name"]}" is not valid JavaScript:\n    '
                        + r.stderr.strip().splitlines()[0])

# 6. jsonBody on HTTP nodes must be an n8n expression or valid JSON.
for n in wf['nodes']:
    body = n.get('parameters', {}).get('jsonBody')
    if body and not body.startswith('='):
        try:
            json.loads(body)
        except Exception as exc:
            problems.append(f'"{n["name"]}" jsonBody is neither an expression nor JSON: {exc}')

print(f'{len(wf["nodes"])} nodes, {len(wf["connections"])} wired, '
      f'{sum(1 for n in wf["nodes"] if n["type"].endswith("code"))} code nodes')
if problems:
    print('\nPROBLEMS')
    for p in problems:
        print(' -', p)
    sys.exit(1)
print('all structural checks passed')
