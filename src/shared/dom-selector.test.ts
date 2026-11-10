import { describe, expect, it } from 'vitest'
import { hintLabels, shortSelector, type SelectorNode } from './dom-selector'

/** Árbol DOM mínimo: `el('div', { classes }, [hijos])` enlaza padre y hermanos como el DOM real. */
function el(tag: string, attrs: { id?: string; classes?: string[] } = {}, children: SelectorNode[] = []): SelectorNode {
  const node: SelectorNode = {
    tagName: tag.toUpperCase(),
    id: attrs.id ?? '',
    classList: attrs.classes ?? [],
    parentElement: null,
    previousElementSibling: null,
    nextElementSibling: null
  }
  children.forEach((child, i) => {
    child.parentElement = node
    child.previousElementSibling = children[i - 1] ?? null
    child.nextElementSibling = children[i + 1] ?? null
  })
  return node
}

describe('hintLabels', () => {
  it('hasta 26 elementos usa una sola letra', () => {
    expect(hintLabels(0)).toEqual([])
    expect(hintLabels(3)).toEqual(['a', 'b', 'c'])
    const all = hintLabels(26)
    expect(all).toHaveLength(26)
    expect(all[0]).toBe('a')
    expect(all[25]).toBe('z')
  })

  it('con más de 26 TODAS son de dos letras, sin prefijos ambiguos', () => {
    const labels = hintLabels(27)
    expect(labels).toHaveLength(27)
    expect(labels.every((l) => l.length === 2)).toBe(true)
    expect(labels.slice(0, 3)).toEqual(['aa', 'ab', 'ac'])
    expect(labels[26]).toBe('ba')
    expect(new Set(labels).size).toBe(27)
  })

  it('tope de 676 y nunca negativo', () => {
    expect(hintLabels(1000)).toHaveLength(676)
    expect(hintLabels(-5)).toEqual([])
  })
})

describe('shortSelector', () => {
  it('un id corta la subida', () => {
    const target = el('span', { classes: ['label'] })
    const card = el('div', { id: 'card-1' }, [target])
    el('body', {}, [el('main', {}, [card])])
    expect(shortSelector(target)).toBe('#card-1 > span.label')
    expect(shortSelector(card)).toBe('#card-1')
  })

  it('tag + clases limpias + nth-of-type solo si hay hermanos del mismo tag', () => {
    const a = el('a', { classes: ['nav-link'] })
    const b = el('a', { classes: ['nav-link', 'active'] })
    const h = el('h2', {})
    const nav = el('nav', { classes: ['site-nav'] }, [h, a, b])
    el('body', {}, [nav])
    expect(shortSelector(a)).toBe('nav.site-nav > a.nav-link:nth-of-type(1)')
    expect(shortSelector(b)).toBe('nav.site-nav > a.nav-link.active:nth-of-type(2)')
    expect(shortSelector(h)).toBe('nav.site-nav > h2')
  })

  it('máximo tres niveles y nunca incluye body', () => {
    const leaf = el('button', {})
    const l3 = el('div', { classes: ['c'] }, [leaf])
    const l2 = el('div', { classes: ['b'] }, [l3])
    const l1 = el('div', { classes: ['a'] }, [l2])
    el('body', {}, [l1])
    expect(shortSelector(leaf)).toBe('div.b > div.c > button')
    expect(shortSelector(l1)).toBe('div.a')
  })

  it('descarta clases generadas o no válidas y usa como mucho dos', () => {
    const node = el('div', { classes: ['css-1x2y3z', 'sc-bdfBwQ', 'md:flex', 'w-96', 'card', 'card--wide', 'extra'] })
    el('body', {}, [node])
    expect(shortSelector(node)).toBe('div.card.card--wide')
  })

  it('tags en mayúscula del DOM y SVG en minúscula se normalizan', () => {
    const svg: SelectorNode = { tagName: 'svg', id: '', classList: [], parentElement: null, previousElementSibling: null, nextElementSibling: null }
    const wrap = el('DIV', { classes: ['icon'] }, [svg])
    el('BODY', {}, [wrap])
    expect(shortSelector(svg)).toBe('div.icon > svg')
  })
})
