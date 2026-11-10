import type { JSX } from 'react'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap, type Layer } from '@/core/keys/keymap'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'
import { usePrefixLabel, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'

const LAYER_ORDER: Layer[] = ['global', 'list', 'worktrees', 'review', 'broadcast', 'editorTree', 'terminal']

/** Hoja de atajos ⌘/: toda la tabla de teclas, agrupada por capa. Elegir una fila corre el comando. */
export function KeySheet(): JSX.Element {
  const closeOverlay = useUi((s) => s.closeOverlay)
  const prefix = useSettings((s) => s.settings.prefix)
  const LAYER_TITLE: Record<Layer, string> = { global: 'Siempre (⌘)', list: 'En la lista', worktrees: 'En Worktrees', review: 'En la revisión', broadcast: 'En Broadcast', editorTree: 'En el árbol del editor', terminal: `En la terminal, tras ${usePrefixLabel()}` }

  const items: PickerItem[] = LAYER_ORDER.flatMap((layer) =>
    keymap.bindings(layer).flatMap(({ chord, commandId }): PickerItem[] => {
      const cmd = commands.get(commandId)
      if (!cmd) return []
      return [{ id: `${layer}:${chord}`, label: cmd.title, group: LAYER_TITLE[layer], kbd: prettyChord(chord, layer === 'terminal' ? prefix : undefined), hint: commandId }]
    })
  )

  return (
    <ListPicker
      items={items}
      placeholder="Atajo o comando"
      onClose={closeOverlay}
      onPick={(item) => {
        closeOverlay()
        void commands.run(item.hint ?? '')
      }}
    />
  )
}
