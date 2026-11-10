#!/usr/bin/python3
# Claude Code de mentira para `pnpm e2e:revive`: escribe su transcript donde lo deja el real
# (~/.claude/projects/<cwd codificado>/<id>.jsonl), su registro de proceso
# (~/.claude/sessions/<pid>.json con el sessionId en curso) e imprime cómo lo lanzaron.
# Una línea `/resume <id>` cambia de conversación como el real. No gasta uso.
import json, os, re, sys
args = sys.argv[1:]
home = os.path.join(os.environ['HOME'], '.claude')
def flag(name):
    return args[args.index(name) + 1] if name in args and args.index(name) + 1 < len(args) else None
def transcript(sid):
    d = os.path.join(home, 'projects', re.sub(r'[^A-Za-z0-9]', '-', os.getcwd()))
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, sid + '.jsonl'), 'a').write('{"type":"user"}\n')
def register(sid):
    d = os.path.join(home, 'sessions')
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, '%d.json' % os.getpid()), 'w').write(json.dumps({'pid': os.getpid(), 'sessionId': sid, 'cwd': os.getcwd()}))
sid, resumed = flag('--session-id'), flag('--resume')
if sid:
    transcript(sid)
    register(sid)
    print('FAKE-CLAUDE nueva ' + sid, flush=True)
elif resumed:
    register(resumed)
    print('FAKE-CLAUDE retoma ' + resumed, flush=True)
else:
    print('FAKE-CLAUDE sin id', flush=True)
for line in sys.stdin:
    m = re.match(r'\s*/resume ([0-9a-f-]{36})', line)
    if m:
        transcript(m.group(1))
        register(m.group(1))
        print('FAKE-CLAUDE cambió a ' + m.group(1), flush=True)
