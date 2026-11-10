#!/usr/bin/env bash
# Compila omni y lo instala en /Applications (pnpm install-app).
#
# 1. Si omni está abierto (el instalado o el de dist/), lo cierra con un quit normal: las sesiones
#    viven en el daemon y sobreviven. Si no se cierra en 15 s, aborta sin tocar nada.
# 2. `pnpm package` → dist/mac-arm64/omni.app (firma ad-hoc).
# 3. Reemplaza /Applications/omni.app con `ditto` (conserva permisos, symlinks y la firma).
# 4. Si estaba abierto, lo vuelve a abrir.
#
# El daemon de un build anterior sigue vivo para no matar sesiones: los arreglos del daemon entran
# tras "Apagar todo" (ARCHITECTURE §3.10).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILT="$ROOT/dist/mac-arm64/omni.app"
TARGET="/Applications/omni.app"

running() {
  pgrep -f "$TARGET/Contents/MacOS/omni" >/dev/null 2>&1 || pgrep -f "$BUILT/Contents/MacOS/omni" >/dev/null 2>&1
}

was_running=0
if running; then
  was_running=1
  echo "→ Cerrando omni (las sesiones siguen en el daemon)"
  osascript -e 'tell application id "pe.alexander.omni" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    running || break
    sleep 0.5
  done
  if running; then
    echo "✗ omni sigue abierto (¿un diálogo pendiente?). Ciérralo y vuelve a correr pnpm install-app." >&2
    exit 1
  fi
fi

echo "→ Compilando"
cd "$ROOT"
pnpm -s package

echo "→ Instalando en $TARGET"
rm -rf "$TARGET"
ditto "$BUILT" "$TARGET"

echo "✓ omni instalado en $TARGET"
if [ "$was_running" = 1 ]; then
  echo "→ Abriendo omni"
  open "$TARGET"
fi
