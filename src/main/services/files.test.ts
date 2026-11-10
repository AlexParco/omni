import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareHits, compareTreeEntries, FileIndex, FileWatcher, isIgnored, isInside, isInsideForWrite, listTree, MAX_TEXT_BYTES, parseGitignore, readTextFile, SCORE, scoreMatch, walkWorkspace, WatchLedger, writeTextFile, type WatchFn } from './files'

describe('parseGitignore', () => {
  it('entiende dir/, *.ext y nombres; ignora comentarios, vacíos, negaciones y comodines complejos', () => {
    const rules = parseGitignore(['# comentario', '', 'logs/', '*.log', '.env', '!keep.log', 'src/**/*.map', 'a?b', '[abc]', '/tmp/', '*.', '/'].join('\n'))
    expect(rules).toEqual([
      { kind: 'dir', name: 'logs' },
      { kind: 'ext', ext: 'log' },
      { kind: 'name', name: '.env' },
      { kind: 'dir', name: 'tmp' }
    ])
  })

  it('acepta CRLF y espacios alrededor', () => {
    expect(parseGitignore('  build/ \r\n*.tmp\r\n')).toEqual([
      { kind: 'dir', name: 'build' },
      { kind: 'ext', ext: 'tmp' }
    ])
  })
})

describe('isIgnored', () => {
  const rules = parseGitignore('logs/\n*.log\n.env')

  it('la lista fija aplica siempre', () => {
    expect(isIgnored('node_modules', true, [])).toBe(true)
    expect(isIgnored('.DS_Store', false, [])).toBe(true)
    expect(isIgnored('src', true, [])).toBe(false)
  })

  it('dir/ solo tumba carpetas; *.ext y nombres tumban cualquier entrada', () => {
    expect(isIgnored('logs', true, rules)).toBe(true)
    expect(isIgnored('logs', false, rules)).toBe(false)
    expect(isIgnored('app.LOG', false, rules)).toBe(true)
    expect(isIgnored('.log', false, rules)).toBe(false)
    expect(isIgnored('.env', false, rules)).toBe(true)
    expect(isIgnored('.env.example', false, rules)).toBe(false)
  })
})

describe('scoreMatch', () => {
  it('consulta vacía o sin subsecuencia → null', () => {
    expect(scoreMatch('', 'src/a.ts')).toBeNull()
    expect(scoreMatch('zz', 'src/a.ts')).toBeNull()
    expect(scoreMatch('ts/', 'src/a.ts')).toBeNull()
  })

  it('no distingue mayúsculas', () => {
    expect(scoreMatch('readme', 'README.md')).toBe(scoreMatch('README', 'readme.md'))
  })

  it('puntúa más el inicio de segmento, el nombre de archivo y las consecutivas', () => {
    // "ab" seguidos al inicio del nombre: 2 × char, 1 × segmentStart (solo la "a"), 2 × inName, 1 × consecutive (la "b").
    expect(scoreMatch('ab', 'x/ab')).toBe(2 * SCORE.char + SCORE.segmentStart + 2 * SCORE.inName + SCORE.consecutive)
    // Mismos chars sueltos y fuera del nombre.
    expect(scoreMatch('ab', 'xaxb/z')).toBe(2 * SCORE.char)
  })

  it('prefiere la coincidencia en el nombre a la dispersa por la ruta', () => {
    const inName = scoreMatch('index', 'src/index.ts') as number
    const spread = scoreMatch('index', 'i/n/d/e/x.ts') as number
    expect(inName).toBeGreaterThan(spread)
    expect(scoreMatch('idx', 'src/i/d/idx.ts')).toBeGreaterThan(scoreMatch('idx', 'src/i/d/x.ts') as number)
  })
})

describe('compareHits', () => {
  it('mayor puntuación primero; empate por ruta más corta y luego alfabético', () => {
    const hits = [
      { score: 1, rel: 'bb' },
      { score: 2, rel: 'zzz' },
      { score: 1, rel: 'a' },
      { score: 1, rel: 'ab' }
    ]
    expect([...hits].sort(compareHits).map((h) => h.rel)).toEqual(['zzz', 'a', 'ab', 'bb'])
  })
})

describe('isInside', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-inside-'))
    mkdirSync(join(dir, 'a', 'src'), { recursive: true })
    mkdirSync(join(dir, 'ab'))
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'a', 'src', 'x.ts'), '')
    writeFileSync(join(dir, 'ab', 'x.ts'), '')
    writeFileSync(join(dir, 'outside', 'secret.txt'), '')
    symlinkSync(join(dir, 'outside', 'secret.txt'), join(dir, 'a', 'leak.txt'))
    symlinkSync(join(dir, 'outside'), join(dir, 'a', 'leakdir'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('acepta la raíz y lo que cuelga de ella; rechaza hermanos con el mismo prefijo y escapes', () => {
    const root = join(dir, 'a')
    expect(isInside(root, [root])).toBe(true)
    expect(isInside(join(root, 'src', 'x.ts'), [root])).toBe(true)
    expect(isInside(join(dir, 'ab', 'x.ts'), [root])).toBe(false)
    expect(isInside(join(root, '..', 'ab', 'x.ts'), [root])).toBe(false)
    expect(isInside(join(root, 'src', 'x.ts'), [])).toBe(false)
  })

  it('un symlink dentro del workspace que apunta fuera no pasa; lo que no existe tampoco', () => {
    const root = join(dir, 'a')
    expect(isInside(join(root, 'leak.txt'), [root])).toBe(false)
    expect(isInside(join(root, 'leakdir', 'secret.txt'), [root])).toBe(false)
    expect(isInside(join(root, 'nope.ts'), [root])).toBe(false)
    expect(isInside(join(root, 'src', 'x.ts'), [join(dir, 'nope')])).toBe(false)
  })

  it('una ruta relativa nunca está dentro, aunque el cwd coincida', () => {
    const root = join(dir, 'a')
    const cwd = process.cwd()
    process.chdir(root)
    try {
      expect(isInside('src/x.ts', [root])).toBe(false)
      expect(isInside('.', [root])).toBe(false)
    } finally {
      process.chdir(cwd)
    }
  })

  it('compara raíces reales: una raíz que es symlink acepta sus archivos por la ruta real', () => {
    const linkRoot = join(dir, 'a-link')
    symlinkSync(join(dir, 'a'), linkRoot)
    expect(isInside(join(dir, 'a', 'src', 'x.ts'), [linkRoot])).toBe(true)
    expect(isInside(join(linkRoot, 'src', 'x.ts'), [join(dir, 'a')])).toBe(true)
  })
})

describe('walkWorkspace y FileIndex', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omni-files-'))
    const write = (rel: string): void => {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), '')
    }
    writeFileSync(join(root, '.gitignore'), 'logs/\n*.log\nsecret.txt\n')
    write('src/index.ts')
    write('src/app/App.tsx')
    write('README.md')
    write('logs/today.txt')
    write('src/debug.log')
    write('secret.txt')
    write('node_modules/x/index.js')
    write('.git/HEAD')
    write('dist/bundle.js')
    mkdirSync(join(root, 'empty'))
    symlinkSync(join(root, 'src'), join(root, 'link'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('recorre respetando la lista fija, el .gitignore y sin seguir symlinks', async () => {
    const files = await walkWorkspace(root)
    expect(files.sort()).toEqual(['.gitignore', 'README.md', 'src/app/App.tsx', 'src/index.ts'])
  })

  it('corta en el tope de entradas', async () => {
    expect(await walkWorkspace(root, 2)).toHaveLength(2)
  })

  it('una raíz inexistente da lista vacía', async () => {
    expect(await walkWorkspace(join(root, 'nope'))).toEqual([])
  })

  it('search: consulta vacía → []; devuelve hits con ruta absoluta, ordenados y acotados', async () => {
    const index = new FileIndex({ workspaces: () => [{ id: 'w1', path: root }] })
    expect(await index.search('')).toEqual([])
    expect(await index.search('   ')).toEqual([])
    const hits = await index.search('index')
    expect(hits[0]).toEqual({ workspaceId: 'w1', path: join(root, 'src/index.ts'), rel: 'src/index.ts' })
    expect(hits.every((h) => h.path.startsWith(root))).toBe(true)
    expect(await index.search('s', 1)).toHaveLength(1)
    expect(await index.search('zzzz')).toEqual([])
  })

  it('índice perezoso: no ve archivos nuevos hasta que caduca; luego refresca al consultar', async () => {
    let now = 1_000
    const index = new FileIndex({ workspaces: () => [{ id: 'w1', path: root }], now: () => now, refreshMs: 30_000 })
    expect(await index.search('readme')).toHaveLength(1)
    writeFileSync(join(root, 'readme2.md'), '')
    now += 10_000
    expect(await index.search('readme')).toHaveLength(1)
    now += 25_000
    // La consulta que detecta la caducidad responde con lo viejo y refresca en segundo plano.
    await index.search('readme')
    await index.refresh('w1')
    expect(await index.search('readme')).toHaveLength(2)
  })

  it('mezcla workspaces y olvida los que desaparecen', async () => {
    const other = mkdtempSync(join(tmpdir(), 'omni-files-b-'))
    try {
      writeFileSync(join(other, 'README.md'), '')
      let live = [
        { id: 'w1', path: root },
        { id: 'w2', path: other }
      ]
      const index = new FileIndex({ workspaces: () => live })
      expect((await index.search('readme')).map((h) => h.workspaceId).sort()).toEqual(['w1', 'w2'])
      live = [live[0]]
      expect((await index.search('readme')).map((h) => h.workspaceId)).toEqual(['w1'])
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('readTextFile / writeTextFile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-rw-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('lee texto UTF-8 con su mtime', async () => {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'hola ñandú\n')
    const r = await readTextFile(file)
    expect(r.text).toBe('hola ñandú\n')
    expect(r.mtime).toBe(statSync(file).mtimeMs)
  })

  it('rechaza binarios (NUL en los primeros 8 KB), carpetas, lo que no existe y lo que pasa de 2 MB', async () => {
    const bin = join(dir, 'a.bin')
    writeFileSync(bin, Buffer.from([0x50, 0x4b, 0x00, 0x01]))
    await expect(readTextFile(bin)).rejects.toThrow(/binario/)
    // Un NUL pasado el sondeo no cuenta como binario.
    const late = join(dir, 'late.txt')
    writeFileSync(late, Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]))
    await expect(readTextFile(late)).resolves.toMatchObject({ text: expect.stringContaining('aaa') })
    await expect(readTextFile(dir)).rejects.toThrow(/no es un archivo/)
    await expect(readTextFile(join(dir, 'nope'))).rejects.toThrow()
    const big = join(dir, 'big.txt')
    writeFileSync(big, Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61))
    await expect(readTextFile(big)).rejects.toThrow(/2 MB/)
  })

  it('escribe atómico (sin tmp residual), conserva permisos y devuelve el mtime nuevo', async () => {
    const file = join(dir, 'a.sh')
    writeFileSync(file, 'old')
    chmodSync(file, 0o755)
    const before = statSync(file)
    const r = await writeTextFile(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
    expect(statSync(file).mode & 0o777).toBe(0o755)
    expect(r.mtime).toBe(statSync(file).mtimeMs)
    expect(r.mtime).toBeGreaterThanOrEqual(before.mtimeMs)
    expect(readdirSync(dir)).toEqual(['a.sh'])
  })

  it('sobre un symlink escribe en el destino real y el enlace sigue siendo enlace', async () => {
    mkdirSync(join(dir, 'real'))
    const target = join(dir, 'real', 'config.json')
    writeFileSync(target, '{}')
    const link = join(dir, 'config.json')
    symlinkSync(target, link)
    await writeTextFile(link, '{"a":1}')
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}')
    expect(readdirSync(join(dir, 'real'))).toEqual(['config.json'])
    symlinkSync(join(dir, 'nope'), join(dir, 'roto'))
    await expect(writeTextFile(join(dir, 'roto'), 'x')).rejects.toThrow(/enlace roto/)
  })

  it('sin permiso de escritura (0444) o sobre una carpeta: error humano y nada se toca', async () => {
    const ro = join(dir, 'ro.txt')
    writeFileSync(ro, 'ro')
    chmodSync(ro, 0o444)
    await expect(writeTextFile(ro, 'x')).rejects.toThrow(/sin permiso de escritura/)
    expect(readFileSync(ro, 'utf8')).toBe('ro')
    const folder = join(dir, 'carpeta')
    mkdirSync(folder)
    await expect(writeTextFile(folder, 'x')).rejects.toThrow(/es una carpeta/)
    // Carpeta sin permiso: un archivo nuevo ahí tampoco.
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o555)
    try {
      await expect(writeTextFile(join(locked, 'new.txt'), 'x')).rejects.toThrow(/sin permiso de escritura/)
    } finally {
      chmodSync(locked, 0o755)
    }
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('crea el archivo si no existe; si la carpeta no existe, falla sin dejar tmp', async () => {
    const file = join(dir, 'nuevo.md')
    await writeTextFile(file, '# nuevo')
    expect(readFileSync(file, 'utf8')).toBe('# nuevo')
    await expect(writeTextFile(join(dir, 'no', 'x.md'), 'x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual(['nuevo.md'])
  })
})

describe('isInsideForWrite', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-w-'))
    mkdirSync(join(dir, 'ws', 'src'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(dir, 'outside', 'secret.txt'), '')
    symlinkSync(join(dir, 'outside', 'secret.txt'), join(dir, 'ws', 'leak.txt'))
    symlinkSync(join(dir, 'outside'), join(dir, 'ws', 'leakdir'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('archivo nuevo en carpeta del workspace sí; carpeta fuera, symlink fuera o carpeta inexistente no', () => {
    const root = join(dir, 'ws')
    expect(isInsideForWrite(join(root, 'src', 'new.ts'), [root])).toBe(true)
    expect(isInsideForWrite(join(root, 'src', '..', 'new.ts'), [root])).toBe(true)
    expect(isInsideForWrite(join(dir, 'outside', 'new.ts'), [root])).toBe(false)
    expect(isInsideForWrite(join(root, 'leak.txt'), [root])).toBe(false)
    expect(isInsideForWrite(join(root, 'leakdir', 'new.ts'), [root])).toBe(false)
    expect(isInsideForWrite(join(root, 'nope', 'new.ts'), [root])).toBe(false)
    expect(isInsideForWrite(join(root, '..', 'outside', 'new.ts'), [root])).toBe(false)
  })
})

describe('listTree', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omni-tree-'))
    const root = join(dir, 'ws')
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'Assets'))
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true })
    mkdirSync(join(root, '.git'))
    mkdirSync(join(dir, 'outside'))
    for (const name of ['b.ts', 'a10.ts', 'a2.ts', 'README.md', '.env', 'zeta']) writeFileSync(join(root, name), '')
    writeFileSync(join(dir, 'outside', 'secret.txt'), '')
    symlinkSync(join(dir, 'outside'), join(root, 'leakdir'))
    symlinkSync(join(root, 'src'), join(root, 'srclink'))
    symlinkSync(join(root, 'README.md'), join(root, 'readme-link.md'))
    symlinkSync(join(root, 'nope'), join(root, 'dangling'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('carpetas primero, orden natural, sin ocultos ni node_modules; symlinks solo si apuntan dentro', async () => {
    const root = join(dir, 'ws')
    const { entries, truncated } = await listTree(root, root)
    expect(entries.map((e) => `${e.dir ? 'd' : 'f'} ${e.name}`)).toEqual(['d Assets', 'd src', 'd srclink', 'f a2.ts', 'f a10.ts', 'f b.ts', 'f readme-link.md', 'f README.md', 'f zeta'])
    expect(entries[0]?.path).toBe(join(root, 'Assets'))
    expect(truncated).toBe(false)
  })

  it('aplica la lista fija del índice y el .gitignore raíz del workspace', async () => {
    const root = join(dir, 'ws')
    mkdirSync(join(root, 'dist'))
    mkdirSync(join(root, 'logs'))
    mkdirSync(join(root, 'src', 'logs'))
    writeFileSync(join(root, 'debug.log'), '')
    writeFileSync(join(root, 'src', 'debug.log'), '')
    writeFileSync(join(root, 'src', 'keep.ts'), '')
    writeFileSync(join(root, '.gitignore'), 'logs/\n*.log\nzeta\n')
    const top = (await listTree(root, root)).entries.map((e) => e.name)
    expect(top).not.toContain('dist')
    expect(top).not.toContain('logs')
    expect(top).not.toContain('debug.log')
    expect(top).not.toContain('zeta')
    expect(top).toContain('README.md')
    // Las reglas valen en subcarpetas también.
    expect((await listTree(root, join(root, 'src'))).entries.map((e) => e.name)).toEqual(['keep.ts'])
  })

  it('corta en el tope y lo avisa con truncated; lo que cupo sale ordenado', async () => {
    const root = join(dir, 'ws')
    const many = join(root, 'many')
    mkdirSync(many)
    for (let i = 1; i <= 5; i++) writeFileSync(join(many, `f${i}.txt`), '')
    const cut = await listTree(root, many, 3)
    expect(cut.truncated).toBe(true)
    expect(cut.entries).toHaveLength(3)
    expect(cut.entries.map((e) => e.name)).toEqual([...cut.entries.map((e) => e.name)].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
    expect((await listTree(root, many, 5)).truncated).toBe(false)
    await expect(listTree(root, 'many')).rejects.toThrow(/absoluta/)
  })

  it('lista subcarpetas; rechaza carpetas fuera (también por symlink) o inexistentes', async () => {
    const root = join(dir, 'ws')
    expect(await listTree(root, join(root, 'src'))).toEqual({ entries: [], truncated: false })
    await expect(listTree(root, join(dir, 'outside'))).rejects.toThrow(/fuera del workspace/)
    await expect(listTree(root, join(root, 'leakdir'))).rejects.toThrow(/fuera del workspace/)
    await expect(listTree(root, join(root, '..', 'outside'))).rejects.toThrow(/fuera del workspace/)
    await expect(listTree(root, join(root, 'nope'))).rejects.toThrow(/fuera del workspace/)
  })

  it('compareTreeEntries: carpetas antes que archivos y números en orden natural', () => {
    const e = (name: string, dir: boolean): { name: string; path: string; dir: boolean } => ({ name, path: `/${name}`, dir })
    expect([e('z', false), e('a10', false), e('b', true), e('a2', false), e('A', true)].sort(compareTreeEntries).map((x) => x.name)).toEqual(['A', 'b', 'a2', 'a10', 'z'])
  })
})

describe('WatchLedger', () => {
  it('cuenta por remitente y ruta; remove solo descuenta lo propio; drop suelta todo lo del remitente', () => {
    const ledger = new WatchLedger()
    ledger.add(1, '/a')
    ledger.add(1, '/a')
    ledger.add(1, '/b')
    ledger.add(2, '/a')
    expect(ledger.remove(2, '/b')).toBe(false)
    expect(ledger.remove(3, '/a')).toBe(false)
    expect(ledger.remove(2, '/a')).toBe(true)
    expect(ledger.remove(2, '/a')).toBe(false)
    expect(ledger.senders()).toEqual([1])
    expect(ledger.drop(1).sort()).toEqual(['/a', '/a', '/b'])
    expect(ledger.drop(1)).toEqual([])
    expect(ledger.senders()).toEqual([])
  })

  it('con el FileWatcher: un reload (drop) deja el contador como si el renderer nunca hubiera pedido nada', () => {
    const closed: string[] = []
    const watch: WatchFn = (dir) => ({ close: () => closed.push(dir), on: () => undefined }) as unknown as ReturnType<WatchFn>
    const watcher = new FileWatcher({ watch })
    const ledger = new WatchLedger()
    const file = '/w/a.ts'
    // Primera carga: pide; reload sin unwatch; segunda carga: pide otra vez.
    watcher.watch(file)
    ledger.add(7, file)
    for (const p of ledger.drop(7)) watcher.unwatch(p)
    expect(watcher.paths()).toEqual([])
    expect(closed).toEqual(['/w'])
    watcher.watch(file)
    ledger.add(7, file)
    if (ledger.remove(7, file)) watcher.unwatch(file)
    expect(watcher.paths()).toEqual([])
  })
})

describe('FileWatcher', () => {
  it('vigila la carpeta del archivo filtrando por nombre, con conteo de referencias y debounce', () => {
    vi.useFakeTimers()
    try {
      const listeners = new Map<string, (event: string, filename: string | Buffer | null) => void>()
      const closed: string[] = []
      const watch: WatchFn = (dir, listener) => {
        listeners.set(dir, listener)
        return { close: () => closed.push(dir), on: () => undefined } as unknown as ReturnType<WatchFn>
      }
      const watcher = new FileWatcher({ watch, debounceMs: 150 })
      const changed = vi.fn()
      watcher.onChanged(changed)
      const file = '/tmp/omni-w/a.ts'
      watcher.watch(file)
      watcher.watch(file)
      expect(listeners.size).toBe(1)
      expect(watcher.paths()).toEqual([file])
      const fire = listeners.get('/tmp/omni-w') as (event: string, filename: string | Buffer | null) => void
      fire('change', 'otro.ts')
      vi.advanceTimersByTime(200)
      expect(changed).not.toHaveBeenCalled()
      fire('change', 'a.ts')
      fire('rename', 'a.ts')
      fire('change', Buffer.from('a.ts'))
      vi.advanceTimersByTime(100)
      expect(changed).not.toHaveBeenCalled()
      vi.advanceTimersByTime(60)
      expect(changed).toHaveBeenCalledTimes(1)
      // El archivo no existe en disco: mtime 0.
      expect(changed).toHaveBeenCalledWith(file, 0)
      // Sin nombre en el evento se asume que fue este archivo.
      fire('change', null)
      vi.advanceTimersByTime(150)
      expect(changed).toHaveBeenCalledTimes(2)
      watcher.unwatch(file)
      expect(closed).toEqual([])
      watcher.unwatch(file)
      expect(closed).toEqual(['/tmp/omni-w'])
      expect(watcher.paths()).toEqual([])
      // Un evento pendiente al soltar no llega.
      watcher.watch(file)
      fire('change', 'a.ts')
      watcher.unwatch(file)
      vi.advanceTimersByTime(200)
      expect(changed).toHaveBeenCalledTimes(2)
      watcher.unwatch('/no/vigilado')
    } finally {
      vi.useRealTimers()
    }
  })

  it('con fs.watch real: una escritura atómica (tmp + rename) avisa con el mtime nuevo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'omni-watch-'))
    const file = join(dir, 'a.md')
    writeFileSync(file, 'uno')
    const watcher = new FileWatcher({ debounceMs: 30 })
    try {
      // FSEvents puede entregar con retraso el evento de la escritura inicial: se espera el aviso cuyo mtime es el final.
      const seen: [string, number][] = []
      let settle: (() => void) | null = null
      watcher.onChanged((p, m) => {
        seen.push([p, m])
        settle?.()
      })
      watcher.watch(file)
      await new Promise((r) => setTimeout(r, 50))
      await writeTextFile(file, 'dos')
      const final = statSync(file).mtimeMs
      const deadline = Date.now() + 3_000
      while (!seen.some(([p, m]) => p === file && m === final)) {
        if (Date.now() > deadline) throw new Error(`sin evento con el mtime final; vistos: ${JSON.stringify(seen)}`)
        await new Promise<void>((r) => {
          settle = r
          setTimeout(r, 100)
        })
      }
    } finally {
      watcher.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('saveDropped', () => {
  it('guarda con el nombre reducido a su base y rechaza lo enorme', async () => {
    const { mkdtempSync, readFileSync, statSync: st } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const { saveDropped: save, MAX_DROP_BYTES } = await import('./files')
    const dir = mkdtempSync(`${td()}/omni-drop-`)
    const path = save(dir, '../../etc/Captura 1.png', new Uint8Array([1, 2, 3]), 42)
    expect(path).toBe(`${dir}/42-Captura 1.png`)
    expect([...readFileSync(path)]).toEqual([1, 2, 3])
    expect(st(path).mode & 0o777).toBe(0o600)
    expect(() => save(dir, 'x.bin', { byteLength: MAX_DROP_BYTES + 1 } as Uint8Array)).toThrow(/demasiado grande/)
  })

  it('normaliza el espacio angosto de las capturas de macOS a un espacio común', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir: td } = await import('node:os')
    const { saveDropped: save } = await import('./files')
    const dir = mkdtempSync(`${td()}/omni-drop-`)
    expect(save(dir, 'Screenshot 3.05.53\u202fPM.png', new Uint8Array([1]), 7)).toBe(`${dir}/7-Screenshot 3.05.53 PM.png`)
  })
})
