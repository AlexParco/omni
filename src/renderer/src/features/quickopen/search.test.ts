import { describe, expect, it } from 'vitest'
import { completePath, fuzzyMatch, nextKind, parseQuery, pathQuery, quoteForShell, rank, withKind } from './search'

describe('parseQuery / withKind / nextKind', () => {
  it('reconoce los prefijos y limpia espacios', () => {
    expect(parseQuery('')).toEqual({ kind: 'all', text: '' })
    expect(parseQuery('  foo ')).toEqual({ kind: 'all', text: 'foo' })
    expect(parseQuery(':split')).toEqual({ kind: 'command', text: 'split' })
    expect(parseQuery('@ claude')).toEqual({ kind: 'agent', text: 'claude' })
    expect(parseQuery('/src/app')).toEqual({ kind: 'file', text: 'src/app' })
    expect(parseQuery(':')).toEqual({ kind: 'command', text: '' })
  })

  it('withKind reescribe solo el prefijo', () => {
    expect(withKind('foo', 'command')).toBe(':foo')
    expect(withKind(':foo', 'agent')).toBe('@foo')
    expect(withKind('@foo', 'file')).toBe('/foo')
    expect(withKind('/foo', 'all')).toBe('foo')
    expect(withKind('', 'file')).toBe('/')
  })

  it('nextKind rota con vuelta en ambos sentidos', () => {
    expect(nextKind('all')).toBe('command')
    expect(nextKind('command')).toBe('agent')
    expect(nextKind('agent')).toBe('file')
    expect(nextKind('file')).toBe('all')
    expect(nextKind('all', -1)).toBe('file')
  })
})

describe('fuzzyMatch', () => {
  it('consulta vacía casa con todo sin rangos; sin subsecuencia devuelve null', () => {
    expect(fuzzyMatch('', 'lo que sea')).toEqual({ score: 0, ranges: [] })
    expect(fuzzyMatch('xyz', 'abc')).toBeNull()
    expect(fuzzyMatch('abcd', 'abc')).toBeNull()
  })

  it('es case-insensitive y devuelve rangos sobre el texto original', () => {
    const m = fuzzyMatch('SPL', 'Split a la derecha')
    expect(m).not.toBeNull()
    expect(m?.ranges).toEqual([[0, 3]])
  })

  it('prefiere inicio de palabra y letras consecutivas', () => {
    // "cod" cabe disperso en "nuevo codex" (c de... no: la primera c está en Codex) y entero en Codex:
    // la alineación entera en inicio de palabra debe ganar y resaltar "Cod".
    const m = fuzzyMatch('cod', 'Nuevo Codex')
    expect(m?.ranges).toEqual([[6, 9]])
    // "nc" cae en N de Nuevo y C de Codex (dos inicios de palabra), no en la n y la c internas.
    expect(fuzzyMatch('nc', 'Nuevo Codex')?.ranges).toEqual([
      [0, 1],
      [6, 7]
    ])
  })

  it('puntúa más la coincidencia exacta de palabra que la dispersa', () => {
    const tight = fuzzyMatch('tab', 'Tab siguiente')?.score ?? 0
    const loose = fuzzyMatch('tab', 'Terminal abajo')?.score ?? 0
    expect(tight).toBeGreaterThan(loose)
  })

  it('entiende separadores de ruta y camelCase como inicio de palabra', () => {
    expect(fuzzyMatch('qo', 'src/features/QuickOpen.tsx')?.ranges).toEqual([
      [13, 14],
      [18, 19]
    ])
    expect(fuzzyMatch('ls', 'store/layout.ts')?.ranges).toEqual([
      [6, 7],
      [14, 15]
    ])
  })

  it('funde letras consecutivas en un solo rango', () => {
    expect(fuzzyMatch('paleta', 'Paleta de comandos')?.ranges).toEqual([[0, 6]])
    expect(fuzzyMatch('pdc', 'Paleta de comandos')?.ranges).toEqual([
      [0, 1],
      [7, 8],
      [10, 11]
    ])
  })
})

describe('rank', () => {
  const items = ['Tab siguiente', 'Terminal abajo', 'Pane abajo', 'Split a la derecha']
  it('sin consulta conserva el orden; con consulta ordena por puntuación', () => {
    expect(rank(items, '', (x) => x).map((r) => r.item)).toEqual(items)
    const r = rank(items, 'tab', (x) => x)
    expect(r[0].item).toBe('Tab siguiente')
    expect(r.map((x) => x.item)).not.toContain('Split a la derecha')
  })
  it('a igual puntuación gana el texto más corto', () => {
    const r = rank(['Pane abajo largo', 'Pane abajo'], 'pane', (x) => x)
    expect(r[0].item).toBe('Pane abajo')
  })
})

describe('quoteForShell', () => {
  it('deja tal cual las rutas simples', () => {
    expect(quoteForShell('src/app/App.tsx')).toBe('src/app/App.tsx')
    expect(quoteForShell('/Users/x/proyecto-1/a_b.ts')).toBe('/Users/x/proyecto-1/a_b.ts')
  })
  it('entrecomilla con comillas simples cuando hay espacios u otros caracteres', () => {
    expect(quoteForShell('docs/mi archivo.md')).toBe("'docs/mi archivo.md'")
    expect(quoteForShell('a$b(c).txt')).toBe("'a$b(c).txt'")
    expect(quoteForShell('ñandú.md')).toBe("'ñandú.md'")
  })
  it("escapa la comilla simple como '\\''", () => {
    expect(quoteForShell("it's.md")).toBe("'it'\\''s.md'")
  })
})

describe('pathQuery', () => {
  it('reconoce rutas de la carpeta de usuario; lo demás sigue siendo búsqueda', () => {
    expect(pathQuery('~')).toBe('~')
    expect(pathQuery(' ~/private/om ')).toBe('~/private/om')
    expect(pathQuery('/Users/ana/repo')).toBe('/Users/ana/repo')
    expect(pathQuery('/home/ana')).toBe('/home/ana')
    for (const q of ['', 'omni', '/src/app', '/Users', '~ana', ':cmd', '@claude']) expect(pathQuery(q)).toBeNull()
  })
})

describe('completePath', () => {
  it('cambia el último tramo por la carpeta y agrega la barra, en la forma escrita', () => {
    expect(completePath('~/priv', '/Users/ana/private')).toBe('~/private/')
    expect(completePath('~', '/Users/ana/private')).toBe('~/private/')
    expect(completePath('~/private/', '/Users/ana/private/omni')).toBe('~/private/omni/')
    expect(completePath('/Users/ana/pr', '/Users/ana/private')).toBe('/Users/ana/private/')
  })
})
