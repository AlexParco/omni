import MarkdownIt from 'markdown-it'
import { isExternal, resolveRelative, slugify, splitHref, toFileUrl } from '@/store/preview-logic'

/**
 * Markdown → HTML para la vista previa (ARCHITECTURE §3.20). `html: false`: el HTML crudo del
 * documento se escapa (DOMPurify repasa igual la salida en el pane). Las imágenes relativas se
 * reescriben al protocolo `omni-file://` del workspace; los enlaces se dejan tal cual (el pane decide
 * al hacer clic) y los encabezados llevan `id` para que `#anchor` funcione. Sin DOM: se prueba en Node.
 */
export interface RenderContext {
  workspaceId: string
  workspacePath: string
  /** Ruta absoluta del documento: contra ella se resuelven las rutas relativas. */
  docPath: string
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
/** Contexto del render en curso (`md.render` es síncrono): evita colar un objeto propio en el `env` abierto de markdown-it. */
let current: RenderContext = { workspaceId: '', workspacePath: '', docPath: '/' }

/** Reescribe un `src` de imagen a `omni-file://`; fuera del workspace o externo se deja como está. */
export function imageSrc(ctx: RenderContext, src: string): string {
  if (isExternal(src) || src.startsWith('data:')) return src
  const abs = resolveRelative(ctx.docPath, src, ctx.workspacePath)
  if (!abs) return src
  const url = toFileUrl(ctx.workspaceId, ctx.workspacePath, abs)
  if (!url) return src
  const { hash } = splitHref(src)
  return hash ? `${url}#${hash}` : url
}

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const src = token.attrGet('src')
  if (src !== null) token.attrSet('src', imageSrc(current, String(src)))
  // El alt es el contenido del token (markdown-it lo deja en children).
  token.attrSet('alt', self.renderInlineAsText(token.children ?? [], options, env))
  return self.renderToken(tokens, idx, options)
}

md.core.ruler.push('heading_ids', (state) => {
  const seen = new Map<string, number>()
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open') return
    const inline = state.tokens[i + 1]
    const text = inline?.type === 'inline' ? inline.content : ''
    let id = slugify(text)
    if (!id) return
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    if (n > 0) id = `${id}-${n}`
    token.attrSet('id', id)
  })
})

/** HTML (sin sanear todavía) del documento Markdown. */
export function renderMarkdown(source: string, ctx: RenderContext): string {
  current = ctx
  return md.render(source)
}
