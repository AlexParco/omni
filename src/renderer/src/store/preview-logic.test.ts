import { describe, expect, it } from 'vitest'
import { baseName, dirName, extOf, hostOf, isAllowedUri, isExternal, isInside, kindOf, normalizePath, relativeTo, resolveRelative, slugify, splitHref, stepZoom, toFileUrl, typeLabel, zoomLabel } from './preview-logic'

describe('kindOf', () => {
  it('reconoce Markdown, imágenes y PDF por extensión, sin importar mayúsculas', () => {
    expect(kindOf('/w/README.md')).toBe('md')
    expect(kindOf('/w/notes.markdown')).toBe('md')
    expect(kindOf('/w/shot.PNG')).toBe('image')
    expect(kindOf('/w/a.jpeg')).toBe('image')
    expect(kindOf('/w/logo.svg')).toBe('image')
    expect(kindOf('/w/spec.pdf')).toBe('pdf')
    expect(kindOf('/w/main.ts')).toBe('other')
    expect(kindOf('/w/Makefile')).toBe('other')
    expect(kindOf('/w/.gitignore')).toBe('other')
  })
})

describe('rutas', () => {
  it('extOf, baseName y dirName', () => {
    expect(extOf('/w/a/b.tar.gz')).toBe('gz')
    expect(extOf('/w/.env')).toBe('')
    expect(baseName('/w/a/b.md')).toBe('b.md')
    expect(baseName('/w/a/')).toBe('a')
    expect(dirName('/w/a/b.md')).toBe('/w/a')
    expect(dirName('/b.md')).toBe('/')
  })
  it('normalizePath resuelve . y .. y no sale de la raíz', () => {
    expect(normalizePath('/w/a/../b/./c.md')).toBe('/w/b/c.md')
    expect(normalizePath('/w//a')).toBe('/w/a')
    expect(normalizePath('/../../x')).toBe('/x')
  })
  it('isInside y relativeTo', () => {
    expect(isInside('/w', '/w/a.md')).toBe(true)
    expect(isInside('/w', '/w')).toBe(true)
    expect(isInside('/w', '/wx/a.md')).toBe(false)
    expect(isInside('/w', '/w/../etc/passwd')).toBe(false)
    expect(relativeTo('/w', '/w/docs/a b.md')).toBe('docs/a b.md')
    expect(relativeTo('/w', '/w')).toBe('')
    expect(relativeTo('/w', '/other')).toBeNull()
  })
})

describe('resolveRelative', () => {
  it('resuelve contra el directorio del documento, decodifica y quita fragmento y query', () => {
    expect(resolveRelative('/w/docs/a.md', 'b.md')).toBe('/w/docs/b.md')
    expect(resolveRelative('/w/docs/a.md', '../img/x%20y.png')).toBe('/w/img/x y.png')
    expect(resolveRelative('/w/docs/a.md', './b.md#intro')).toBe('/w/docs/b.md')
    expect(resolveRelative('/w/docs/a.md', 'b.md?x=1')).toBe('/w/docs/b.md')
  })
  it('con / inicial va a la raíz del workspace si se da; si no, es absoluta', () => {
    expect(resolveRelative('/w/docs/a.md', '/CONTRIBUTING.md', '/w')).toBe('/w/CONTRIBUTING.md')
    expect(resolveRelative('/w/docs/a.md', '/tmp/x.md')).toBe('/tmp/x.md')
  })
  it('null para externos, mailto, anclas solas y vacío', () => {
    expect(resolveRelative('/w/a.md', 'https://x.io/a.md')).toBeNull()
    expect(resolveRelative('/w/a.md', 'mailto:a@b.c')).toBeNull()
    expect(resolveRelative('/w/a.md', '#top')).toBeNull()
    expect(resolveRelative('/w/a.md', '')).toBeNull()
  })
})

describe('isExternal / splitHref / hostOf', () => {
  it('distingue esquemas de rutas', () => {
    expect(isExternal('https://a.b')).toBe(true)
    expect(isExternal('mailto:x@y.z')).toBe(true)
    expect(isExternal('omni-file://w/a.png')).toBe(false)
    expect(isExternal('docs/a.md')).toBe(false)
    expect(isExternal('C:/x')).toBe(false)
    expect(isExternal('/abs/path.md')).toBe(false)
  })
  it('separa ruta, query y fragmento', () => {
    expect(splitHref('a.md#x')).toEqual({ path: 'a.md', hash: 'x' })
    expect(splitHref('a.md?q=1#x')).toEqual({ path: 'a.md', hash: 'x' })
    expect(splitHref('#solo')).toEqual({ path: '', hash: 'solo' })
  })
  it('hostOf devuelve el dominio o el texto', () => {
    expect(hostOf('https://github.com/x/y')).toBe('github.com')
    expect(hostOf('mailto:a@b.c')).toBe('mailto:a@b.c')
  })
})

describe('isAllowedUri (ALLOWED_URI de DOMPurify)', () => {
  it('acepta web, el protocolo del workspace, rutas relativas y anclas', () => {
    expect(isAllowedUri('https://a.b/c')).toBe(true)
    expect(isAllowedUri('http://localhost:3000')).toBe(true)
    expect(isAllowedUri('mailto:a@b.c')).toBe(true)
    expect(isAllowedUri('omni-file://ws1/docs/a.png')).toBe(true)
    expect(isAllowedUri('docs/a.md')).toBe(true)
    expect(isAllowedUri('./a.md')).toBe(true)
    expect(isAllowedUri('../img/x.png')).toBe(true)
    expect(isAllowedUri('/CONTRIBUTING.md')).toBe(true)
    expect(isAllowedUri('#intro')).toBe(true)
  })
  it('rechaza javascript:, data:, file:, vbscript: y esquemas raros', () => {
    expect(isAllowedUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedUri('JavaScript:alert(1)')).toBe(false)
    expect(isAllowedUri('data:text/html,<script>')).toBe(false)
    expect(isAllowedUri('data:image/png;base64,AAAA')).toBe(false)
    expect(isAllowedUri('file:///etc/passwd')).toBe(false)
    expect(isAllowedUri('vbscript:msgbox')).toBe(false)
    expect(isAllowedUri('ftp://x.y/z')).toBe(false)
  })
})

describe('toFileUrl', () => {
  it('arma omni-file://<ws>/<rel> con segmentos codificados', () => {
    expect(toFileUrl('ws1', '/repo', '/repo/docs/img/a b.png')).toBe('omni-file://ws1/docs/img/a%20b.png')
    expect(toFileUrl('ws1', '/repo/', '/repo/README.md')).toBe('omni-file://ws1/README.md')
    expect(toFileUrl('ws1', '/repo', '/repo/x#1.png')).toBe('omni-file://ws1/x%231.png')
  })
  it('null fuera del workspace (incluido escapar con ..)', () => {
    expect(toFileUrl('ws1', '/repo', '/other/a.png')).toBeNull()
    expect(toFileUrl('ws1', '/repo', '/repo/../etc/passwd')).toBeNull()
  })
})

describe('franja', () => {
  it('typeLabel por tipo, con dimensiones para imágenes', () => {
    expect(typeLabel('/w/a.md')).toBe('Markdown')
    expect(typeLabel('/w/a.pdf')).toBe('PDF')
    expect(typeLabel('/w/a.png')).toBe('PNG')
    expect(typeLabel('/w/a.png', { width: 1280, height: 800 })).toBe('PNG 1280×800')
    expect(typeLabel('/w/a.ts')).toBe('TS')
    expect(typeLabel('/w/Makefile')).toBe('Archivo')
  })
  it('stepZoom escala por 1.25 y se acota; zoomLabel', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.8)
    expect(stepZoom(8, 1)).toBe(8)
    expect(stepZoom(0.1, -1)).toBe(0.1)
    expect(zoomLabel(null)).toBe('Ajustar')
    expect(zoomLabel(1.25)).toBe('125 %')
    expect(zoomLabel(0.333)).toBe('33 %')
  })
  it('slugify como GitHub', () => {
    expect(slugify('Hola, mundo!')).toBe('hola-mundo')
    expect(slugify('  Vista previa (pane)  ')).toBe('vista-previa-pane')
    expect(slugify('Ñandú 2')).toBe('ñandú-2')
  })
})
