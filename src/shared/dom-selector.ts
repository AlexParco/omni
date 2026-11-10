/**
 * Lógica pura del modo elemento (ARCHITECTURE §3.9), compartida entre main y la página embebida.
 * Main la inyecta en la página con `Function.prototype.toString`, así que cada función exportada
 * tiene que ser AUTOCONTENIDA: sin imports, sin referencias a otros símbolos del módulo ni a
 * constantes externas. Dentro de la página solo existe el cuerpo de la función.
 */

/**
 * Lo que `shortSelector` necesita de un nodo. Un `Element` real del DOM lo cumple tal cual
 * (`classList` es `ArrayLike<string>`), y en tests se construye a mano.
 */
export interface SelectorNode {
  tagName: string
  id: string
  classList: ArrayLike<string>
  parentElement: SelectorNode | null
  previousElementSibling: SelectorNode | null
  nextElementSibling: SelectorNode | null
}

/**
 * Letras de atajo para `n` elementos: hasta 26 una sola letra (`a`…`z`); con más, TODAS de dos
 * letras (`aa`, `ab`…) para que ninguna sea prefijo de otra y la primera pulsación nunca elija.
 * Tope: 676.
 */
export function hintLabels(n: number): string[] {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const out: string[] = []
  const count = Math.max(0, Math.min(n, 676))
  if (count <= 26) {
    for (let i = 0; i < count; i++) out.push(letters[i] as string)
    return out
  }
  for (let i = 0; i < count; i++) out.push((letters[Math.floor(i / 26)] as string) + (letters[i % 26] as string))
  return out
}

/**
 * Selector CSS corto y estable: `#id` si lo hay; si no, `tag` + hasta dos clases "limpias"
 * (sin pinta de generadas: hashes, prefijos de CSS-in-JS, utilidades con `:` o `[`) y
 * `:nth-of-type` solo cuando hay hermanos del mismo tag. Sube como mucho tres niveles y se
 * detiene en el primer `#id` o al llegar a `body`.
 */
export function shortSelector(el: SelectorNode): string {
  const IDENT = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/
  // Prefijos de CSS-in-JS, dos dígitos seguidos (`w-96`, `css-1x2y3z`) o dos mayúsculas (`sc-bdfBwQ`) huelen a generado.
  const GENERATED = /^(css|sc|jsx|svelte|emotion|chakra|mui|styled)-|\d{2}|[A-Z]{2}/
  const cleanClasses = (node: SelectorNode): string[] => {
    const out: string[] = []
    for (let i = 0; i < node.classList.length && out.length < 2; i++) {
      const c = node.classList[i] as string
      if (IDENT.test(c) && !GENERATED.test(c)) out.push(c)
    }
    return out
  }
  const levelOf = (node: SelectorNode): { text: string; final: boolean } => {
    const tag = node.tagName.toLowerCase()
    if (node.id && IDENT.test(node.id)) return { text: '#' + node.id, final: true }
    let text = tag + cleanClasses(node).map((c) => '.' + c).join('')
    let index = 1
    let others = false
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName.toLowerCase() === tag) {
        index++
        others = true
      }
    }
    for (let s = node.nextElementSibling; s && !others; s = s.nextElementSibling) {
      if (s.tagName.toLowerCase() === tag) others = true
    }
    if (others) text += ':nth-of-type(' + index + ')'
    return { text, final: false }
  }
  const parts: string[] = []
  let node: SelectorNode | null = el
  for (let depth = 0; node && depth < 3; depth++) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') break
    const level = levelOf(node)
    parts.unshift(level.text)
    if (level.final) break
    node = node.parentElement
  }
  return parts.join(' > ')
}
