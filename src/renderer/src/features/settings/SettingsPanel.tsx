import { hostStateLabel, useHosts } from '@/store/hosts'
import { humanError } from '@/store/control-logic'
import { useCallback, useState, type JSX } from 'react'
import { DEFAULT_SETTINGS, TERMINAL_FONTS, TERMINAL_FONT_WEIGHTS, TERMINAL_LINE_HEIGHTS, TERMINAL_SCROLL_SPEEDS, type TerminalFontId, type TerminalFontWeight } from '@shared/types'
import { commands } from '@/core/commands/registry'
import { prettyChord, prettyKey, type Chord } from '@/core/keys/chord'
import { keymap, type Layer } from '@/core/keys/keymap'
import { Dialog, DialogSection } from '@/ui/Dialog'
import { Field } from '@/ui/Field'
import { Button, IconButton } from '@/ui/Button'
import { ICON_SM, Minus, Plus, RotateCcw } from '@/ui/icons'
import { Kbd } from '@/ui/Kbd'
import { KeyCapture } from '@/ui/KeyCapture'
import { Select } from '@/ui/Select'
import { Switch } from '@/ui/Switch'
import { fontInstalled } from '@/lib/fonts'
import { BINDING_ROWS, bindingKey, defaultChords, effectiveChords, validateChordFor } from '@/app/keybindings'
import { notifyFlags, notifySetting, sendTestNotification } from '@/store/notify'
import { usePrefixLabel, useSettings } from '@/store/settings'
import { useUi } from '@/store/ui'

const FONT_MIN = 9
const FONT_MAX = 24
/** Qué dice la fila "Probar" según el resultado del aviso de ejemplo. */
const TEST_HINT = 'Manda un aviso de ejemplo para ver cómo llega.'
const SYSTEM_PATH = 'Ajustes del Sistema → Notificaciones → omni'

const LINE_HEIGHT_LABEL: Record<number, string> = { 1: 'Pegadas (1.0)', 1.1: 'Un poco de aire (1.1)', 1.2: 'Aireadas (1.2)', 1.3: 'Amplias (1.3)' }
const LINE_HEIGHT_OPTIONS = TERMINAL_LINE_HEIGHTS.map((h) => ({ value: String(h), label: LINE_HEIGHT_LABEL[h] ?? String(h) }))
const WEIGHT_LABEL: Record<TerminalFontWeight, string> = { 300: 'Fino (300)', 400: 'Normal (400)', 500: 'Medio (500)', 600: 'Seminegrita (600)' }
const WEIGHT_OPTIONS = TERMINAL_FONT_WEIGHTS.map((w) => ({ value: String(w), label: WEIGHT_LABEL[w] }))
const SCROLL_LABEL: Record<number, string> = { 1: 'Lento (1×)', 1.5: 'Medio (1.5×)', 2: 'Normal (2×)', 3: 'Rápido (3×)', 4: 'Máximo (4×)' }
const SCROLL_OPTIONS = TERMINAL_SCROLL_SPEEDS.map((v) => ({ value: String(v), label: SCROLL_LABEL[v] ?? `${v}×` }))
const isTerminalFont = (v: string): v is TerminalFontId => Object.hasOwn(TERMINAL_FONTS, v)
/** Fuentes instaladas (Geist Mono viene con omni, Menlo con macOS); la elegida se lista aunque falte, para no esconder el valor actual. */
function installedFonts(current: TerminalFontId): Array<{ value: string; label: string }> {
  return (Object.keys(TERMINAL_FONTS) as TerminalFontId[])
    .filter((id) => id === current || id === 'geist-mono' || fontInstalled(TERMINAL_FONTS[id].family))
    .map((id) => ({ value: id, label: TERMINAL_FONTS[id].name }))
}
const LAYER_TITLE: Record<Layer, string> = { global: 'Globales (⌘)', list: 'En la lista', terminal: 'En la terminal, tras el prefijo', worktrees: 'En Worktrees', review: 'En la revisión', broadcast: 'En Broadcast', editorTree: 'En el árbol del editor' }
const LAYER_DESC: Record<Layer, string> = {
  global: 'Valen con cualquier foco. Llevan ⌘ para no robarle teclas a la terminal.',
  list: 'Teclas sueltas, estilo vim, con el teclado en el sidebar.',
  terminal: 'La tecla que va después del prefijo, como en tmux.',
  worktrees: 'Teclas sueltas con la vista Worktrees en pantalla.',
  review: 'Teclas sueltas con la revisión de un worktree en pantalla.',
  broadcast: 'Teclas sueltas con la vista Broadcast en pantalla.',
  editorTree: 'Teclas sueltas con el árbol lateral de un editor (⌘E) enfocado.'
}
const LAYERS: Layer[] = ['global', 'list', 'terminal', 'worktrees', 'review', 'broadcast', 'editorTree']

/** Mismo criterio que `sanitize` en main: ctrl o alt obligatorios, nunca ⌘ (reservado a lo global). */
function validatePrefix(chord: Chord): string | null {
  const parts = chord.split('+')
  const key = parts.pop() ?? ''
  if (parts.includes('cmd')) return '⌘ está reservado a los atajos globales'
  if (!parts.includes('ctrl') && !parts.includes('alt')) return 'Debe llevar ctrl o alt'
  if (key.length !== 1) return 'Usa una letra, número o símbolo'
  return null
}

/** Ajustes (⌘,): cada cambio se manda a main, que valida, guarda y lo devuelve aplicado. */
export function SettingsPanel(): JSX.Element {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const fontOptions = installedFonts(settings.terminalFont)
  const closeOverlay = useUi((s) => s.closeOverlay)
  const prefixLabel = usePrefixLabel()
  const [query, setQuery] = useState('')
  const flags = notifyFlags(settings.notifications)
  const [testing, setTesting] = useState(false)
  const [testHint, setTestHint] = useState(TEST_HINT)
  const hosts = useHosts((st) => st.hosts)
  const hostStatus = useHosts((st) => st.status)
  const [hostError, setHostError] = useState<string | null>(null)
  const runTest = async (): Promise<void> => {
    setTesting(true)
    const r = await sendTestNotification()
    setTesting(false)
    setTestHint(r.ok ? `Enviado. ¿No apareció? Actívalo en ${SYSTEM_PATH}.` : `No llegó: ${r.error ?? 'error desconocido'}. Actívalo en ${SYSTEM_PATH}.`)
  }
  const setPrefix = useCallback((prefix: Chord) => void update({ prefix }), [update])
  const bump = (delta: number): void => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, settings.terminalFontSize + delta))
    if (next !== settings.terminalFontSize) void update({ terminalFontSize: next })
  }

  const q = query.trim().toLowerCase()
  const rows = BINDING_ROWS.map((r) => ({ ...r, title: commands.get(r.command)?.title ?? r.command })).filter(
    (r) => !q || r.title.toLowerCase().includes(q) || r.command.toLowerCase().includes(q) || effectiveChords(settings, r.layer, r.command).some((c) => prettyChord(c).toLowerCase().includes(q))
  )
  const setKey = (layer: Layer, command: string, chords: Chord[] | null): void => {
    const { [bindingKey(layer, command)]: _drop, ...rest } = settings.keys
    void update({ keys: chords ? { ...rest, [bindingKey(layer, command)]: chords } : rest })
  }
  /** Capa + choque con otro comando de la misma capa. */
  const validateFor =
    (layer: Layer, command: string) =>
    (chord: Chord): string | null => {
      const byLayer = validateChordFor(layer, chord)
      if (byLayer) return byLayer
      const taken = keymap.resolve([layer], chord)
      if (taken && taken !== command) return `Ya lo usa "${commands.get(taken)?.title ?? taken}"`
      return null
    }

  return (
    <Dialog
      title="Ajustes"
      subtitle="~/.config/omni/settings.json"
      filter={{ value: query, placeholder: 'Buscar atajo o comando', onChange: setQuery }}
      onClose={closeOverlay}
      footer={
        <>
          <span>
            <Kbd>Esc</Kbd> cerrar
          </span>
          <span>Se guarda al instante. Para cambiar un atajo, haz clic y presiona la combinación nueva.</span>
        </>
      }
    >
      {!q && (
        <>
          <DialogSection title="Terminal" />
          <Field
            label="Prefijo"
            description={
              <>
                Como en tmux: lo presionas y la tecla siguiente es un comando. Dos veces seguidas llega a la terminal. Por defecto: <Kbd>{prettyChord(DEFAULT_SETTINGS.prefix)}</Kbd>.
              </>
            }
          >
            <KeyCapture value={settings.prefix} validate={validatePrefix} onChange={setPrefix} />
          </Field>
          <Field label="Tamaño de letra" description={`De ${FONT_MIN} a ${FONT_MAX} px. Por defecto: ${DEFAULT_SETTINGS.terminalFontSize}.`}>
            <IconButton size="sm" label="Achicar la letra" onClick={() => bump(-1)}>
              <Minus {...ICON_SM} aria-hidden="true" />
            </IconButton>
            <span className="field__value" aria-live="polite">
              {settings.terminalFontSize}
            </span>
            <IconButton size="sm" label="Agrandar la letra" onClick={() => bump(1)}>
              <Plus {...ICON_SM} aria-hidden="true" />
            </IconButton>
          </Field>
          <Field label="Fuente" description="Solo la de la terminal. Se listan las instaladas en este Mac. Por defecto: Menlo, como Orca.">
            <Select
              label="Fuente de la terminal"
              value={settings.terminalFont}
              options={fontOptions}
              onChange={(v) => {
                if (isTerminalFont(v)) void update({ terminalFont: v })
              }}
            />
          </Field>
          <Field label="Interlineado" description="Aire entre líneas de la terminal. Pegadas (1.0) es como Terminal.app y Orca.">
            <Select label="Interlineado de la terminal" value={String(settings.terminalLineHeight)} options={LINE_HEIGHT_OPTIONS} onChange={(v) => void update({ terminalLineHeight: Number(v) })} />
          </Field>
          <Field label="Grosor" description="Del texto normal; el negrito va más grueso.">
            <Select
              label="Grosor del texto de la terminal"
              value={String(settings.terminalFontWeight)}
              options={WEIGHT_OPTIONS}
              onChange={(v) => {
                const w = TERMINAL_FONT_WEIGHTS.find((x) => String(x) === v)
                if (w !== undefined) void update({ terminalFontWeight: w })
              }}
            />
          </Field>
          <Field label="Velocidad del scroll" description="Cuánto avanza la terminal con cada gesto del trackpad o la rueda. Con ⌥ va 5 veces más rápido.">
            <Select
              label="Velocidad del scroll de la terminal"
              value={String(settings.terminalScrollSpeed)}
              options={SCROLL_OPTIONS}
              onChange={(v) => {
                const speed = TERMINAL_SCROLL_SPEEDS.find((x) => String(x) === v)
                if (speed !== undefined) void update({ terminalScrollSpeed: speed })
              }}
            />
          </Field>
          <DialogSection title="Sesiones">Lo que pasa con las terminales al apagar o reiniciar la Mac.</DialogSection>
          <Field label="Revivir al reiniciar" description="Vuelve a abrir cada terminal en su carpeta y cada agente retoma su conversación (Claude Code, Codex, OpenCode, Hermes). Apagar todo no revive nada.">
            <Switch label="Revivir las sesiones al reiniciar" on={settings.reviveSessions} onChange={(reviveSessions) => void update({ reviveSessions })} />
          </Field>
          <Field label="Abrir al iniciar sesión" description="omni se abre solo al prender la Mac. Solo en la app instalada.">
            <Switch label="Abrir omni al iniciar sesión" on={settings.openAtLogin} onChange={(openAtLogin) => void update({ openAtLogin })} />
          </Field>
          <DialogSection title="Servidores">Se conectan por SSH con tu ssh y tus llaves; omni no guarda contraseñas.</DialogSection>
          {hosts.map((h) => {
            const st = hostStatus[h.id]
            const detail = st?.state === 'error' ? (st.error ?? 'sin conexión') : st?.state === 'connected' ? `${st.system ?? ''}${st.tools && !st.tools.dtach ? ' · sin dtach: las terminales mueren si se corta la conexión' : ''}` : hostStateLabel(st)
            return (
              <Field key={h.id} label={`${h.name} · ${hostStateLabel(st)}`} description={`${h.target}${detail ? ` · ${detail}` : ''}`}>
                {st?.state === 'connected' && st.tools && !st.tools.dtach && st.tools.dtachInstall && (
                  <Button onClick={() => void useHosts.getState().installDtach(h.id)}>Instalar dtach</Button>
                )}
                <Button onClick={() => void useHosts.getState().connect(h.id)}>{st?.state === 'connected' ? 'Probar' : 'Reconectar'}</Button>
                <Button
                  onClick={() =>
                    void useHosts
                      .getState()
                      .remove(h.id)
                      .catch((e: unknown) => setHostError(humanError(e, 'No se pudo quitar')))
                  }
                >
                  Quitar
                </Button>
              </Field>
            )
          })}
          <Field label="Agregar servidor" description={hostError ?? 'Un alias de ~/.ssh/config o usuario@host.'}>
            <Button onClick={() => void commands.run('host.add')}>Agregar</Button>
          </Field>
          <DialogSection title="Notificaciones">Avisos de macOS cuando omni no tiene el foco o la sesión no está en pantalla.</DialogSection>
          <Field label="Cuando un agente pregunta" description="Pide un permiso o una respuesta.">
            <Switch label="Avisar cuando un agente pregunta" on={flags.question} onChange={(question) => void update({ notifications: notifySetting({ ...flags, question }) })} />
          </Field>
          <Field label="Cuando un agente termina" description="Deja de trabajar y queda listo.">
            <Switch label="Avisar cuando un agente termina" on={flags.done} onChange={(done) => void update({ notifications: notifySetting({ ...flags, done }) })} />
          </Field>
          <Field label="Probar notificación" description={<span aria-live="polite">{testHint}</span>}>
            <Button disabled={testing} onClick={() => void runTest()}>
              {testing ? 'Enviando' : 'Probar'}
            </Button>
          </Field>
        </>
      )}

      {LAYERS.map((layer) => {
        const layerRows = rows.filter((r) => r.layer === layer)
        if (layerRows.length === 0) return null
        return (
          <div key={layer}>
            <DialogSection title={layer === 'terminal' ? `${LAYER_TITLE[layer]} ${prefixLabel}` : LAYER_TITLE[layer]}>{LAYER_DESC[layer]}</DialogSection>
            {layerRows.map((r) => {
              const key = bindingKey(r.layer, r.command)
              const chords = effectiveChords(settings, r.layer, r.command)
              const overridden = key in settings.keys
              const isPrefixRow = r.command === 'terminal.sendPrefix'
              const show = r.layer === 'terminal' ? prettyKey : prettyChord
              return (
                <Field key={key} label={r.title} description={chords.length > 1 ? `También: ${chords.slice(1).map((c) => show(c)).join(', ')}` : undefined}>
                  {isPrefixRow ? (
                    <Kbd>{prefixLabel}</Kbd>
                  ) : (
                    <KeyCapture value={chords[0] ?? ''} format={show} validate={validateFor(r.layer, r.command)} onChange={(chord) => setKey(r.layer, r.command, [chord])} />
                  )}
                  {overridden && (
                    <IconButton size="sm" label="Volver al atajo por defecto" title={`Por defecto: ${defaultChords(r.layer, r.command, settings.prefix).map((c) => show(c)).join(', ') || 'ninguno'}`} onClick={() => setKey(r.layer, r.command, null)}>
                      <RotateCcw {...ICON_SM} aria-hidden="true" />
                    </IconButton>
                  )}
                </Field>
              )
            })}
          </div>
        )
      })}
      {q && rows.length === 0 && <div className="dialog__empty">Ningún atajo coincide con la búsqueda.</div>}
    </Dialog>
  )
}
