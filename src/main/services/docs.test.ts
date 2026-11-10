import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@shared/types'
import { MAX_TEXT_BYTES } from '@shared/types'
import { DocService } from './docs'

describe('DocService', () => {
  let dir: string
  let workspace: Workspace
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-docs-'))
    mkdirSync(join(dir, 'ws', 'src'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'ws', 'src', 'a.ts'), 'a')
    writeFileSync(join(dir, 'outside', 'secret.md'), 's')
    symlinkSync(join(dir, 'outside', 'secret.md'), join(dir, 'ws', 'leak.md'))
    workspace = { id: 'w1', projectId: 'p1', name: 'Local', path: join(dir, 'ws'), kind: 'local' }
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('open registra una sesión sin proceso con agent = kind, cwd del workspace y args = [ruta]', () => {
    const docs = new DocService()
    const path = join(dir, 'ws', 'src', 'a.ts')
    const info = docs.open(workspace, path, 'editor')
    expect(info).toMatchObject({ agent: 'editor', workspaceId: 'w1', cwd: workspace.path, args: [path] })
    expect(typeof info.id).toBe('string')
    expect(info.createdAt).toBeGreaterThan(0)
    expect(docs.list()).toEqual([info])
    expect(docs.has(info.id)).toBe(true)
    expect(docs.saved()).toEqual([{ id: info.id, workspaceId: 'w1', path, kind: 'editor' }])
  })

  it('recrea con el id pedido; un id ya vivo recibe uno nuevo', () => {
    const docs = new DocService()
    const path = join(dir, 'ws', 'src', 'a.ts')
    const a = docs.open(workspace, path, 'preview', { id: 'doc-1' })
    expect(a.id).toBe('doc-1')
    const b = docs.open(workspace, path, 'preview', { id: 'doc-1' })
    expect(b.id).not.toBe('doc-1')
    expect(docs.list()).toHaveLength(2)
  })

  it('rechaza rutas fuera del workspace, symlinks que escapan, la raíz misma y lo que no existe', () => {
    const docs = new DocService()
    expect(() => docs.open(workspace, join(dir, 'outside', 'secret.md'), 'editor')).toThrow(/fuera del workspace/)
    expect(() => docs.open(workspace, join(dir, 'ws', 'leak.md'), 'editor')).toThrow(/fuera del workspace/)
    expect(() => docs.open(workspace, join(dir, 'ws', '..', 'outside', 'secret.md'), 'editor')).toThrow(/fuera del workspace/)
    expect(() => docs.open(workspace, workspace.path, 'editor')).toThrow(/fuera del workspace/)
    expect(() => docs.open(workspace, join(dir, 'ws', 'nope.ts'), 'editor')).toThrow(/no existe/)
    expect(docs.list()).toEqual([])
  })

  it('rechaza carpetas y rutas relativas; el editor no abre más de 2 MB pero la vista previa sí', () => {
    const docs = new DocService()
    expect(() => docs.open(workspace, join(dir, 'ws', 'src'), 'editor')).toThrow(/no es un archivo/)
    expect(() => docs.open(workspace, join(dir, 'ws', 'src'), 'preview')).toThrow(/no es un archivo/)
    expect(() => docs.open(workspace, 'src/a.ts', 'editor')).toThrow(/absoluta/)
    const big = join(dir, 'ws', 'big.pdf')
    writeFileSync(big, Buffer.alloc(MAX_TEXT_BYTES + 1))
    expect(() => docs.open(workspace, big, 'editor')).toThrow(/2 MB/)
    expect(docs.open(workspace, big, 'preview')).toMatchObject({ agent: 'preview', args: [big] })
    expect(docs.list()).toHaveLength(1)
  })

  it('destroy emite onExit una sola vez; killAll vacía la lista', () => {
    const docs = new DocService()
    const onExit = vi.fn()
    docs.onExit(onExit)
    const path = join(dir, 'ws', 'src', 'a.ts')
    const a = docs.open(workspace, path, 'editor')
    const b = docs.open(workspace, path, 'preview')
    docs.destroy(a.id)
    docs.destroy(a.id)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(a.id, 0)
    expect(docs.has(a.id)).toBe(false)
    docs.killAll()
    expect(onExit).toHaveBeenCalledWith(b.id, 0)
    expect(docs.list()).toEqual([])
  })
})
