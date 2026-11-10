import { describe, expect, it, vi } from 'vitest'
import type { Project, Workspace } from '@shared/types'
vi.mock('@/lib/omni', () => ({ omni: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(() => () => undefined) } }))
vi.mock('@/panes/terminal/terminal-host', () => ({ disposeTerminal: vi.fn(), screenLines: vi.fn(() => []) }))

import { hostStateLabel } from './hosts'
import { locationMeta } from './sessions'

const project: Project = {
  id: 'p',
  name: 'Shop',
  locations: [
    { id: 'p', name: 'Local', path: '/Users/ana/shop' },
    { id: 'f', name: 'web', path: '/Users/ana/shop/apps/web' },
    { id: 'o', name: 'order-service', path: '/Users/ana/sales/order-service' },
    { id: 'r', name: 'api', path: '/home/deploy/srv/api', host: 'h1' }
  ]
}
const ws = (id: string): Workspace => {
  const l = project.locations.find((x) => x.id === id)
  if (!l) throw new Error(id)
  return { id, projectId: 'p', name: l.name, path: l.path, kind: 'folder', ...(l.host ? { host: l.host } : {}) }
}

describe('locationMeta', () => {
  it('dentro de la principal en el mismo host: la ruta relativa', () => {
    expect(locationMeta(project, ws('f'))).toBe('apps/web')
  })
  it('en otro lado del Mac: la carpeta que la contiene, corta con ~', () => {
    expect(locationMeta(project, ws('o'))).toBe('~/sales')
  })
  it('en un servidor: el host delante y el home abreviado', () => {
    expect(locationMeta(project, ws('r'), 'vps')).toBe('vps:~/srv')
  })
  it('relativa a cualquier otra ubicación que la contenga (la más cercana), no a la primera', () => {
    const nested: Project = {
      id: 'q',
      name: 'Mono',
      locations: [
        { id: 'web', name: 'web', path: '/Users/ana/mono/apps/web' },
        { id: 'root', name: 'mono', path: '/Users/ana/mono' },
        { id: 'apps', name: 'apps', path: '/Users/ana/mono/apps' }
      ]
    }
    const of = (id: string): Workspace => {
      const l = nested.locations.find((x) => x.id === id)
      if (!l) throw new Error(id)
      return { id, projectId: 'q', name: l.name, path: l.path, kind: 'folder' }
    }
    expect(locationMeta(nested, of('web'))).toBe('web')
    expect(locationMeta(nested, of('apps'))).toBe('apps')
    // La de arriba no cuelga de nadie: su carpeta padre.
    expect(locationMeta(nested, of('root'))).toBe('~')
  })
  it('una carpeta remota con la misma ruta que una local no se toma como relativa', () => {
    const remote: Workspace = { id: 'x', projectId: 'p', name: 'web', path: '/Users/ana/shop/apps/web', kind: 'folder', host: 'h1' }
    expect(locationMeta(project, remote, 'vps')).toBe('vps:/Users/ana/shop/apps')
  })
})

describe('hostStateLabel', () => {
  it('nombra cada estado', () => {
    expect(hostStateLabel(undefined)).toBe('sin conectar')
    expect(hostStateLabel({ hostId: 'h', state: 'connecting', error: null, home: null, system: null, tools: null })).toBe('conectando')
    expect(hostStateLabel({ hostId: 'h', state: 'connected', error: null, home: '/home/x', system: 'Linux x86_64', tools: null })).toBe('conectado')
    expect(hostStateLabel({ hostId: 'h', state: 'error', error: 'auth', home: null, system: null, tools: null })).toBe('sin conexión')
  })
})
