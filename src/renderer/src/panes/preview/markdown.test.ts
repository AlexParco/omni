import { describe, expect, it } from 'vitest'
import { imageSrc, renderMarkdown, type RenderContext } from './markdown'

const CTX: RenderContext = { workspaceId: 'ws1', workspacePath: '/repo', docPath: '/repo/docs/guide.md' }

describe('renderMarkdown', () => {
  it('escapa el HTML crudo (html: false) y enlaza URLs sueltas', () => {
    const html = renderMarkdown('<script>alert(1)</script> ver https://omni.dev', CTX)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<a href="https://omni.dev">https://omni.dev</a>')
  })

  it('reescribe imágenes relativas al protocolo omni-file y deja las externas', () => {
    const html = renderMarkdown('![Captura](../img/a%20b.png)\n\n![Logo](https://x.io/l.png)', CTX)
    expect(html).toContain('<img src="omni-file://ws1/img/a%20b.png" alt="Captura">')
    expect(html).toContain('<img src="https://x.io/l.png" alt="Logo">')
  })

  it('una imagen fuera del workspace se queda con su src original', () => {
    expect(imageSrc(CTX, '../../etc/x.png')).toBe('../../etc/x.png')
    expect(imageSrc(CTX, '/img/root.png')).toBe('omni-file://ws1/img/root.png')
    expect(imageSrc(CTX, 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('los enlaces relativos se dejan tal cual: el pane decide al hacer clic', () => {
    const html = renderMarkdown('[otro](./other.md) y [ext](https://a.b/c)', CTX)
    expect(html).toContain('<a href="./other.md">otro</a>')
    expect(html).toContain('<a href="https://a.b/c">ext</a>')
  })

  it('los encabezados llevan id (único) para que #anchor funcione', () => {
    const html = renderMarkdown('# Hola mundo\n\n## Hola mundo\n\n### Sección 2!', CTX)
    expect(html).toContain('<h1 id="hola-mundo">')
    expect(html).toContain('<h2 id="hola-mundo-1">')
    expect(html).toContain('<h3 id="sección-2">')
  })

  it('bloques de código con la clase del lenguaje y tipografía inteligente', () => {
    const html = renderMarkdown('```ts\nconst a = 1\n```\n\n"citas" -- raya', CTX)
    expect(html).toContain('<pre><code class="language-ts">const a = 1\n</code></pre>')
    expect(html).toContain('“citas” – raya')
  })
})
