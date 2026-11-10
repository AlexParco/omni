#!/usr/bin/env bash
# "Actualizar terminales" (ARCHITECTURE §3.10c) contra la app real, aislada en un HOME de prueba: un
# daemon de un build "viejo" con un shell abierto; la app de otro build lo conserva (como la empaquetada),
# avisa en el pie y, al confirmar, lo reemplaza y la sesión vuelve con su id y su pantalla.
set -euo pipefail
cd "$(dirname "$0")/.."
SCR="$(mktemp -d /tmp/omni-upgrade.XXXXXX)"
SCR="$(cd "$SCR" && pwd -P)"
export HOME="$SCR/home"
export OMNI_CDP_PORT="${OMNI_CDP_PORT:-9229}"
export OMNI_SOCK="$SCR/control.sock"
export OMNI_CWD="$SCR/proyecto"
export OMNI_UPGRADE_IDS="$SCR/ids.json"
LOG="$SCR/dev.log"
mkdir -p "$HOME/.config/omni" "$OMNI_CWD"

daemon_pid() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["pid"])' "$HOME/.config/omni/daemon.json" 2>/dev/null || true; }
dev_pids() {
  pgrep -f "electron-vite" || true
  for p in $(pgrep -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" || true); do
    ps -o command= -p "$p" | grep -q daemon.js || echo "$p"
  done
}
wait_cdp() { for _ in $(seq 1 60); do sleep 1; curl -sf "http://127.0.0.1:$OMNI_CDP_PORT/json" >/dev/null && { sleep 4; return 0; }; done; echo "la app no levantó; log en $LOG"; exit 1; }
stop_app() { for p in $(dev_pids); do kill "$p" 2>/dev/null || true; done; sleep 3; }
cleanup() {
  stop_app
  local d; d="$(daemon_pid)"; [ -n "$d" ] && kill -9 "$d" 2>/dev/null || true
  [ -n "${KEEP:-}" ] && echo "--- datos en $SCR" || rm -rf "$SCR"
}
trap cleanup EXIT

if curl -sf "http://127.0.0.1:$OMNI_CDP_PORT/json" >/dev/null; then echo "el puerto $OMNI_CDP_PORT ya está en uso: cierra el otro pnpm dev"; exit 1; fi

(OMNI_TEST_BUILD=viejo pnpm dev >"$LOG" 2>&1 &); wait_cdp
node e2e/cdp.mjs e2e/upgrade/open.mjs
OLD="$(daemon_pid)"
stop_app
echo "--- app cerrada; daemon viejo $OLD sigue vivo"

(OMNI_TEST_BUILD=nuevo OMNI_KEEP_DAEMON=1 pnpm dev >>"$LOG" 2>&1 &); wait_cdp
node e2e/cdp.mjs e2e/upgrade/check.mjs
NEW="$(daemon_pid)"
[ "$OLD" != "$NEW" ] && ! kill -0 "$OLD" 2>/dev/null || { echo "el daemon viejo ($OLD) no se reemplazó (ahora $NEW)"; exit 1; }
echo "--- daemon $OLD → $NEW; upgrade: ok"
