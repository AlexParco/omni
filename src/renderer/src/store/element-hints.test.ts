import { describe, expect, it } from 'vitest'
import type { ElementHint } from '@shared/types'
import { stepHint } from './element-hints'

const hint = (h: string): ElementHint => ({ hint: h, selector: `#${h}`, tag: 'div', text: h, rect: { x: 0, y: 0, width: 1, height: 1 } })

describe('stepHint', () => {
  const single = ['a', 'b', 'c'].map(hint)
  const double = ['aa', 'ab', 'b', 'ca'].map(hint)

  it('una letra que coincide elige al toque', () => {
    expect(stepHint(single, '', 'b')).toEqual({ kind: 'pick', hint: single[1] })
  })

  it('con hints de dos letras acumula la primera y elige con la segunda', () => {
    expect(stepHint(double, '', 'a')).toEqual({ kind: 'partial', typed: 'a' })
    expect(stepHint(double, 'a', 'b')).toEqual({ kind: 'pick', hint: double[1] })
    expect(stepHint(double, '', 'b')).toEqual({ kind: 'pick', hint: double[2] })
  })

  it('una letra sin hint no hace nada y descarta lo acumulado', () => {
    expect(stepHint(single, '', 'z')).toEqual({ kind: 'none' })
    expect(stepHint(double, 'a', 'z')).toEqual({ kind: 'none' })
  })

  it('tras un prefijo acumulado, una letra que empieza otro hint lo retoma', () => {
    expect(stepHint(double, 'a', 'c')).toEqual({ kind: 'partial', typed: 'c' })
    expect(stepHint(double, 'c', 'b')).toEqual({ kind: 'pick', hint: double[2] })
  })

  it('ignora lo que no es una letra minúscula', () => {
    expect(stepHint(single, '', 'A')).toEqual({ kind: 'none' })
    expect(stepHint(single, '', 'enter')).toEqual({ kind: 'none' })
    expect(stepHint(single, '', '1')).toEqual({ kind: 'none' })
  })
})
