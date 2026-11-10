# CLAUDE.md — omni

ADE de escritorio operado por teclado. Los agentes (Claude Code, Codex, OpenCode…) corren
tal cual en terminales; omni los supervisa. Referencia de producto: Orca.

## Antes de tocar código

1. Leer `ARCHITECTURE.md`: capas, patrones y convenciones son obligatorios.
2. `DESIGN.md` tiene producto e hitos. El stack vigente es Electron (ver addendum al inicio).

## Reglas que no se negocian

- **Todo es un comando.** Nada de lógica en `onClick` ni en handlers de teclado: se registra
  un `Command` en `app/commands.ts` y se enlaza en `app/keybindings.ts`.
- **IPC solo por `src/shared/ipc.ts`.** Un canal nuevo se declara ahí primero. Strings de canal
  fuera de `shared/ipc.ts`, `main/ipc.ts` y `preload/index.ts` son un bug.
- **main = procesos, renderer = píxeles.** El renderer tiene que poder recargarse sin perder
  sesiones.
- **Colores y tamaños de letra solo en `styles/tokens.css`.** Paleta de Orca; cinco tamaños (`--fs-xs` a `--fs-xl`: 11, 12, 13, 14, 16).
- **UI solo con primitivos de `ui/`** (Row, Dot, Badge, Button/IconButton, Tabs, Strip, Kbd,
  ListPicker, Empty, Switch; ver ARCHITECTURE §3.8). Una feature no inventa clases visuales: compone. Estado
  por `data-*`, CSS al lado del componente, nada de marcos ni acentos laterales para selección.
- **Iconos solo de `ui/icons.tsx`** (lucide-react, tamaño y trazo de `ICON`). Agentes con `AgentIcon`: el logo real de cada uno en un solo color, como Orca (SVG o máscara en `ui/logos/`). El logo de omni es `OmniMark`; la marca y sus reglas, en `design/brand/`.
- **Código en inglés, comentarios y docs en español.** Sin `default export`, sin `any`.
- **Toda UI pasa validación antes de darse por lista**: captura a tamaño real (zoom 1:1) de la zona
  tocada en cada estado (foco terminal/lista, con split, con cursor) y medición del DOM en el e2e
  (texto de un nivel nunca arranca antes que el de su padre, columnas de la derecha alineadas entre
  filas, rellenos separados por aire, nada se desborda). Un reporte de agente no sustituye esa pasada.
- **Nombres de comandos y menús sin puntos suspensivos** ("Abrir proyecto", no "Abrir proyecto…"): el usuario los quiere planos, como en el resto de la app.

## Comandos

```
pnpm dev         # app en desarrollo (OMNI_CWD=<ruta> fija el cwd inicial)
pnpm typecheck   # tsc 7 sobre main/preload y renderer
pnpm test        # unitarios (Vitest): keys, commands, stores
pnpm e2e [filtro] # escenarios contra la app viva (nadie debe estar usándola); requiere OMNI_CDP_PORT=9229 pnpm dev
pnpm e2e:persist # ciclo cerrar/reabrir la app comprobando que el daemon conserva sesiones y estado
pnpm e2e:revive  # apagado simulado de la Mac en un HOME aislado: las sesiones vuelven y los agentes retoman su conversación (§3.10b)
node e2e/cdp.mjs e2e/manual/real-agent.mjs # flujo real con Claude Code de verdad en un worktree (gasta uso; se detiene en el 'Quick safety check' de Claude Code hasta que lo aceptes en el pane y se reanuda al repetirlo)
pnpm build       # electron-vite build → out/
OMNI_CDP_PORT=9229 dist/mac-arm64/omni.app/Contents/MacOS/omni  # app empaquetada con CDP: `pnpm e2e` corre igual (los import('/src/…') pasan por window.__omniImport, solo en testMode)
pnpm package     # electron-builder --mac dir + codesign ad-hoc → dist/mac-arm64/omni.app (notificaciones nativas solo aquí)
pnpm install-app # cierra omni si está abierto, empaqueta e instala en /Applications/omni.app (y lo reabre si estaba abierto)
OMNI_SOCK=~/.config/omni/dev.sock OMNI_CDP_PORT=9229 pnpm dev  # dev con su propio socket mientras el omni instalado sigue abierto; el e2e con el mismo OMNI_SOCK
```

Los MCP: `omni` (`bin/omni-mcp.mjs`) y `omni-browser` (`bin/omni-browser-mcp.mjs`, navegador
manejado por el agente, ARCHITECTURE §3.23). `pnpm e2e browser-mcp` prueba el segundo contra una
página local.

**Cada cambio se prueba antes de reportarlo**: typecheck + `pnpm test`, y si toca teclado, foco,
overlays o layout, un escenario en `e2e/scenarios/` corrido con `pnpm e2e` (ver ARCHITECTURE §5).

## Stack

Electron 44 · electron-vite 5 · Vite 7 · React 19 · TypeScript 7 · zustand · lucide-react ·
xterm.js 6 + node-pty · pnpm 11 (`pnpm-workspace.yaml` autoriza los build scripts nativos).
