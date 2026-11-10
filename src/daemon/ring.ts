/**
 * Buffer circular de bytes: conserva los últimos `capacity` bytes escritos sin concatenar
 * strings ni reasignar memoria. El daemon guarda uno por sesión para `history`.
 */
export class RingBuffer {
  private readonly buf: Buffer
  /** Posición donde cae el próximo byte. */
  private head = 0
  /** Bytes válidos (≤ capacity). */
  private length = 0

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error(`capacidad inválida: ${capacity}`)
    this.buf = Buffer.allocUnsafe(capacity)
  }

  get size(): number {
    return this.length
  }

  write(chunk: Buffer): void {
    let src = chunk
    // Si el trozo supera la capacidad solo importa su cola: el resto nunca se podría leer.
    if (src.length > this.capacity) src = src.subarray(src.length - this.capacity)
    const firstPart = Math.min(src.length, this.capacity - this.head)
    src.copy(this.buf, this.head, 0, firstPart)
    if (firstPart < src.length) src.copy(this.buf, 0, firstPart)
    this.head = (this.head + src.length) % this.capacity
    this.length = Math.min(this.capacity, this.length + src.length)
  }

  /** Copia del contenido en orden de escritura (del byte más viejo al más nuevo). */
  read(): Buffer {
    const out = Buffer.allocUnsafe(this.length)
    if (this.length < this.capacity) {
      // Todavía no dio la vuelta: los datos van de 0 a head.
      this.buf.copy(out, 0, 0, this.length)
      return out
    }
    const tail = this.capacity - this.head
    this.buf.copy(out, 0, this.head, this.capacity)
    this.buf.copy(out, tail, 0, this.head)
    return out
  }

  clear(): void {
    this.head = 0
    this.length = 0
  }
}

/**
 * Decodifica el contenido como UTF-8 saltando los bytes de continuación que pudieran haber
 * quedado al inicio al cortar un carácter multibyte por la mitad.
 */
export function ringToText(ring: RingBuffer): string {
  const bytes = ring.read()
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start).toString('utf8')
}
