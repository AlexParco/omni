import type { JSX } from 'react'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap, type Layer } from '@/core/keys/keymap'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { currentPrefix } from '@/store/settings'
import { useUi } from '@/store/ui'

/** Atajo a mostrar para un comando: primero el de la capa donde está el foco, luego ⌘. */
export function hintFor(commandId: string, focus: 'list' | 'terminal'): string | undefined {
  const chords = keymap.chordsFor(commandId)
  const order: Layer[] = focus === 'terminal' ? ['global', 'terminal'] : ['list', 'global', 'terminal']
  for (const layer of order) {
    const hit = chords.find((c) => c.layer === layer)
    if (hit) return prettyChord(hit.chord, layer === 'terminal' ? currentPrefix() : undefined)
  }
  return undefined
}

/** Paleta ⌘K: lista el registro de comandos disponibles y corre el elegido. */
export function Palette(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const focus = useUi((s) => s.focus)

  const items: PickerItem[] = commands.list().map((c) => ({ id: c.id, label: c.title, group: c.group, kbd: hintFor(c.id, focus) }))

  return (
    <ListPicker
      items={items}
      placeholder="Comando"
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        void commands.run(item.id)
      }}
    />
  )
}
