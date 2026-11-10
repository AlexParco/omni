import { hintLabels, shortSelector } from '@shared/dom-selector'

/**
 * Scripts del modo elemento (ARCHITECTURE §3.9) que `BrowserService` inyecta en la página con
 * `executeJavaScriptInIsolatedWorld`: solo leen el DOM y dibujan un contenedor propio
 * (`<div data-omni-hints>`), nunca tocan el estado de la página. Van como strings porque main
 * compila sin `lib: dom`; la lógica pura (letras, selector) vive tipada en `shared/dom-selector.ts`
 * y se incrusta con `toString()`. El mapa letra → elemento queda en `window.__omniHints` del
 * isolated world: la página no lo ve.
 */

/** Atributo del contenedor de hints; también lo usa el renderer para saber que es nuestro. */
export const HINTS_ATTR = 'data-omni-hints'

/** Isolated world donde corren los scripts: distinto del main world (0) y del de preload (999). */
export const OMNI_WORLD = 1337

/** Tope de hints por pantalla: más letras que esto no se leen. */
export const MAX_HINTS = 120

/** Elementos más chicos que esto (px CSS) no reciben hint. */
export const MIN_SIZE = 12

/** Bloques (section, article, li) solo si son "grandes": tarjetas, no viñetas de texto. */
const MIN_BLOCK_WIDTH = 160
const MIN_BLOCK_HEIGHT = 80

/** Elementos recorridos como máximo buscando `cursor: pointer` fuera de los selectores conocidos. */
const MAX_SCAN = 4000

/** `outerHTML` recortado a esto (bytes aproximados: chars). */
export const MAX_HTML = 8 * 1024

/** Texto visible recortado a esto. */
const MAX_TEXT = 80

/** Estilo de las etiquetas, inline: la página no tiene nuestras tokens. Mismo look que el mockup. */
const HINT_STYLE =
  'position:absolute;background:#0a0a0a;color:#fafafa;font:500 10.5px/14px ui-monospace,"Geist Mono",Menlo,monospace;' +
  'padding:1px 5px;border-radius:3px;white-space:nowrap;box-shadow:0 0 0 1px rgba(250,250,250,.25);pointer-events:none;'

/** La etiqueta del elegido: naranja con texto oscuro. */
const PICK_STYLE =
  'position:absolute;background:#f97316;color:#0a0a0a;font:500 10.5px/14px ui-monospace,"Geist Mono",Menlo,monospace;' +
  'padding:1px 5px;border-radius:3px;white-space:nowrap;pointer-events:none;'

/** Contorno del elegido: caja del tamaño del elemento con outline naranja de 2 px a 2 px. */
const RING_STYLE = 'position:absolute;outline:2px solid #f97316;outline-offset:2px;pointer-events:none;'

const CONTAINER_STYLE = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;'

/** Selectores de lo que siempre merece hint (si es visible y mide ≥ MIN_SIZE). */
const INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,h1,h2,h3,h4,table,img,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[tabindex]'

/** Bloques que solo entran si son grandes. */
const BLOCK_SELECTOR = 'section,article,li'

/** Propiedades computadas que se adjuntan al agente, en este orden. */
const CSS_BASE = [
  'display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'border', 'border-radius',
  'background-color', 'color', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'text-align', 'gap', 'opacity', 'box-shadow', 'overflow'
]
const CSS_FLEX = ['flex-direction', 'flex-wrap', 'justify-content', 'align-items']
const CSS_GRID = ['grid-template-columns', 'grid-template-rows', 'justify-items', 'align-items']
/** Si el padre es flex/grid, también cómo se coloca el elemento dentro. */
const CSS_FLEX_CHILD = ['flex', 'align-self']
const CSS_GRID_CHILD = ['grid-column', 'grid-row', 'align-self']

/** Valores por defecto que no aportan: se omiten del bloque. */
const CSS_DEFAULTS: Record<string, string> = {
  position: 'static',
  margin: '0px',
  'border-radius': '0px',
  'background-color': 'rgba(0, 0, 0, 0)',
  'letter-spacing': 'normal',
  gap: 'normal',
  opacity: '1',
  'box-shadow': 'none',
  overflow: 'visible',
  flex: '0 1 auto',
  'flex-wrap': 'nowrap',
  'align-self': 'auto',
  'grid-column': 'auto',
  'grid-row': 'auto',
  'justify-items': 'normal'
}

/** Helpers que comparten los tres scripts: se incrustan dentro de cada IIFE. */
function prelude(): string {
  return `
  const ATTR = ${JSON.stringify(HINTS_ATTR)};
  const hintLabels = ${hintLabels.toString()};
  const shortSelector = ${shortSelector.toString()};
  const MAX_TEXT = ${MAX_TEXT};
  const container = () => document.querySelector('[' + ATTR + ']');
  /* coloca una etiqueta normal en la esquina superior izquierda del rect; fuera del viewport se esconde */
  const placeHint = (label, rect) => {
    label.style.display = rect.width > 0 && rect.height > 0 ? '' : 'none';
    label.style.left = Math.max(0, Math.min(rect.x, window.innerWidth - 28)) + 'px';
    label.style.top = Math.max(0, rect.y) + 'px';
  };
  /* la etiqueta del elegido va encima del contorno; si no cabe arriba, debajo; si tampoco, dentro */
  const placePick = (label, ring, rect) => {
    const visible = rect.width > 0 && rect.height > 0;
    label.style.display = visible ? '' : 'none';
    ring.style.display = visible ? '' : 'none';
    const vh = window.innerHeight;
    const top = rect.y >= 18 ? rect.y - 18 : (rect.y + rect.height + 22 <= vh ? rect.y + rect.height + 6 : rect.y + 2);
    label.style.left = Math.max(0, rect.x - 2) + 'px';
    label.style.top = top + 'px';
    ring.style.left = rect.x + 'px';
    ring.style.top = rect.y + 'px';
    ring.style.width = rect.width + 'px';
    ring.style.height = rect.height + 'px';
  };
  /* recoloca etiquetas y contorno con los rects actuales (tras scroll o resize) */
  const reflow = () => {
    const box = container();
    const map = window.__omniHints;
    if (!box || !map) return;
    const ring = box.querySelector('[data-omni-ring]');
    for (const label of box.querySelectorAll('[data-omni-hint]')) {
      const hint = label.getAttribute('data-omni-hint');
      const el = map[hint];
      if (!el || !el.isConnected) { label.remove(); continue; }
      const rect = clippedRect(el);
      if (ring && hint === window.__omniPick) placePick(label, ring, rect); else placeHint(label, rect);
    }
  };
  /* scroll (en captura: también los contenedores con overflow) y resize, coalescidos con rAF */
  const listen = () => {
    if (window.__omniReflow) return;
    let raf = 0;
    const handler = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; reflow(); }); };
    window.__omniReflow = handler;
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
  };
  const clearAll = () => {
    const old = container();
    if (old) old.remove();
    delete window.__omniHints;
    delete window.__omniPick;
    const handler = window.__omniReflow;
    if (handler) {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
      delete window.__omniReflow;
    }
  };
  /* rect del elemento recortado al viewport, en px CSS de la vista (lo que espera capturePage) */
  const clippedRect = (el) => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const x = Math.round(Math.max(r.left, 0)), y = Math.round(Math.max(r.top, 0));
    const w = Math.round(Math.min(r.right, vw)) - x, h = Math.round(Math.min(r.bottom, vh)) - y;
    return { x, y, width: Math.max(0, w), height: Math.max(0, h) };
  };
  /* texto visible; nunca el value de un campo (contraseñas, datos del usuario) */
  const textOf = (el) => {
    const tag = el.tagName.toLowerCase();
    let t = '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') t = el.placeholder || el.getAttribute('aria-label') || el.name || el.type || '';
    else if (tag === 'img') t = el.alt || el.title || '';
    else t = el.getAttribute('aria-label') || el.innerText || el.textContent || '';
    t = String(t).replace(/\\s+/g, ' ').trim();
    return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 1) + '…' : t;
  };
  `
}

/**
 * Enciende el modo elemento: borra hints previos, lista los elementos visibles con sentido,
 * dibuja una letra sobre cada uno y devuelve `ElementHint[]`. Guarda letra → elemento en
 * `window.__omniHints` (del isolated world) para `elementPickScript`.
 */
export function elementsScript(): string {
  return `(() => {
  ${prelude()}
  clearAll();
  const root = document.body;
  if (!root) return [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const seen = new Set();
  const byRect = new Set();
  const picked = [];
  const consider = (el, big) => {
    if (seen.has(el)) return;
    seen.add(el);
    const r = el.getBoundingClientRect();
    if (r.width < ${MIN_SIZE} || r.height < ${MIN_SIZE}) return;
    if (big && (r.width < ${MIN_BLOCK_WIDTH} || r.height < ${MIN_BLOCK_HEIGHT})) return;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) === 0) return;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return;
    const rect = clippedRect(el);
    if (rect.width < ${MIN_SIZE} || rect.height < ${MIN_SIZE}) return;
    /* tapado por otra cosa (modal, menú): alguno de cinco puntos (centro y cuartos) tiene que caer dentro del elemento */
    const visibleAt = (fx, fy) => {
      const hit = document.elementFromPoint(rect.x + rect.width * fx, rect.y + rect.height * fy);
      return !!hit && (el.contains(hit) || hit.contains(el));
    };
    if (!(visibleAt(0.5, 0.5) || visibleAt(0.25, 0.25) || visibleAt(0.75, 0.25) || visibleAt(0.25, 0.75) || visibleAt(0.75, 0.75))) return;
    /* un hijo que ocupa exactamente lo mismo que su padre (img dentro de a) no suma */
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (byRect.has(key)) return;
    byRect.add(key);
    picked.push({ el, rect });
  };
  for (const el of root.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)})) consider(el, false);
  for (const el of root.querySelectorAll(${JSON.stringify(BLOCK_SELECTOR)})) consider(el, true);
  /* lo clicable sin semántica: onclick por propiedad o cursor pointer propio (no heredado del padre) */
  const all = root.querySelectorAll('*');
  for (let i = 0; i < all.length && i < ${MAX_SCAN}; i++) {
    const el = all[i];
    if (seen.has(el)) continue;
    const pointer = typeof el.onclick === 'function' || (getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && getComputedStyle(el.parentElement).cursor === 'pointer'));
    if (pointer) consider(el, false);
  }
  /* orden de lectura y tope */
  picked.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  picked.length = Math.min(picked.length, ${MAX_HINTS});
  const labels = hintLabels(picked.length);
  const box = document.createElement('div');
  box.setAttribute(ATTR, '');
  box.style.cssText = ${JSON.stringify(CONTAINER_STYLE)};
  const map = {};
  const out = [];
  picked.forEach((p, i) => {
    const hint = labels[i];
    map[hint] = p.el;
    const label = document.createElement('span');
    label.textContent = hint;
    label.setAttribute('data-omni-hint', hint);
    label.style.cssText = ${JSON.stringify(HINT_STYLE)};
    placeHint(label, p.rect);
    box.appendChild(label);
    out.push({ hint, selector: shortSelector(p.el), tag: p.el.tagName.toLowerCase(), text: textOf(p.el), rect: p.rect });
  });
  document.documentElement.appendChild(box);
  window.__omniHints = map;
  listen();
  return out;
})()`
}

/**
 * Elige un elemento por su letra: deja solo su etiqueta (en naranja, con `hint · selector · w×h`),
 * le dibuja el contorno y devuelve `BrowserElement` (o `null` si la letra no existe o el
 * elemento ya no está en el DOM). El resaltado se queda hasta `elementsClearScript`.
 */
export function elementPickScript(hint: string): string {
  return `(() => {
  ${prelude()}
  const hint = ${JSON.stringify(hint)};
  const map = window.__omniHints;
  const el = map && map[hint];
  if (!el || !el.isConnected) return null;
  let box = container();
  if (!box) {
    box = document.createElement('div');
    box.setAttribute(ATTR, '');
    box.style.cssText = ${JSON.stringify(CONTAINER_STYLE)};
    document.documentElement.appendChild(box);
  }
  for (const s of box.querySelectorAll('[data-omni-hint]')) if (s.getAttribute('data-omni-hint') !== hint) s.remove();
  for (const s of box.querySelectorAll('[data-omni-ring]')) s.remove();
  const full = el.getBoundingClientRect();
  const rect = clippedRect(el);
  const selector = shortSelector(el);
  const size = Math.round(full.width) + '×' + Math.round(full.height);
  let label = box.querySelector('[data-omni-hint="' + hint + '"]');
  if (!label) {
    label = document.createElement('span');
    label.setAttribute('data-omni-hint', hint);
    box.appendChild(label);
  }
  label.textContent = hint + ' · ' + selector + ' · ' + size;
  label.style.cssText = ${JSON.stringify(PICK_STYLE)};
  const ring = document.createElement('div');
  ring.setAttribute('data-omni-ring', '');
  ring.style.cssText = ${JSON.stringify(RING_STYLE)};
  box.appendChild(ring);
  placePick(label, ring, rect);
  /* el reflow (scroll/resize) sabe que esta etiqueta es la elegida; el mapa se queda con solo este elemento */
  window.__omniPick = hint;
  window.__omniHints = { [hint]: el };
  listen();
  /* css computado relevante */
  const cs = getComputedStyle(el);
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
  const props = [...${JSON.stringify(CSS_BASE)}];
  if (/flex/.test(cs.display)) props.push(...${JSON.stringify(CSS_FLEX)});
  if (/grid/.test(cs.display)) props.push(...${JSON.stringify(CSS_GRID)});
  if (parent && /flex/.test(parent.display)) props.push(...${JSON.stringify(CSS_FLEX_CHILD)});
  if (parent && /grid/.test(parent.display)) props.push(...${JSON.stringify(CSS_GRID_CHILD)});
  const defaults = ${JSON.stringify(CSS_DEFAULTS)};
  const lines = [];
  const done = new Set();
  for (const prop of props) {
    if (done.has(prop)) continue;
    done.add(prop);
    const value = cs.getPropertyValue(prop).trim();
    if (!value || value === defaults[prop]) continue;
    if (prop === 'border' && /^0px none/.test(value)) continue;
    lines.push('  ' + prop + ': ' + value + ';');
  }
  const css = selector + ' {\\n' + lines.join('\\n') + '\\n}';
  let html = el.outerHTML;
  if (html.length > ${MAX_HTML}) html = html.slice(0, ${MAX_HTML}) + '…';
  return { selector, tag: el.tagName.toLowerCase(), text: textOf(el), rect, html, css };
})()`
}

/** Apaga el modo elemento: borra hints, resaltado y el mapa. */
export function elementsClearScript(): string {
  return `(() => {
  ${prelude()}
  clearAll();
})()`
}
