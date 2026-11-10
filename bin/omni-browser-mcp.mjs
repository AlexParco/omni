#!/usr/bin/env node
// Servidor MCP `omni-browser` por stdio (ARCHITECTURE §3.23): el navegador embebido de omni manejado
// por un agente, al estilo de Claude in Chrome. Mismo núcleo que `omni-mcp` (JSON-RPC a mano, sin SDK);
// cada herramienta mapea 1:1 a un comando `page.<op>` del socket de control, que main resuelve sobre
// las vistas del navegador.
import { pathToFileURL } from 'node:url'
import { createMcpServer, main } from './omni-mcp.mjs'

const str = (description) => ({ type: 'string', description })
const numb = (description) => ({ type: 'number', description })
const session = { sessionId: str('Browser session id (or unique prefix) from tabs. Default: the browser the user last had on screen.') }
const obj = (properties, required = []) => ({ type: 'object', properties: { ...properties, ...session }, required, additionalProperties: false })
const COLORS = ['orange', 'red', 'yellow', 'green', 'blue', 'purple']

/** Herramientas; `command` es el tipo del socket. */
export const BROWSER_TOOLS = [
  {
    name: 'tabs',
    command: 'page.tabs',
    description: "List omni's browser panes: session id, URL, title, whether it is on screen, and which one is the default target.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'navigate',
    command: 'page.navigate',
    description: 'Load a URL in the browser and wait for it to finish loading. Use "back", "forward" or "reload" as url for history. Opens a new browser pane if none exists or newTab is true.',
    inputSchema: obj({ url: str('URL (scheme optional), or back / forward / reload.'), newTab: { type: 'boolean', description: 'Open in a new browser pane.' } }, ['url'])
  },
  {
    name: 'read_page',
    command: 'page.read',
    description:
      'Read the page. mode "interactive" (default) lists controls with refs like [r12] (links, buttons, fields with their value and state) plus headings; "all" adds visible text; "text" returns plain innerText. Use refs with click, type, scroll and draw. Refs stay stable for an element until the page navigates.',
    inputSchema: obj({
      mode: { type: 'string', enum: ['interactive', 'all', 'text'], description: 'What to read. Default interactive.' },
      ref: str('Only read inside this element.'),
      viewport: { type: 'boolean', description: 'Only what is currently visible on screen.' }
    })
  },
  {
    name: 'click',
    command: 'page.click',
    description: 'Click an element by ref (scrolls it into view first; fails if something covers it), or at x,y in CSS pixels of the viewport (same coordinates as screenshot). Waits if the click starts a navigation.',
    inputSchema: obj({
      ref: str('Element ref from read_page.'),
      x: numb('Viewport x in CSS px.'),
      y: numb('Viewport y in CSS px.'),
      double: { type: 'boolean', description: 'Double click.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' }
    })
  },
  {
    name: 'type',
    command: 'page.type',
    description: 'Type text into the element with ref (clicked first) or into the focused element. clear replaces the current content. Does not press Enter: use press_key.',
    inputSchema: obj({ text: str('Text to insert.'), ref: str('Field ref from read_page.'), clear: { type: 'boolean', description: 'Select all existing content first so the text replaces it.' } }, ['text'])
  },
  {
    name: 'press_key',
    command: 'page.key',
    description: 'Press keys on the page, space separated: "Enter", "Tab", "Escape", "ArrowDown", "cmd+a Backspace", "shift+Tab". Modifiers: cmd, ctrl, alt, shift.',
    inputSchema: obj({ keys: str('Keys to press, in order.') }, ['keys'])
  },
  {
    name: 'scroll',
    command: 'page.scroll',
    description: 'Scroll the page (or the scrollable container around ref). With ref and no amount, scrolls that element into view. Default amount: most of a screen.',
    inputSchema: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Default down.' }, amount: numb('Pixels.'), ref: str('Element ref.') })
  },
  {
    name: 'screenshot',
    command: 'page.screenshot',
    description: 'Screenshot of what the browser shows, as an image. Pixel coordinates match click x,y (CSS px). Brings the pane on screen if hidden, without taking the keyboard.',
    inputSchema: obj({})
  },
  {
    name: 'draw',
    command: 'page.draw',
    description:
      'Draw annotations over the page so the user sees them in omni (and they appear in screenshot): box around a ref or x,y,w,h with an optional label; arrow from x,y to x2,y2 or to a ref; text label at x,y; numbered dot at x,y or on a ref. Coordinates are viewport CSS px; marks stick to the page when scrolling. clear removes previous marks first (alone: just clears).',
    inputSchema: obj({
      shapes: {
        type: 'array',
        description: 'Shapes to draw (max 50).',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['box', 'arrow', 'text', 'dot'] },
            ref: str('Element ref (box, arrow target, dot).'),
            x: numb('x (box, arrow start, text, dot).'),
            y: numb('y.'),
            w: numb('Box width.'),
            h: numb('Box height.'),
            x2: numb('Arrow end x.'),
            y2: numb('Arrow end y.'),
            label: str('Text: box caption, arrow note, the text itself, or the dot number.'),
            color: { type: 'string', enum: COLORS, description: 'Default orange.' }
          },
          required: ['kind'],
          additionalProperties: false
        }
      },
      clear: { type: 'boolean', description: 'Remove existing marks first.' }
    })
  },
  {
    name: 'console',
    command: 'page.console',
    description: 'Last console messages of the page (errors, warnings, logs), optionally filtered by a case-insensitive regex.',
    inputSchema: obj({ pattern: str('Regex filter.'), lines: numb('How many lines (max 200, default 50).') })
  },
  {
    name: 'eval',
    command: 'page.eval',
    description: "Run JavaScript in the page's own context (sees its globals) and return the value of the last expression (promises are awaited, objects as JSON).",
    inputSchema: obj({ code: str('JavaScript.') }, ['code'])
  },
  {
    name: 'wait_for',
    command: 'page.wait',
    description: 'Wait until text appears on the page or a CSS selector is visible (or, with gone, until they disappear), or just wait ms.',
    inputSchema: obj({ text: str('Text to wait for.'), selector: str('CSS selector to wait for.'), gone: { type: 'boolean', description: 'Wait for it to disappear.' }, ms: numb('Fixed wait in ms.'), timeout: numb('Max ms (default 10000, max 60000).') })
  }
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.stdin, process.stdout, createMcpServer({ tools: BROWSER_TOOLS, name: 'omni-browser' }))
}
