#!/usr/bin/python3
# Codex de mentira para `pnpm e2e:revive`: al lanzarse deja un rollout con su `session_meta` (id
# UUIDv7 con la hora de lanzamiento, cwd real) en ~/.codex/sessions/AAAA/MM/DD como el real.
import json, os, secrets, sys, time
from datetime import datetime, timezone
args = sys.argv[1:]
if args[:1] == ['resume'] and len(args) > 1:
    print('FAKE-CODEX retoma ' + args[1], flush=True)
else:
    ms = int(time.time() * 1000)
    h = '%012x' % ms + '7' + secrets.token_hex(2)[:3] + '8' + secrets.token_hex(8)[:15]
    sid = '%s-%s-%s-%s-%s' % (h[:8], h[8:12], h[12:16], h[16:20], h[20:32])
    now = datetime.now()
    d = os.path.join(os.environ['HOME'], '.codex', 'sessions', now.strftime('%Y'), now.strftime('%m'), now.strftime('%d'))
    os.makedirs(d, exist_ok=True)
    ts = datetime.fromtimestamp(ms / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.') + '%03dZ' % (ms % 1000)
    meta = {'timestamp': ts, 'type': 'session_meta', 'payload': {'id': sid, 'timestamp': ts, 'cwd': os.path.realpath(os.getcwd()), 'originator': 'codex-tui', 'thread_source': 'user'}}
    open(os.path.join(d, 'rollout-%s-%s.jsonl' % (now.strftime('%Y-%m-%dT%H-%M-%S'), sid)), 'w').write(json.dumps(meta) + '\n')
    print('FAKE-CODEX nueva ' + sid, flush=True)
while True:
    time.sleep(3600)
