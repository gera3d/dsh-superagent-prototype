#!/usr/bin/env python3
"""Measure worker Session context: model-facing tool-result sizes and token usage from DSH session logs.

Usage: measure-worker-context.py <session.v4.jsonl[.zstd]|directory> ... [--json]
Reads only; separates input / output / cache-read tokens (allowance burn and billed cost are provider-side and not derivable
from the log). Oversized = more than 100 lines or 4096 bytes of model-facing text in one tool result."""
import json, subprocess, sys, os, collections

LINES, BYTES = 100, 4096

def events(path):
    if path.endswith('.zstd'):
        data = subprocess.run(['zstd', '-dc', path], capture_output=True, check=True).stdout.decode('utf8', 'replace')
    else:
        data = open(path, encoding='utf8', errors='replace').read()
    for line in data.splitlines():
        try: yield json.loads(line)
        except ValueError: continue

def files(args):
    for a in args:
        if os.path.isdir(a):
            for root, _, names in os.walk(a):
                for n in names:
                    if n.startswith('session.v4.jsonl'): yield os.path.join(root, n)
        else: yield a

def text_of(content):
    return ''.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('type') == 'text')

def measure(path):
    calls, per_tool = {}, collections.defaultdict(lambda: {'n': 0, 'bytes': 0, 'over': 0, 'over_bytes': 0, 'max': 0})
    usage = collections.Counter(); steps = 0; first_input = None; prune = 0; pruned_tokens = 0; compactions = 0
    for e in events(path):
        t, d = e.get('type'), e.get('data', {})
        if t == 'assistant/message':
            for b in d['message']['content']:
                if b.get('type') == 'tool-call': calls[b['id']] = b['name']
            u = d.get('usage') or {}
            steps += 1
            if first_input is None: first_input = u.get('inputTokens', 0) + u.get('cacheReadTokens', 0)
            for k in ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'): usage[k] += u.get(k, 0)
        elif t == 'tool/result':
            m = d['message']; s = text_of(m['content']); name = calls.get(m.get('toolCallId'), '?')
            size = len(s.encode()); lines = s.count('\n') + 1; p = per_tool[name]
            p['n'] += 1; p['bytes'] += size; p['max'] = max(p['max'], size)
            if size > BYTES or lines > LINES: p['over'] += 1; p['over_bytes'] += size
        elif t == 'compaction/prune': prune += 1; pruned_tokens += d.get('shadowedTokenCount', 0)
        elif t == 'compaction/end': compactions += 1
    return {'session': path, 'steps': steps, 'first_request_prompt_tokens': first_input, **usage, 'compactions': compactions,
            'prune_events': prune, 'pruned_tokens': pruned_tokens, 'tools': per_tool}

def main():
    args = [a for a in sys.argv[1:] if a != '--json']
    rows = [measure(p) for p in files(args)]
    if '--json' in sys.argv: print(json.dumps(rows, indent=1)); return
    tot = collections.defaultdict(lambda: collections.Counter())
    for r in rows:
        print(f"{os.path.basename(os.path.dirname(os.path.dirname(r['session'])))[-40:]} steps={r['steps']} first={r['first_request_prompt_tokens']} "
              f"in={r.get('inputTokens', 0)} out={r.get('outputTokens', 0)} cacheRead={r.get('cacheReadTokens', 0)} compactions={r['compactions']} pruned={r['pruned_tokens']}")
        for n, p in r['tools'].items():
            for k, v in p.items(): tot[n][k] = max(tot[n][k], v) if k == 'max' else tot[n][k] + v
    print('\ntool                 n    KiB   over  overKiB  max')
    for n, p in sorted(tot.items(), key=lambda kv: -kv[1]['bytes']):
        print(f"{n:20} {p['n']:5} {p['bytes']//1024:6} {p['over']:5} {p['over_bytes']//1024:7} {p['max']}")
main()
