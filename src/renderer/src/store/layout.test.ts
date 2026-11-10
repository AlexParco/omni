import { beforeEach, describe, expect, it } from 'vitest'
import {
  sideAt,
  MIN_SIZE,
  activeTabOf,
  focusedSessionId,
  leaves,
  tabIndexOfSession,
  tabsOf,
  useLayout,
  type LayoutNode,
  type Split,
  type Tab
} from './layout'

const WS = 'ws-1'
const OTHER = 'ws-2'

const lay = () => useLayout.getState()

/** Tab activo del workspace; falla si no hay ninguno. */
function activeTab(ws = WS): Tab {
  const tab = activeTabOf(lay(), ws)
  if (!tab) throw new Error(`sin tab activo en ${ws}`)
  return tab
}

function asSplit(node: LayoutNode): Split {
  if (node.kind !== 'split') throw new Error('se esperaba un split')
  return node
}

function sessionsOf(node: LayoutNode): string[] {
  return leaves(node).map((l) => l.sessionId)
}

beforeEach(() => {
  useLayout.setState({ tabs: [], activeTab: {} })
})

describe('openTab y selectores', () => {
  it('crea un tab con una hoja y lo activa', () => {
    const tab = lay().openTab(WS, 's1')

    expect(tab.root.kind).toBe('leaf')
    expect(tabsOf(lay(), WS)).toEqual([tab])
    expect(activeTabOf(lay(), WS)?.id).toBe(tab.id)
    expect(focusedSessionId(lay(), WS)).toBe('s1')
    expect(tab.focusedPaneId).toBe(tab.root.kind === 'leaf' ? tab.root.id : '')
  })

  it('tabIndexOfSession devuelve el índice base 1 del tab que contiene la sesión', () => {
    lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')

    expect(tabIndexOfSession(lay(), 'a')).toBe(1)
    expect(tabIndexOfSession(lay(), 'b')).toBe(2)
    expect(tabIndexOfSession(lay(), 'fantasma')).toBeNull()
  })

  it('tabsOf solo devuelve los tabs del workspace pedido', () => {
    lay().openTab(WS, 'a')
    lay().openTab(OTHER, 'b')

    expect(tabsOf(lay(), WS)).toHaveLength(1)
    expect(tabsOf(lay(), OTHER)).toHaveLength(1)
    expect(tabsOf(lay(), 'nadie')).toHaveLength(0)
  })

  it('focusedSessionId es null sin tabs', () => {
    expect(focusedSessionId(lay(), WS)).toBeNull()
  })
})

describe('split', () => {
  it('sobre un tab de una hoja pasa a split row con dos hijos y foco en la hoja nueva', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')

    const tab = activeTab()
    const root = asSplit(tab.root)
    expect(root.dir).toBe('row')
    expect(sessionsOf(root)).toEqual(['s1', 's2'])
    expect(root.sizes).toEqual([0.5, 0.5])
    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })

  it('split repetido en la misma dirección inserta al lado y reparte el tamaño de la hoja enfocada', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'row', 's3')

    const root = asSplit(activeTab().root)
    expect(root.children).toHaveLength(3)
    expect(sessionsOf(root)).toEqual(['s1', 's2', 's3'])
    expect(root.sizes).toEqual([0.5, 0.25, 0.25])
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
    expect(focusedSessionId(lay(), WS)).toBe('s3')
  })

  it('split en dirección distinta anida un split dentro de la hoja enfocada', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'col', 's3')

    const root = asSplit(activeTab().root)
    expect(root.dir).toBe('row')
    expect(root.children[0]).toMatchObject({ kind: 'leaf', sessionId: 's1' })
    const nested = asSplit(root.children[1])
    expect(nested.dir).toBe('col')
    expect(sessionsOf(nested)).toEqual(['s2', 's3'])
    expect(focusedSessionId(lay(), WS)).toBe('s3')
  })

  it('sin tab abierto abre uno con la sesión', () => {
    lay().split(WS, 'row', 's1')

    expect(tabsOf(lay(), WS)).toHaveLength(1)
    expect(activeTab().root).toMatchObject({ kind: 'leaf', sessionId: 's1' })
  })
})

describe('closeSession', () => {
  it('colapsa un split que se queda con un solo hijo', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().closeSession('s2')

    expect(activeTab().root).toMatchObject({ kind: 'leaf', sessionId: 's1' })
  })

  it('renormaliza los tamaños de los hermanos que quedan', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'row', 's3')
    lay().closeSession('s2')

    const root = asSplit(activeTab().root)
    expect(sessionsOf(root)).toEqual(['s1', 's3'])
    expect(root.sizes[0]).toBeCloseTo(2 / 3)
    expect(root.sizes[1]).toBeCloseTo(1 / 3)
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('un tab que queda vacío se elimina y el activo pasa al siguiente del workspace', () => {
    lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')
    lay().closeSession('b')

    expect(tabsOf(lay(), WS)).toHaveLength(1)
    expect(activeTabOf(lay(), WS)?.root).toMatchObject({ kind: 'leaf', sessionId: 'a' })
  })

  it('un tab vacío sin más tabs del workspace deja el activeTab sin entrada', () => {
    lay().openTab(WS, 'a')
    lay().closeSession('a')

    expect(lay().tabs).toHaveLength(0)
    expect(lay().activeTab[WS]).toBeUndefined()
  })

  it('cerrar un tab vacío no toca el activeTab de otro workspace', () => {
    lay().openTab(OTHER, 'o')
    lay().openTab(WS, 'a')
    const otherActive = lay().activeTab[OTHER]
    lay().closeSession('a')

    expect(lay().activeTab[OTHER]).toBe(otherActive)
    expect(lay().activeTab[WS]).toBeUndefined()
  })

  it('si el foco estaba en la hoja cerrada pasa al vecino', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().focusSession('s1')
    lay().closeSession('s1')

    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })

  it('limpia zoomedPaneId si la hoja zoomeada es la cerrada', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().toggleZoom(WS)
    expect(activeTab().zoomedPaneId).not.toBeNull()

    lay().closeSession('s2')

    expect(activeTab().zoomedPaneId).toBeNull()
  })

  it('conserva zoomedPaneId si la hoja zoomeada es otra', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().focusSession('s1')
    lay().toggleZoom(WS)
    const zoomed = activeTab().zoomedPaneId

    lay().closeSession('s2')

    expect(activeTab().zoomedPaneId).toBe(zoomed)
  })

  it('una sesión desconocida no cambia nada', () => {
    lay().openTab(WS, 's1')
    const before = lay().tabs

    lay().closeSession('fantasma')

    expect(lay().tabs).toBe(before)
  })
})

describe('foco', () => {
  it('focusPane fija el foco y activa el tab', () => {
    const first = lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')
    lay().focusPane(first.id, first.focusedPaneId)

    expect(activeTabOf(lay(), WS)?.id).toBe(first.id)
  })

  it('focusSession cambia de tab si la sesión está en otro', () => {
    lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')

    expect(lay().focusSession('a')).toBe(true)
    expect(focusedSessionId(lay(), WS)).toBe('a')
  })

  it('focusSession devuelve false si la sesión no existe', () => {
    lay().openTab(WS, 'a')

    expect(lay().focusSession('fantasma')).toBe(false)
  })

  it('focusOffset recorre las hojas con wrap-around', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'row', 's3')

    lay().focusOffset(WS, 1)
    expect(focusedSessionId(lay(), WS)).toBe('s1')
    lay().focusOffset(WS, -1)
    expect(focusedSessionId(lay(), WS)).toBe('s3')
    lay().focusOffset(WS, -1)
    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })

  it('focusOffset sin tab no hace nada', () => {
    expect(() => lay().focusOffset(WS, 1)).not.toThrow()
    expect(lay().tabs).toHaveLength(0)
  })

  it('cycleTab da la vuelta en ambos sentidos', () => {
    lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')
    lay().openTab(WS, 'c')

    lay().cycleTab(WS, 1)
    expect(focusedSessionId(lay(), WS)).toBe('a')
    lay().cycleTab(WS, -1)
    expect(focusedSessionId(lay(), WS)).toBe('c')
  })

  it('selectTab ignora índices fuera de rango', () => {
    lay().openTab(WS, 'a')
    lay().openTab(WS, 'b')

    lay().selectTab(WS, 0)
    expect(focusedSessionId(lay(), WS)).toBe('a')
    lay().selectTab(WS, 99)
    expect(focusedSessionId(lay(), WS)).toBe('a')
    lay().selectTab(WS, -1)
    expect(focusedSessionId(lay(), WS)).toBe('a')
  })
})

describe('toggleZoom', () => {
  it('no hace nada con una sola hoja', () => {
    lay().openTab(WS, 's1')
    lay().toggleZoom(WS)

    expect(activeTab().zoomedPaneId).toBeNull()
  })

  it('alterna el zoom con dos hojas', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')

    lay().toggleZoom(WS)
    expect(activeTab().zoomedPaneId).toBe(activeTab().focusedPaneId)
    lay().toggleZoom(WS)
    expect(activeTab().zoomedPaneId).toBeNull()
  })
})

describe('resizeFocused', () => {
  it('mueve el divisor y suma 1 entre los hermanos', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().focusSession('s1')
    lay().resizeFocused(WS, 'row', 0.2)

    const root = asSplit(activeTab().root)
    expect(root.sizes[0]).toBeCloseTo(0.7)
    expect(root.sizes[1]).toBeCloseTo(0.3)
    expect(root.sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('respeta MIN_SIZE en ambos sentidos', () => {
    expect(MIN_SIZE).toBe(0.1)
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().focusSession('s1')

    lay().resizeFocused(WS, 'row', 0.9)
    expect(asSplit(activeTab().root).sizes[1]).toBeCloseTo(MIN_SIZE)

    lay().resizeFocused(WS, 'row', -0.9)
    expect(asSplit(activeTab().root).sizes[0]).toBeCloseTo(MIN_SIZE)
  })

  it('usa el split ancestro con esa dirección aunque el foco esté anidado; el divisor va hacia donde apunta', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'col', 's3')

    // El foco está a la derecha: mover el divisor a la derecha achica su lado (como tmux).
    lay().resizeFocused(WS, 'row', 0.1)

    const root = asSplit(activeTab().root)
    expect(root.sizes[0]).toBeCloseTo(0.6)
    expect(root.sizes[1]).toBeCloseTo(0.4)
  })

  it('en el pane de la derecha, a la izquierda lo agranda', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().resizeFocused(WS, 'row', -0.2)

    const root = asSplit(activeTab().root)
    expect(root.sizes[0]).toBeCloseTo(0.3)
    expect(root.sizes[1]).toBeCloseTo(0.7)
  })

  it('no hace nada si no hay split con esa dirección', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().resizeFocused(WS, 'col', 0.2)

    expect(asSplit(activeTab().root).sizes).toEqual([0.5, 0.5])
  })

  it('no hace nada con una sola hoja', () => {
    lay().openTab(WS, 's1')
    lay().resizeFocused(WS, 'row', 0.2)

    expect(activeTab().root.kind).toBe('leaf')
  })
})

describe('setSizes', () => {
  it('reemplaza los tamaños del split indicado', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    const tab = activeTab()
    lay().setSizes(tab.id, tab.root.id, [0.3, 0.7])

    expect(asSplit(activeTab().root).sizes).toEqual([0.3, 0.7])
  })
})

describe('swapFocused', () => {
  it('intercambia las sesiones de las hojas y el foco sigue a la sesión', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().swapFocused(WS, 1)

    expect(sessionsOf(activeTab().root)).toEqual(['s2', 's1'])
    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })

  it('no hace nada con una sola hoja', () => {
    lay().openTab(WS, 's1')
    lay().swapFocused(WS, 1)

    expect(activeTab().root).toMatchObject({ kind: 'leaf', sessionId: 's1' })
  })
})

describe('sideAt', () => {
  const rect = { left: 0, top: 0, width: 400, height: 100 }
  it('elige el borde más cercano en proporción al tamaño', () => {
    expect(sideAt(rect, 20, 50)).toBe('left')
    expect(sideAt(rect, 390, 50)).toBe('right')
    expect(sideAt(rect, 200, 10)).toBe('top')
    expect(sideAt(rect, 200, 95)).toBe('bottom')
  })
})

describe('movePane', () => {
  const leafOf = (sid: string): string => leaves(activeTab().root).find((l) => l.sessionId === sid)!.id

  it('de lado a lado a uno encima del otro: soltar s1 abajo de s2', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().movePane(activeTab().id, leafOf('s1'), leafOf('s2'), 'bottom')

    expect(activeTab().root).toMatchObject({ kind: 'split', dir: 'col', sizes: [0.5, 0.5] })
    expect(sessionsOf(activeTab().root)).toEqual(['s2', 's1'])
    expect(focusedSessionId(lay(), WS)).toBe('s1')
  })

  it('en un split de la misma dirección entra como hermano y reparte el tamaño del destino', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'row', 's3')
    lay().movePane(activeTab().id, leafOf('s3'), leafOf('s1'), 'left')

    const root = activeTab().root
    expect(root).toMatchObject({ kind: 'split', dir: 'row' })
    expect(sessionsOf(root)).toEqual(['s3', 's1', 's2'])
    expect((root as { sizes: number[] }).sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1)
  })

  it('sin destino va al borde del tab ocupando todo el ancho', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'col', 's3')
    lay().movePane(activeTab().id, leafOf('s1'), null, 'bottom')

    const root = activeTab().root
    // Lo que queda (s2 sobre s3) ya va en columna: s1 entra como tercer hijo, sin anidar.
    expect(root).toMatchObject({ kind: 'split', dir: 'col' })
    expect((root as { children: LayoutNode[] }).children.map((c) => c.kind === 'leaf' && c.sessionId)).toEqual(['s2', 's3', 's1'])
  })

  it('a sí mismo o a un pane de otro tab no hace nada', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    const before = activeTab().root
    lay().movePane(activeTab().id, leafOf('s1'), leafOf('s1'), 'left')
    lay().movePane(activeTab().id, leafOf('s1'), 'otro', 'left')
    expect(activeTab().root).toBe(before)
  })
})

describe('moveFocused', () => {
  it('con vecino en esa dirección intercambia y el foco sigue a la sesión', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    const left = leaves(activeTab().root)[0].id
    lay().moveFocused(WS, 'left', left)

    expect(sessionsOf(activeTab().root)).toEqual(['s2', 's1'])
    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })

  it('sin vecino pasa al borde: de arriba a la derecha', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'col', 's2')
    lay().moveFocused(WS, 'right', null)

    expect(activeTab().root).toMatchObject({ kind: 'split', dir: 'row' })
    expect(sessionsOf(activeTab().root)).toEqual(['s1', 's2'])
    expect(focusedSessionId(lay(), WS)).toBe('s2')
  })
})

describe('breakFocused', () => {
  it('saca el pane con foco a un tab nuevo activo', () => {
    const original = lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().breakFocused(WS)

    expect(tabsOf(lay(), WS)).toHaveLength(2)
    expect(lay().tabs.find((t) => t.id === original.id)?.root).toMatchObject({ kind: 'leaf', sessionId: 's1' })
    expect(focusedSessionId(lay(), WS)).toBe('s2')
    expect(activeTab().id).not.toBe(original.id)
  })

  it('con una sola hoja no hace nada', () => {
    lay().openTab(WS, 's1')
    lay().breakFocused(WS)

    expect(tabsOf(lay(), WS)).toHaveLength(1)
  })
})

describe('leaves', () => {
  it('devuelve las hojas en orden de árbol', () => {
    lay().openTab(WS, 's1')
    lay().split(WS, 'row', 's2')
    lay().split(WS, 'col', 's3')

    expect(sessionsOf(activeTab().root)).toEqual(['s1', 's2', 's3'])
  })
})
