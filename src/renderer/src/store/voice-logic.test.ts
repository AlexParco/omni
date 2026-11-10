import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '@shared/types'
import type { SessionStatus } from './sessions'
import { canDictate, cleanTranscript, defaultTarget, dictationTargets, formatElapsed, isTap, nextTarget, unavailableReason, unavailableText } from './voice-logic'

const session = (id: string, workspaceId: string, agent: SessionInfo['agent'], createdAt: number): SessionInfo => ({ id, agent, workspaceId, cwd: '/x', createdAt }) as SessionInfo
const sessions = [session('cc', 'ws1', 'claude', 1), session('cx', 'ws1', 'codex', 2), session('sh', 'ws1', 'shell', 3), session('br', 'ws1', 'browser', 4), session('other', 'ws2', 'claude', 5)]
const status =
  (map: Record<string, SessionStatus>) =>
  (id: string): SessionStatus =>
    map[id] ?? 'idle'

describe('formatElapsed', () => {
  it('minutos:segundos con dos dígitos de segundos', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(7400)).toBe('0:07')
    expect(formatElapsed(83000)).toBe('1:23')
    expect(formatElapsed(725000)).toBe('12:05')
    expect(formatElapsed(-5)).toBe('0:00')
  })
})

describe('canDictate / unavailableReason', () => {
  it('sin status o sin binario falta el binario; con binario y sin modelo falta el modelo', () => {
    expect(unavailableReason(null)).toBe('binary')
    expect(unavailableReason({ binary: null, model: '/m' })).toBe('binary')
    expect(unavailableReason({ binary: '/b', model: null })).toBe('model')
    expect(unavailableReason({ binary: '/b', model: '/m' })).toBeNull()
    expect(canDictate({ binary: '/b', model: '/m' })).toBe(true)
    expect(canDictate({ binary: '/b', model: null })).toBe(false)
  })
  it('el texto del binario lleva el comando de brew', () => {
    expect(unavailableText('binary')).toContain('brew install whisper-cpp')
    expect(unavailableText('mic', 'Sin permiso')).toBe('Sin permiso')
    expect(unavailableText('failed', 'timeout')).toContain('timeout')
  })
})

describe('dictationTargets / defaultTarget', () => {
  it('el pane con foco es el destino si es una terminal del workspace', () => {
    expect(defaultTarget(sessions, 'ws1', status({}), 'sh')).toBe('sh')
    expect(defaultTarget(sessions, 'ws1', status({}), 'cx')).toBe('cx')
  })
  it('con un navegador o nada enfocado cae al primero rankeado (pregunta primero, agentes antes que shells)', () => {
    expect(defaultTarget(sessions, 'ws1', status({}), 'br')).toBe('cx')
    expect(defaultTarget(sessions, 'ws1', status({ cc: 'question' }), null)).toBe('cc')
    expect(defaultTarget(sessions, 'ws1', status({}), 'other')).toBe('cx')
  })
  it('sin workspace o sin terminales no hay destino', () => {
    expect(defaultTarget(sessions, null, status({}), 'cc')).toBeNull()
    expect(defaultTarget(sessions, 'ws3', status({}), null)).toBeNull()
    expect(dictationTargets(sessions, 'ws1', status({}), null).map((s) => s.id)).toEqual(['cx', 'cc', 'sh'])
  })
})

describe('nextTarget', () => {
  it('rota circular en ambos sentidos y arranca en el primero si el actual no está', () => {
    const ids = ['a', 'b', 'c']
    expect(nextTarget(ids, 'a', 1)).toBe('b')
    expect(nextTarget(ids, 'c', 1)).toBe('a')
    expect(nextTarget(ids, 'a', -1)).toBe('c')
    expect(nextTarget(ids, 'zz', 1)).toBe('a')
    expect(nextTarget(ids, null, 1)).toBe('a')
    expect(nextTarget([], 'a', 1)).toBeNull()
  })
})

describe('isTap / cleanTranscript', () => {
  it('menos de 400 ms es un toque', () => {
    expect(isTap(120)).toBe(true)
    expect(isTap(400)).toBe(false)
  })
  it('limpia saltos y espacios sobrantes', () => {
    expect(cleanTranscript('  hola\n mundo \n')).toBe('hola mundo')
  })
})
