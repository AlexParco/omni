import { describe, expect, it } from 'vitest'
import { elementPickScript, elementsClearScript, elementsScript, HINTS_ATTR, MAX_HINTS, MAX_HTML } from './browser-elements'

/** Los scripts son expresiones IIFE: si no parsean, `new Function` lanza SyntaxError sin ejecutar nada. */
function parses(code: string): void {
  expect(() => new Function(`return ${code}`)).not.toThrow()
}

describe('scripts del modo elemento', () => {
  it('los tres scripts son JS válido', () => {
    parses(elementsScript())
    parses(elementPickScript('aa'))
    parses(elementsClearScript())
  })

  it('llevan incrustada la lógica compartida, el contenedor y los topes', () => {
    const code = elementsScript()
    expect(code).toContain('function hintLabels')
    expect(code).toContain('function shortSelector')
    expect(code).toContain(HINTS_ATTR)
    expect(code).toContain('window.__omniHints = map')
    expect(code).toContain(`Math.min(picked.length, ${MAX_HINTS})`)
    expect(code).toContain('elementFromPoint')
  })

  it('los hints se recolocan en scroll y resize, y clear quita los listeners', () => {
    expect(elementsScript()).toContain("window.addEventListener('scroll', handler, true)")
    expect(elementsScript()).toMatch(/listen\(\);\n\s*return out;/)
    expect(elementPickScript('a')).toContain('window.__omniPick = hint')
    expect(elementsClearScript()).toContain("window.removeEventListener('scroll', handler, true)")
    expect(elementsClearScript()).toContain('delete window.__omniReflow')
  })

  it('el hint elegido va escapado como literal JSON (ni inyección ni comillas sueltas)', () => {
    const code = elementPickScript(`a"); alert(1); ("`)
    expect(code).toContain(JSON.stringify(`a"); alert(1); ("`))
    parses(code)
  })

  it('el pick recorta el outerHTML y arma el bloque CSS con el selector', () => {
    const code = elementPickScript('b')
    expect(code).toContain(`html.length > ${MAX_HTML}`)
    expect(code).toContain("selector + ' {\\n'")
    expect(code).toContain('#f97316')
  })

  it('las funciones compartidas no dependen de nada fuera de su cuerpo', () => {
    // Si `hintLabels`/`shortSelector` referenciaran símbolos del módulo, en la página serían ReferenceError.
    const fn = new Function(`${elementsClearScript().replace(/^\(\(\) => \{/, '').replace(/clearAll\(\);\n\}\)\(\)$/, '')} return { hintLabels, shortSelector }`) as () => {
      hintLabels: (n: number) => string[]
      shortSelector: (el: unknown) => string
    }
    const { hintLabels, shortSelector } = fn()
    expect(hintLabels(2)).toEqual(['a', 'b'])
    expect(shortSelector({ tagName: 'DIV', id: 'x', classList: [], parentElement: null, previousElementSibling: null, nextElementSibling: null })).toBe('#x')
  })
})
