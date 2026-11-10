import type { JSX } from 'react'
import { commands } from '@/core/commands/registry'
import { prettyChord } from '@/core/keys/chord'
import { keymap } from '@/core/keys/keymap'
import { IconButton } from '@/ui/Button'
import { ICON, OmniMark, PanelLeft, Settings } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { useControl } from '@/store/control'
import { useCost } from '@/store/cost'
import { todayLabel } from '@/store/cost-logic'
import { useSettings } from '@/store/settings'
import { useDaemon } from '@/store/daemon'

/** Atajo global vigente de un comando, formateado; vacío si no tiene. */
function globalKey(id: string): string | undefined {
  const chord = keymap.chordsFor(id).find((c) => c.layer === 'global')?.chord
  return chord ? prettyChord(chord) : undefined
}

/**
 * Cabecera de la ventana a la altura del semáforo de macOS: botón del sidebar, nombre y, al borde
 * derecho, el engranaje de Ajustes (como en cualquier app; los atajos viven dentro de Ajustes). Con
 * el sidebar visible vive en su cabecera; con el sidebar oculto (⌘B) es la única fila superior y suma
 * el buscador. Es zona de arrastre de la ventana.
 */
export function WindowHead({ sidebarVisible }: { sidebarVisible: boolean }): JSX.Element {
  useSettings((s) => s.settings.keys)
  const toggleKey = globalKey('sidebar.toggle')
  const settingsKey = globalKey('settings.open')
  const label = sidebarVisible ? 'Ocultar sidebar' : 'Mostrar sidebar'
  return (
    <div className="window-head">
      <IconButton label={label} title={toggleKey ? `${label} (${toggleKey})` : label} onClick={() => void commands.run('sidebar.toggle')}>
        <PanelLeft {...ICON} aria-hidden="true" />
      </IconButton>
      <span className="window-head__name">
        <OmniMark size={14} />
        omni
      </span>
      <span className="window-head__end">
        <IconButton label="Ajustes" title={settingsKey ? `Ajustes y atajos (${settingsKey})` : 'Ajustes y atajos'} onClick={() => void commands.run('settings.open')}>
          <Settings {...ICON} aria-hidden="true" />
        </IconButton>
      </span>
    </div>
  )
}

/** Fila superior solo con el sidebar oculto: cabecera de la ventana y buscador. */
export function TitleBar(): JSX.Element {
  useSettings((s) => s.settings.keys)
  const searchKey = globalKey('quickopen.open')
  return (
    <div className="titlebar">
      <WindowHead sidebarVisible={false} />
      <button className="titlebar__search" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('quickopen.open')}>
        <span>Buscar</span>
        {searchKey && <Kbd>{searchKey}</Kbd>}
      </button>
    </div>
  )
}

/**
 * Estado global en el pie, a la derecha: el aviso breve sin pane con foco (`useControl.banner`) y el costo de hoy (§3.17) cuando hay algo registrado.
 */
export function StatusBar(): JSX.Element {
  const banner = useControl((s) => s.banner)
  const cost = useCost((s) => todayLabel(s.summary))
  useSettings((s) => s.settings.keys)
  const usageKey = globalKey('usage.toggle')
  const withUsageKey = (text: string): string => (usageKey ? `${text} (${usageKey})` : text)
  const bannerText = banner ? (banner.body ? `${banner.title}: ${banner.body}` : banner.title) : null
  const outdated = useDaemon((s) => s.outdated)
  const upgrading = useDaemon((s) => s.upgrading)
  return (
    <span className="status-bar">
      {/* Daemon de otro build (§3.10c): la app instalada lo conserva para no matar sesiones; se actualiza cuando el usuario quiera. */}
      {(outdated || upgrading) && (
        <button
          className="status-bar__notice"
          tabIndex={-1}
          disabled={upgrading}
          title="Las terminales corren en un proceso de una versión anterior de omni. Actualizarlas las reabre y los agentes retoman su conversación."
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void commands.run('daemon.upgrade')}
        >
          {upgrading ? 'Actualizando terminales' : 'Actualizar terminales'}
        </button>
      )}
      {bannerText && (
        <span className="status-bar__banner" role="status" title={bannerText}>
          {bannerText}
        </span>
      )}
      {cost && (
        <button className="status-bar__cost" tabIndex={-1} title={withUsageKey('Uso de hoy por agente y topes del plan')} onMouseDown={(e) => e.preventDefault()} onClick={() => void commands.run('usage.toggle')}>
          {cost}
        </button>
      )}
    </span>
  )
}
