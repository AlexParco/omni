#!/usr/bin/env bash
# Ciclo de persistencia contra la app real: abrir → crear shell y navegador → cerrar solo la app
# (como ⌘Q, sin tocar el daemon) → reabrir → comprobar, en un HOME de prueba.
set -euo pipefail
cd "$(dirname "$0")/.."
# HOME aislado y corto (la ruta del socket del daemon no puede pasar de 104 caracteres): nunca toca el
# ~/.config/omni real ni el daemon del omni instalado.
SCR="$(mktemp -d /tmp/omni-persist.XXXXXX)"
export HOME="$SCR/home" TMPDIR="$SCR" OMNI_CWD="$SCR/p"
mkdir -p "$HOME/.config/omni" "$OMNI_CWD"
cleanup() {
  close_app
  # Todo daemon con el socket de este HOME (puede haber más de uno si se reinició por versión).
  for pid in $(lsof -t "$HOME/.config/omni/daemon.sock" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
  rm -rf "$SCR"
}
export OMNI_CDP_PORT="${OMNI_CDP_PORT:-9229}"
export OMNI_PERSIST_IDS="${TMPDIR:-/tmp}/omni-persist-ids.json"
LOG="${TMPDIR:-/tmp}/omni-persist-dev.log"

close_app() {
  # Solo la app: el daemon también corre sobre el binario de Electron (con `daemon.js`) y debe quedarse.
  pkill -f "electron-vite.js dev" || true
  for p in $(pgrep -f "Electron.app/Contents/MacOS/Electron" || true); do
    cmd=$(ps -o command= -p "$p" || true)
    case "$cmd" in *daemon.js*|*--type=*) ;; *) kill "$p" 2>/dev/null || true;; esac
  done
  sleep 3
}
trap cleanup EXIT
wait_cdp() { for _ in $(seq 1 40); do sleep 1; curl -sf "http://127.0.0.1:$OMNI_CDP_PORT/json" >/dev/null && { sleep 4; return 0; }; done; echo "la app no levantó"; exit 1; }

close_app
pnpm dev -w >"$LOG" 2>&1 & DEV=$!
wait_cdp
node e2e/cdp.mjs e2e/persist/open.mjs
close_app
wait "$DEV" 2>/dev/null || true
echo "--- app cerrada; daemon: $(python3 -c 'import json;print(json.load(open("'"$HOME"'/.config/omni/daemon.json"))["pid"])') sigue: $(pgrep -fl omni-daemon | wc -l | tr -d ' ')"
pnpm dev -w >"$LOG" 2>&1 & DEV=$!
wait_cdp
node e2e/cdp.mjs e2e/persist/check.mjs
echo "--- listo; se cierra la app de prueba y su daemon"
