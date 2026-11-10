import type { JSX } from 'react'
import type { AgentId } from '@shared/types'
import { Asterisk, Bot, Eye, FileCode, Globe, Terminal } from 'lucide-react'
import './icons.css'

export {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Asterisk,
  Bell,
  Bot,
  Bug,
  Camera,
  Check as CheckMark,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleStop,
  Code2,
  CodeXml,
  Columns2,
  Command,
  Copy,
  Crop,
  Ellipsis,
  Eraser,
  EthernetPort,
  Eye,
  EyeOff,
  File,
  FileCode,
  Folder,
  FolderClosed,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  GitCompare,
  GitMerge,
  Combine,
  Globe,
  Hexagon,
  Highlighter,
  Sparkles,
  House,
  Inbox,
  Keyboard,
  Laptop,
  ListTodo,
  Maximize2,
  MessageSquare,
  Minus,
  MousePointerClick,
  MoveUpRight,
  PanelBottom,
  PanelLeft,
  Pencil,
  Power,
  Redo2,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Minimize2,
  Plus,
  Rows2,
  Settings,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  User,
  X
} from 'lucide-react'

/** Tamaño y trazo por defecto para toda la app. */
export const ICON = { size: 16, strokeWidth: 1.75 } as const
/** Variante pequeña para acciones en filas y chips. */
export const ICON_SM = { size: 14, strokeWidth: 1.75 } as const

/** Codex: la flor de OpenAI, en el color del texto. */
function CodexLogo({ size }: { size: number }): JSX.Element {
  return (
    <svg className="agent-icon" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
    </svg>
  )
}

/** OpenCode: su marca (marco con el bloque interior tenue), en el color del texto. */
function OpenCodeLogo({ size }: { size: number }): JSX.Element {
  return (
    <svg className="agent-icon" width={size} height={size} viewBox="96 96 320 320" fill="none" aria-hidden="true">
      <path d="M320 224V352H192V224H320Z" fill="currentColor" fillOpacity="0.28" />
      <path fillRule="evenodd" clipRule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="currentColor" />
    </svg>
  )
}

/** Símbolo de omni (design/brand/omni-symbol.svg) y su corte chico, con ranuras más anchas y sin esquinas internas. */
const OMNI_MARK = 'M115,16.76A112,112 0 0 0 115,239.24ZM141,16.76L141,101A14,14 0 0 0 155,115L239.24,115A112,112 0 0 0 141,16.76ZM141,239.24L141,155A14,14 0 0 1 155,141L239.24,141A112,112 0 0 1 141,239.24Z'
const OMNI_MARK_SMALL = 'M108,17.8A112,112 0 0 0 108,238.2ZM148,108L148,17.8A112,112 0 0 1 238.2,108ZM148,148L238.2,148A112,112 0 0 1 148,238.2Z'
/** Hasta este tamaño se dibuja el corte chico: a 16–24 px las ranuras del maestro se empastan. */
const OMNI_MARK_SMALL_MAX = 24

/**
 * Logo de omni: la "o" partida como un layout de tmux (design/brand/README.md). En el color del texto;
 * decorativo salvo que se le pase `label`.
 */
export function OmniMark({ size = 16, label, className }: { size?: number; label?: string; className?: string }): JSX.Element {
  return (
    <svg
      className={className ? `omni-mark ${className}` : 'omni-mark'}
      width={size}
      height={size}
      viewBox="16 16 224 224"
      fill="currentColor"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={size <= OMNI_MARK_SMALL_MAX ? OMNI_MARK_SMALL : OMNI_MARK} />
    </svg>
  )
}

/**
 * Icono de agente: el logo real de cada uno en un solo color (como Orca): Claude con su asterisco en
 * naranja, Codex con la flor de OpenAI, OpenCode y Goose y Hermes con su marca en el color del texto
 * (máscaras de su favicon). El shell lleva la terminal y el navegador un globo.
 */
export function AgentIcon({ agent, size = 16 }: { agent: AgentId; size?: number }): JSX.Element {
  if (agent === 'claude') return <Asterisk size={size} strokeWidth={2.4} className="agent-icon agent-icon--claude" />
  if (agent === 'shell') return <Terminal size={size} strokeWidth={ICON.strokeWidth} className="agent-icon" />
  if (agent === 'browser') return <Globe size={size} strokeWidth={ICON.strokeWidth} className="agent-icon" />
  // Panes de documento (§3.19, §3.20): código para el editor, ojo para la vista previa.
  if (agent === 'editor') return <FileCode size={size} strokeWidth={ICON.strokeWidth} className="agent-icon" />
  if (agent === 'preview') return <Eye size={size} strokeWidth={ICON.strokeWidth} className="agent-icon" />
  if (agent === 'codex') return <CodexLogo size={size} />
  if (agent === 'opencode') return <OpenCodeLogo size={size} />
  // Goose y Hermes son mapas de bits: el CSS los pinta como máscara en el color del texto.
  if (agent === 'goose' || agent === 'hermes') return <span className={`agent-icon agent-icon--${agent}`} style={{ width: size, height: size }} aria-hidden="true" />
  return <Bot size={size} strokeWidth={ICON.strokeWidth} className="agent-icon" />
}
