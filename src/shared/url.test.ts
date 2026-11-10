import { describe, expect, it } from 'vitest'
import { externalUrl, normalizeUrl } from './url'

describe('normalizeUrl', () => {
  it('vacío o solo espacios → about:blank', () => {
    expect(normalizeUrl('')).toBe('about:blank')
    expect(normalizeUrl('   ')).toBe('about:blank')
  })

  it('respeta esquemas conocidos tal cual (y recorta espacios)', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
    expect(normalizeUrl('  http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl('data:text/html,<h1>hi</h1>')).toBe('data:text/html,<h1>hi</h1>')
    expect(normalizeUrl('chrome://gpu')).toBe('chrome://gpu')
    expect(normalizeUrl('HTTPS://Example.com')).toBe('HTTPS://Example.com')
  })

  it('hosts de desarrollo van por http', () => {
    expect(normalizeUrl('localhost')).toBe('http://localhost')
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeUrl('localhost:5173/app?x=1#h')).toBe('http://localhost:5173/app?x=1#h')
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(normalizeUrl('192.168.1.20')).toBe('http://192.168.1.20')
    expect(normalizeUrl('[::1]:3000')).toBe('http://[::1]:3000')
    expect(normalizeUrl('app.test')).toBe('http://app.test')
    expect(normalizeUrl('api.omni.localhost:4000/v1')).toBe('http://api.omni.localhost:4000/v1')
  })

  it('el resto va por https', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('github.com/alexander/omni')).toBe('https://github.com/alexander/omni')
    expect(normalizeUrl('localhost.example.com')).toBe('https://localhost.example.com')
    expect(normalizeUrl('test.example.com')).toBe('https://test.example.com')
    expect(normalizeUrl('file.txt')).toBe('https://file.txt')
  })

  it('otros esquemas con // se dejan tal cual (main decide si los deniega)', () => {
    expect(normalizeUrl('file:///etc/hosts')).toBe('file:///etc/hosts')
    expect(normalizeUrl('ftp://host')).toBe('ftp://host')
  })
})

describe('externalUrl', () => {
  it('acepta http y https (recortando espacios) y devuelve la URL normalizada', () => {
    expect(externalUrl(' https://example.com/a?b=1#c ')).toBe('https://example.com/a?b=1#c')
    expect(externalUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })

  it('rechaza file:, javascript:, otros esquemas y texto suelto con error humano', () => {
    expect(() => externalUrl('file:///etc/passwd')).toThrow(/solo se abren enlaces http\(s\), no file:/)
    expect(() => externalUrl('javascript:alert(1)')).toThrow(/http\(s\)/)
    expect(() => externalUrl('omni-file://w1/a.md')).toThrow(/http\(s\)/)
    expect(() => externalUrl('example.com')).toThrow(/no es una URL válida/)
    expect(() => externalUrl('')).toThrow(/no es una URL válida/)
  })
})
