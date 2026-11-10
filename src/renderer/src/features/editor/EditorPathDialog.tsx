import { useState, type JSX } from 'react'
import { useDocs } from '@/store/docs'
import { shortPath, useSessions } from '@/store/sessions'
import { Button } from '@/ui/Button'
import { Dialog } from '@/ui/Dialog'
import { Hint } from '@/ui/Hint'
import { TextInput } from '@/ui/TextInput'
import './editor-path.css'

/**
 * Diálogo "Abrir en el editor / vista previa" (launcher → Editor, ARCHITECTURE §3.19): pide una
 * ruta relativa al workspace actual (o absoluta) y abre el documento donde el launcher apuntaba
 * (tab o split). El error de main (archivo que no existe, fuera del workspace) se muestra debajo.
 */
export function EditorPathDialog(): JSX.Element | null {
  const dialog = useDocs((s) => s.pathDialog)
  const closePathDialog = useDocs((s) => s.closePathDialog)
  const openFromDialog = useDocs((s) => s.openFromDialog)
  const workspace = useSessions((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId))
  const [value, setValue] = useState('')
  if (!dialog || !workspace) return null
  const valid = value.trim().length > 0
  const title = dialog.kind === 'editor' ? 'Abrir en el editor' : 'Abrir en la vista previa'

  return (
    <Dialog
      title={title}
      subtitle={`Ruta relativa a ${shortPath(workspace.path)}`}
      onClose={closePathDialog}
      footer={
        <>
          <Hint kbd="⏎">abrir</Hint>
          <Hint kbd="Esc">cancelar</Hint>
          <span className="editor-path__actions">
            <Button onClick={closePathDialog}>Cancelar</Button>
            <Button variant="primary" disabled={!valid} onClick={() => void openFromDialog(value)}>
              Abrir
            </Button>
          </span>
        </>
      }
    >
      <div className="editor-path">
        <TextInput label="Ruta del archivo" value={value} placeholder="src/index.ts" autoFocus onChange={setValue} onSubmit={(v) => void openFromDialog(v)} />
        {dialog.error && <div className="editor-path__error">{dialog.error}</div>}
      </div>
    </Dialog>
  )
}
