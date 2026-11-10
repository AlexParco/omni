#!/usr/bin/env bash
# Revivir tras un reinicio (ARCHITECTURE §3.10b) contra la app real, aislada en un HOME de prueba
# (no toca el omni del usuario ni su daemon): abre un shell, un Claude Code y un Codex de mentira,
# mata daemon y app como un apagado de la Mac (SIGTERM a todo a la vez), reabre y comprueba que las
# sesiones vuelven con su id y que cada agente retoma su conversación. Al final, "Apagar todo" y
# un arranque más: no revive nada.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
# Ruta corta: el socket Unix del daemon no puede pasar de 104 caracteres en macOS.
SCR="$(mktemp -d /tmp/omni-revive.XXXXXX)"
SCR="$(cd "$SCR" && pwd -P)"
export HOME="$SCR/home"
export OMNI_CDP_PORT="${OMNI_CDP_PORT:-9229}"
export OMNI_SOCK="$SCR/control.sock"
export OMNI_CWD="$SCR/proyecto"
export OMNI_REVIVE_IDS="$SCR/ids.json"
LOG="$SCR/dev.log"
mkdir -p "$HOME/.config/omni" "$OMNI_CWD"
# Los agentes de prueba reemplazan a los reales por agents.json: nada gasta uso.
cat >"$HOME/.config/omni/agents.json" <<JSON
[{ "id": "claude", "command": "$ROOT/e2e/revive/fake-claude.py" }, { "id": "codex", "command": "$ROOT/e2e/revive/fake-codex.py" }]
JSON

daemon_pid() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$HOME/.config/omni/daemon.json" 2>/dev/null || true; }
dev_pids() {
  # Solo la app de este HOME: el `pnpm dev` lanzado aquí y sus Electron (no el omni instalado).
  pgrep -f "electron-vite" || true
  for p in $(pgrep -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" || true); do
    ps -o command= -p "$p" | grep -q daemon.js || echo "$p"
  done
}
wait_cdp() { for _ in $(seq 1 60); do sleep 1; curl -sf "http://127.0.0.1:$OMNI_CDP_PORT/json" >/dev/null && { sleep 4; return 0; }; done; echo "la app no levantó; log en $LOG"; exit 1; }
start_app() { (pnpm dev >"$LOG" 2>&1 &); wait_cdp; }
stop_app() { for p in $(dev_pids); do kill "$p" 2>/dev/null || true; done; sleep 3; }
cleanup() {
  stop_app
  local d; d="$(daemon_pid)"; [ -n "$d" ] && kill -9 "$d" 2>/dev/null || true
  [ -n "${KEEP:-}" ] && echo "--- datos en $SCR" || rm -rf "$SCR"
}
trap cleanup EXIT

if curl -sf "http://127.0.0.1:$OMNI_CDP_PORT/json" >/dev/null; then echo "el puerto $OMNI_CDP_PORT ya está en uso: cierra el otro pnpm dev"; exit 1; fi

start_app
node e2e/cdp.mjs e2e/revive/open.mjs

# Apagado de la Mac: launchd manda SIGTERM a todo a la vez (shells, daemon, app).
D="$(daemon_pid)"
echo "--- apagado simulado (daemon $D)"
for p in $(pgrep -P "$D" || true) "$D" $(dev_pids); do kill -TERM "$p" 2>/dev/null || true; done
sleep 4
kill -9 "$D" 2>/dev/null || true
python3 - "$HOME/.config/omni/sessions.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print('--- sessions.json tras el apagado:', len(s), 'sesiones')
sys.exit(0 if len(s) == 3 else 1)
PY

start_app
node e2e/cdp.mjs e2e/revive/check.mjs

# "Apagar todo" es a propósito: el próximo arranque no revive nada.
node e2e/cdp.mjs e2e/revive/shutdown.mjs || true
sleep 3
python3 - "$HOME/.config/omni/sessions.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
print('--- tras Apagar todo:', len(s), 'sesiones en el registro')
sys.exit(0 if len(s) == 0 else 1)
PY
echo "--- revive: ok"
