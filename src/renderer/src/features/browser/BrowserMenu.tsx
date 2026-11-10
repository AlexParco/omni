import { useState, type JSX } from 'react'
import type { CookieImportSource } from '@shared/types'
import { useBrowser } from '@/store/browser'
import { VIEWPORT_PRESETS, viewportName } from '@/store/viewport-presets'
import { useUi } from '@/store/ui'
import { Hint } from '@/ui/Hint'
import { CheckMark, Folder, ICON, Inbox, Plus, Settings2, Smartphone, User } from '@/ui/icons'
import { ListPicker, type PickerItem } from '@/ui/ListPicker'

type Page = 'root' | 'profile' | 'cookies' | 'viewport'

const COOKIE_SOURCES: Array<{ id: CookieImportSource; label: string }> = [
  { id: 'chrome', label: 'Chrome' },
  { id: 'arc', label: 'Arc' },
  { id: 'brave', label: 'Brave' },
  { id: 'edge', label: 'Edge' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'safari', label: 'Safari' },
  { id: 'file', label: 'Desde archivo' }
]

const PAGE_TITLE: Record<Exclude<Page, 'root'>, string> = { profile: 'Perfil', cookies: 'Importar cookies', viewport: 'Tamaño de viewport' }

/**
 * Menú `…` de la cabecera del navegador (ARCHITECTURE §3.9): perfil actual con su lista, importar
 * cookies, tamaño de viewport y ajustes. Los submenús son páginas del mismo `ListPicker`: elegir
 * una entrada con `›` cambia de página, Esc vuelve a la raíz y en la raíz cierra.
 */
export function BrowserMenu(): JSX.Element | null {
  const id = useBrowser((s) => s.menuId)
  const state = useBrowser((s) => (id ? s.states[id] : undefined))
  const profiles = useBrowser((s) => s.profiles)
  const measured = useBrowser((s) => (id ? s.viewports[id] : undefined))
  const closeOverlay = useUi((s) => s.closeOverlay)
  const [page, setPage] = useState<Page>('root')
  if (!id) return null
  const browser = useBrowser.getState()
  const check = <CheckMark {...ICON} aria-hidden="true" />
  const profileName = profiles.find((p) => p.id === state?.profileId)?.name ?? 'Por defecto'
  const preset = state?.viewport ?? null

  let items: PickerItem[]
  if (page === 'profile') {
    items = [
      ...profiles.map((p) => ({ id: `profile:${p.id}`, label: p.name, icon: p.id === state?.profileId ? check : undefined })),
      { id: 'profile:new', label: 'Nuevo perfil', icon: <Plus {...ICON} aria-hidden="true" /> }
    ]
  } else if (page === 'cookies') {
    items = COOKIE_SOURCES.map((s) => ({ id: `cookies:${s.id}`, label: s.label, icon: s.id === 'file' ? <Folder {...ICON} aria-hidden="true" /> : undefined }))
  } else if (page === 'viewport') {
    items = [
      { id: 'viewport:', label: 'Responsive', hint: measured ? `${measured.width} × ${measured.height}` : 'todo el pane', icon: preset === null ? check : undefined },
      ...VIEWPORT_PRESETS.map((p) => ({ id: `viewport:${p.id}`, label: p.name, hint: `${p.width} × ${p.height}${p.mobile ? ' · móvil' : ''}`, icon: preset?.id === p.id ? check : undefined }))
    ]
  } else {
    items = [
      { id: 'page:profile', label: `Perfil: ${profileName}`, hint: '›', icon: <User {...ICON} aria-hidden="true" /> },
      { id: 'page:cookies', label: 'Importar cookies', hint: '›', icon: <Inbox {...ICON} aria-hidden="true" /> },
      { id: 'page:viewport', label: 'Tamaño de viewport', hint: `${viewportName(preset)} ›`, icon: <Smartphone {...ICON} aria-hidden="true" /> },
      { id: 'settings', label: 'Ajustes del navegador', icon: <Settings2 {...ICON} aria-hidden="true" /> }
    ]
  }

  const pick = (item: PickerItem): void => {
    const [kind, value] = splitId(item.id)
    if (kind === 'page') {
      setPage(value as Exclude<Page, 'root'>)
      return
    }
    closeOverlay()
    if (kind === 'settings') browser.openSettings(id)
    else if (kind === 'profile') {
      if (value === 'new') browser.openNewProfile(id)
      else void browser.setProfile(id, value)
    } else if (kind === 'cookies') void browser.importCookies(id, value as CookieImportSource)
    else if (kind === 'viewport') void browser.setViewport(id, value ? (VIEWPORT_PRESETS.find((p) => p.id === value) ?? null) : null)
  }

  const footer =
    page === 'cookies' ? (
      <>
        <Hint kbd="Esc">volver</Hint>
        <span>Las sesiones de Google no se importan: inicia sesión en Google dentro de omni</span>
      </>
    ) : page !== 'root' ? (
      <Hint kbd="Esc">volver</Hint>
    ) : undefined

  return (
    <ListPicker
      items={items}
      placeholder={page === 'root' ? 'Navegador' : PAGE_TITLE[page]}
      filter={false}
      footer={footer}
      onClose={() => (page === 'root' ? closeOverlay() : setPage('root'))}
      onPick={pick}
    />
  )
}

/** `profile:abc` → `['profile', 'abc']`; el valor puede llevar `:` dentro. */
function splitId(id: string): [string, string] {
  const i = id.indexOf(':')
  return i < 0 ? [id, ''] : [id.slice(0, i), id.slice(i + 1)]
}
