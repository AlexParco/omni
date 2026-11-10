import type { JSX } from 'react'
import type { AgentId } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { AgentIcon } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { hintFor } from '@/features/palette/Palette'
import { SKIP_PERMISSIONS, useSessions } from '@/store/sessions'
import { useUi } from '@/store/ui'
import { useWorktrees } from '@/store/worktrees'

/**
 * Menú ⌘T / split: elige qué abrir (terminal, navegador o agente) y dónde cae según `launchTarget`.
 * ⌥⏎ lanza el agente con su flag de "sin pedir permisos" (`SKIP_PERMISSIONS`); el modo se deja en
 * `ui.launchMode` y lo consume el comando `session.new.*`, como el destino. ⇧⏎ lo lanza en un worktree
 * nuevo (`<badge>-<n>`, ARCHITECTURE §3.15): la marca queda en `worktrees.launchInNew` y la consume el
 * mismo comando antes de crear la sesión.
 */
export function Launcher(): JSX.Element {
  const agents = useSessions((s) => s.agents)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const setLaunchMode = useUi((s) => s.setLaunchMode)
  const setLaunchInNew = useWorktrees((s) => s.setLaunchInNew)
  const pendingWorktree = useWorktrees((s) => s.pendingLaunch)
  const target = useUi((s) => s.launchTarget)
  const placeholder = target === 'tab' ? 'Abrir en tab nuevo' : target === 'split-right' ? 'Abrir a la derecha' : 'Abrir abajo'

  // El navegador, el editor y la vista previa no son agentes: van aparte, en "Herramientas".
  const isTool = (id: AgentId): boolean => id === 'browser' || id === 'editor' || id === 'preview'
  const items: PickerItem[] = agents.map((a) => ({
    id: a.id,
    label: a.id === 'shell' ? 'Nueva terminal' : a.id === 'browser' ? 'Nuevo navegador' : a.name,
    icon: <AgentIcon agent={a.id} />,
    hint: a.command ?? undefined,
    kbd: a.id === 'shell' ? hintFor('launcher.open', 'terminal') : hintFor(`session.new.${a.id}`, 'terminal'),
    group: a.id === 'shell' ? undefined : isTool(a.id) ? 'Herramientas' : 'Agentes'
  }))

  return (
    <ListPicker
      items={items}
      placeholder={placeholder}
      onClose={closeOverlay}
      onPick={(item, mods) => {
        const agent = item.id as AgentId
        // Editor y vista previa no lanzan un proceso: piden una ruta (ARCHITECTURE §3.19) y caen donde apuntaba el launcher.
        if (agent === 'editor' || agent === 'preview') {
          void commands.run(agent === 'editor' ? 'editor.openPath' : 'editor.openPreviewPath')
          return
        }
        if (mods.alt && SKIP_PERMISSIONS[agent]) setLaunchMode('yolo')
        // Un navegador no edita código: no tiene sentido darle un worktree. Con uno ya en espera, ⇧ no crea otro.
        if (mods.shift && agent !== 'browser' && pendingWorktree === null) setLaunchInNew(true)
        void commands.run(`session.new.${agent}`)
      }}
      footer={
        <>
          <span>
            <Kbd>⏎</Kbd> terminal aquí con el CLI
          </span>
          <span>
            <Kbd>⌥⏎</Kbd> sin pedir permisos
          </span>
          {pendingWorktree === null && (
            <span>
              <Kbd>⇧⏎</Kbd> en worktree nuevo
            </span>
          )}
          <span>
            <Kbd>↑↓</Kbd> moverse
          </span>
          <span>
            <Kbd>Esc</Kbd> cerrar
          </span>
        </>
      }
    />
  )
}
