import { useState, type JSX } from 'react'
import { displayUrl, useBrowser } from '@/store/browser'
import { VIEWPORT_PRESETS, findPreset, viewportLabel } from '@/store/viewport-presets'
import { useUi } from '@/store/ui'
import { Button } from '@/ui/Button'
import { Dialog, DialogSection } from '@/ui/Dialog'
import { Field } from '@/ui/Field'
import { Hint } from '@/ui/Hint'
import { Select } from '@/ui/Select'

/** Acción destructiva esperando confirmación. */
type Pending = null | 'clear' | 'delete'

/**
 * "Ajustes del navegador" (ARCHITECTURE §3.9): perfil (con Nuevo y Eliminar), tamaño de viewport y
 * borrar los datos del perfil. Las acciones destructivas piden confirmación en la misma fila: el
 * botón pasa a "Confirmar" junto a Cancelar.
 */
export function BrowserSettings(): JSX.Element | null {
  const id = useBrowser((s) => s.menuId)
  const state = useBrowser((s) => (id ? s.states[id] : undefined))
  const profiles = useBrowser((s) => s.profiles)
  const measured = useBrowser((s) => (id ? s.viewports[id] : undefined))
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [pending, setPending] = useState<Pending>(null)
  if (!id) return null
  const browser = useBrowser.getState()
  const profileId = state?.profileId ?? ''
  const profile = profiles.find((p) => p.id === profileId)
  const preset = state?.viewport ?? null

  const confirmRow = (kind: Exclude<Pending, null>, label: string, run: () => void): JSX.Element =>
    pending === kind ? (
      <>
        <Button onClick={() => setPending(null)}>Cancelar</Button>
        <Button
          variant="danger"
          onClick={() => {
            setPending(null)
            run()
          }}
        >
          Confirmar
        </Button>
      </>
    ) : (
      <Button variant="danger" disabled={kind === 'delete' && (!profile || profile.builtin === true)} onClick={() => setPending(kind)}>
        {label}
      </Button>
    )

  return (
    <Dialog
      title="Ajustes del navegador"
      subtitle={displayUrl(state?.url ?? '') || 'about:blank'}
      onClose={closeOverlay}
      footer={
        <>
          <Hint kbd="Esc">cerrar</Hint>
          <span>Los cambios se aplican al instante.</span>
        </>
      }
    >
      <DialogSection title="Perfil">Cada perfil guarda sus propias cookies y datos de sitios. Al cambiar de perfil, la página se recarga.</DialogSection>
      <Field label="Perfil" description="Con el que navega este pane.">
        <Select label="Perfil" value={profileId} options={profiles.map((p) => ({ value: p.id, label: p.name }))} onChange={(v) => void browser.setProfile(id, v)} />
        <Button
          onClick={() => {
            closeOverlay()
            browser.openNewProfile(id)
          }}
        >
          Nuevo
        </Button>
      </Field>
      <Field label="Eliminar perfil" description='Borra el perfil y todos sus datos. "Por defecto" no se puede eliminar.'>
        {confirmRow('delete', 'Eliminar', () => void browser.deleteProfile(id, profileId))}
      </Field>

      <DialogSection title="Viewport">Responsive usa todo el espacio del pane. Los tamaños de móvil también simulan la pantalla táctil y el user agent del dispositivo.</DialogSection>
      <Field label="Tamaño de viewport" description={viewportLabel(preset, measured) ? `Ahora: ${viewportLabel(preset, measured)}` : undefined}>
        <Select
          label="Tamaño de viewport"
          value={preset?.id ?? ''}
          options={[{ value: '', label: 'Responsive' }, ...VIEWPORT_PRESETS.map((p) => ({ value: p.id, label: `${p.name} · ${p.width} × ${p.height}` }))]}
          onChange={(v) => void browser.setViewport(id, v ? (findPreset(v) ?? null) : null)}
        />
      </Field>

      <DialogSection title="Datos" />
      <Field label="Borrar datos del perfil" description="Borra cookies, datos de sitios y caché del perfil actual. Cierra la sesión en todas las páginas.">
        {confirmRow('clear', 'Borrar datos', () => void browser.clearData(id))}
      </Field>
    </Dialog>
  )
}
