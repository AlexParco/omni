import { describe, expect, it } from 'vitest'
import { docKindFor, fromLabel, guessKind, humanError, isWebUrl, noticeText, parseArgs, sameUrl } from './control-logic'

describe('parseArgs', () => {
  it('open: exige path y respeta kind si viene; si no, lo adivina', () => {
    expect(parseArgs('open', {})).toEqual({ ok: false, error: 'open: falta la ruta (path)' })
    expect(parseArgs('open', { path: '  ' })).toEqual({ ok: false, error: 'open: falta la ruta (path)' })
    expect(parseArgs('open', { path: '/x/repo', kind: 'dir' })).toEqual({ ok: true, args: { type: 'open', path: '/x/repo', kind: 'dir' } })
    expect(parseArgs('open', { path: '/x/repo/src/a.ts' })).toEqual({ ok: true, args: { type: 'open', path: '/x/repo/src/a.ts', kind: 'file' } })
    expect(parseArgs('open', { path: '/x/repo/' })).toEqual({ ok: true, args: { type: 'open', path: '/x/repo/', kind: 'dir' } })
    // Un `kind` raro no rompe: se adivina.
    expect(parseArgs('open', { path: '/x/repo', kind: 7 })).toEqual({ ok: true, args: { type: 'open', path: '/x/repo', kind: 'dir' } })
  })

  it('browser y capture: normalizan la URL y rechazan lo que no es http(s)', () => {
    expect(parseArgs('browser', {})).toEqual({ ok: false, error: 'browser: falta la dirección (url)' })
    expect(parseArgs('browser', { url: 'localhost:3000' })).toEqual({ ok: true, args: { type: 'browser', url: 'http://localhost:3000', workspaceId: null } })
    expect(parseArgs('browser', { url: 'example.com', workspaceId: 'w1' })).toEqual({ ok: true, args: { type: 'browser', url: 'https://example.com', workspaceId: 'w1' } })
    expect(parseArgs('browser', { url: 'file:///etc/passwd' })).toEqual({ ok: false, error: 'browser: la dirección no es http(s): file:///etc/passwd' })
    expect(parseArgs('capture', { url: 'https://a.test/x', sessionId: 's1' })).toEqual({ ok: true, args: { type: 'capture', url: 'https://a.test/x', sessionId: 's1' } })
    expect(parseArgs('capture', { url: 'about:blank' })).toEqual({ ok: false, error: 'capture: la dirección no es http(s): about:blank' })
  })

  it('diff, focus, todo y notify: un campo obligatorio cada uno', () => {
    expect(parseArgs('diff', {})).toEqual({ ok: false, error: 'diff: falta el workspace (workspaceId)' })
    expect(parseArgs('diff', { workspaceId: 'w1' })).toEqual({ ok: true, args: { type: 'diff', workspaceId: 'w1' } })
    expect(parseArgs('focus', { sessionId: '' })).toEqual({ ok: false, error: 'focus: falta la sesión (sessionId)' })
    expect(parseArgs('focus', { sessionId: 's1' })).toEqual({ ok: true, args: { type: 'focus', sessionId: 's1' } })
    expect(parseArgs('todo', { text: '   ' })).toEqual({ ok: false, error: 'todo: falta el texto (text)' })
    expect(parseArgs('todo', { text: ' revisar tests ' })).toEqual({ ok: true, args: { type: 'todo', text: 'revisar tests' } })
    expect(parseArgs('notify', { body: 'x' })).toEqual({ ok: false, error: 'notify: falta el título (title)' })
    expect(parseArgs('notify', { title: 'Build' })).toEqual({ ok: true, args: { type: 'notify', title: 'Build', body: '' } })
    expect(parseArgs('notify', { title: 'Build', body: 'listo' })).toEqual({ ok: true, args: { type: 'notify', title: 'Build', body: 'listo' } })
  })

  it('list y send son de main; un tipo desconocido no revienta', () => {
    expect(parseArgs('list', {})).toEqual({ ok: false, error: 'list: lo resuelve main, no el renderer' })
    expect(parseArgs('send', { text: 'x' })).toEqual({ ok: false, error: 'send: lo resuelve main, no el renderer' })
    expect(parseArgs('nope' as never, {})).toEqual({ ok: false, error: 'comando desconocido: nope' })
  })
})

describe('guessKind', () => {
  it('archivo si la última parte tiene extensión (o es oculto con nombre), carpeta si no', () => {
    expect(guessKind('/a/b/c.ts')).toBe('file')
    expect(guessKind('/a/b/.env')).toBe('file')
    expect(guessKind('/a/b/README.md')).toBe('file')
    expect(guessKind('/a/b')).toBe('dir')
    expect(guessKind('/a/b/')).toBe('dir')
    expect(guessKind('/a/Makefile')).toBe('dir')
  })
})

describe('docKindFor', () => {
  it('Markdown, imágenes y PDF van a la vista previa; el resto al editor', () => {
    expect(docKindFor('/a/README.md')).toBe('preview')
    expect(docKindFor('/a/Notas.MARKDOWN')).toBe('preview')
    expect(docKindFor('/a/logo.PNG')).toBe('preview')
    expect(docKindFor('/a/foto.jpeg')).toBe('preview')
    expect(docKindFor('/a/anim.gif')).toBe('preview')
    expect(docKindFor('/a/x.webp')).toBe('preview')
    expect(docKindFor('/a/icon.svg')).toBe('preview')
    expect(docKindFor('/a/doc.pdf')).toBe('preview')
    expect(docKindFor('/a/src/a.ts')).toBe('editor')
    expect(docKindFor('/a/.env')).toBe('editor')
    expect(docKindFor('/a/Makefile')).toBe('editor')
    expect(docKindFor('/a/md')).toBe('editor')
  })
})

describe('isWebUrl / sameUrl', () => {
  it('solo http(s) con algo detrás', () => {
    expect(isWebUrl('https://a.test')).toBe(true)
    expect(isWebUrl('http://localhost:3000/x')).toBe(true)
    expect(isWebUrl('https://')).toBe(false)
    expect(isWebUrl('ftp://a.test')).toBe(false)
  })

  it('ignora barra final, fragmento y mayúsculas del host', () => {
    expect(sameUrl('https://a.test/', 'https://a.test')).toBe(true)
    expect(sameUrl('https://A.test/x#top', 'https://a.test/x')).toBe(true)
    expect(sameUrl('https://a.test/x', 'https://a.test/y')).toBe(false)
    expect(sameUrl('https://a.test/X', 'https://a.test/x')).toBe(false)
    expect(sameUrl('', 'https://a.test')).toBe(false)
  })
})

describe('fromLabel / noticeText', () => {
  it('CLI, MCP y MCP · agente', () => {
    expect(fromLabel('cli')).toBe('CLI')
    expect(fromLabel('')).toBe('CLI')
    expect(fromLabel('mcp')).toBe('MCP')
    expect(fromLabel('mcp:')).toBe('MCP')
    expect(fromLabel('mcp:claude')).toBe('MCP · claude')
    expect(fromLabel('otro')).toBe('otro')
    expect(noticeText('mcp:codex')).toBe('MCP · codex')
    expect(noticeText('cli', 'captura')).toBe('CLI · captura')
  })
})

describe('humanError', () => {
  it('desenvuelve el error de IPC y cae al texto por defecto', () => {
    expect(humanError(new Error("Error invoking remote method 'project:addPath': Error: no existe"), 'x')).toBe('no existe')
    expect(humanError('simple', 'x')).toBe('simple')
    expect(humanError(new Error(''), 'por defecto')).toBe('por defecto')
    expect(humanError(42, 'por defecto')).toBe('por defecto')
  })
})
