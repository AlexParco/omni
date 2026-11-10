import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileProtocolHandler, mimeOf, resolveWorkspaceFile } from './file-protocol'

describe('mimeOf', () => {
  it('tabla mínima por extensión, sin distinguir mayúsculas; lo demás es binario genérico', () => {
    expect(mimeOf('/x/README.md')).toBe('text/markdown; charset=utf-8')
    expect(mimeOf('/x/a.PNG')).toBe('image/png')
    expect(mimeOf('/x/a.jpeg')).toBe('image/jpeg')
    expect(mimeOf('/x/a.svg')).toBe('image/svg+xml')
    expect(mimeOf('/x/a.pdf')).toBe('application/pdf')
    expect(mimeOf('/x/a.bin')).toBe('application/octet-stream')
    expect(mimeOf('/x/noext')).toBe('application/octet-stream')
  })
})

describe('resolveWorkspaceFile', () => {
  let dir: string
  let workspaces: { id: string; path: string }[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-proto-'))
    mkdirSync(join(dir, 'ws', 'docs', 'img'), { recursive: true })
    mkdirSync(join(dir, 'ws-other'))
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'ws', 'README.md'), '# hi')
    writeFileSync(join(dir, 'ws', 'docs', 'img', 'a b.png'), 'png')
    writeFileSync(join(dir, 'ws', 'docs', 'guide.pdf'), '%PDF-1.4')
    writeFileSync(join(dir, 'ws', 'docs', 'q?a#b 100%.md'), 'raro')
    writeFileSync(join(dir, 'ws-other', 'x.md'), 'x')
    writeFileSync(join(dir, 'outside', 'secret.md'), 's')
    symlinkSync(join(dir, 'outside', 'secret.md'), join(dir, 'ws', 'leak.md'))
    symlinkSync(join(dir, 'outside'), join(dir, 'ws', 'leakdir'))
    workspaces = [{ id: 'W1', path: join(dir, 'ws') }]
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('resuelve una ruta relativa (con espacios codificados) y el host sin distinguir mayúsculas', () => {
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/README.md')).toEqual({ path: join(dir, 'ws', 'README.md'), mime: 'text/markdown; charset=utf-8' })
    expect(resolveWorkspaceFile(workspaces, 'omni-file://W1/docs/img/a%20b.png')).toEqual({ path: join(dir, 'ws', 'docs', 'img', 'a b.png'), mime: 'image/png' })
  })

  it('ignora la query (el preview usa ?v=N para romper la caché) y el fragmento', () => {
    const expected = { path: join(dir, 'ws', 'README.md'), mime: 'text/markdown; charset=utf-8' }
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/README.md?v=3')).toEqual(expected)
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/README.md#intro')).toEqual(expected)
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/README.md?v=3&x=../outside/secret.md#..')).toEqual(expected)
    // Una query no "rescata" una ruta que no existe ni una que escapa.
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/nope.md?v=1')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/../outside/secret.md?v=1')).toBeNull()
  })

  it('un nombre con ?, # o % se sirve si el renderer lo codificó por segmento', () => {
    const rel = ['docs', 'q?a#b 100%.md'].map(encodeURIComponent).join('/')
    expect(rel).toBe('docs/q%3Fa%23b%20100%25.md')
    expect(resolveWorkspaceFile(workspaces, `omni-file://w1/${rel}`)).toEqual({ path: join(dir, 'ws', 'docs', 'q?a#b 100%.md'), mime: 'text/markdown; charset=utf-8' })
    expect(resolveWorkspaceFile(workspaces, `omni-file://w1/${rel}?v=2`)).not.toBeNull()
    // Sin codificar, `?` abre la query y `#` el fragmento: la ruta que queda no existe.
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/docs/q?a#b 100%.md')).toBeNull()
  })

  it('null si el workspace no existe, el esquema es otro o la URL no parsea', () => {
    expect(resolveWorkspaceFile(workspaces, 'omni-file://nope/README.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'file://w1/README.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'no es una url')).toBeNull()
    expect(resolveWorkspaceFile([], 'omni-file://w1/README.md')).toBeNull()
  })

  it('null para `..` (crudo o codificado), symlinks hacia fuera, carpetas, la raíz y lo que no existe', () => {
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/../outside/secret.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/docs/%2E%2E/%2E%2E/outside/secret.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/..%2F..%2Fws-other/x.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/leak.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/leakdir/secret.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/docs')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/nope.md')).toBeNull()
    expect(resolveWorkspaceFile(workspaces, 'omni-file://w1/README.md%00')).toBeNull()
  })

  it('el handler sirve el archivo con su MIME y responde 404 si no resuelve', async () => {
    const handler = createFileProtocolHandler(() => workspaces)
    const ok = await handler(new Request('omni-file://w1/README.md'))
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(await ok.text()).toBe('# hi')
    const missing = await handler(new Request('omni-file://w1/../outside/secret.md'))
    expect(missing.status).toBe(404)
    // El visor de PDF de Chromium exige el Content-Type exacto, sin charset; la query no estorba.
    const pdf = await handler(new Request('omni-file://w1/docs/guide.pdf?v=7'))
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(await pdf.text()).toBe('%PDF-1.4')
  })
})
