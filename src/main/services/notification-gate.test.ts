import { describe, expect, it, vi } from 'vitest'
import type { NotificationsSetting } from '@shared/types'
import { allowsKind, NotificationGate, type NotificationRequest } from './notification-gate'

interface Harness {
  gate: NotificationGate
  spawned: NotificationRequest[]
  closed: number[]
  setting: { value: NotificationsSetting }
  focused: { value: boolean }
}

function harness(opts: { setting?: NotificationsSetting; focused?: boolean; unsupported?: boolean } = {}): Harness {
  const setting = { value: opts.setting ?? 'all' }
  const focused = { value: opts.focused ?? false }
  const spawned: NotificationRequest[] = []
  const closed: number[] = []
  const gate = new NotificationGate({
    getSetting: () => setting.value,
    isFocused: () => focused.value,
    spawn: (req) => {
      if (opts.unsupported) return null
      const index = spawned.push(req) - 1
      return { close: () => closed.push(index) }
    }
  })
  return { gate, spawned, closed, setting, focused }
}

describe('allowsKind', () => {
  it('all deja pasar todo, questions solo preguntas, off nada', () => {
    expect(allowsKind('all', 'question')).toBe(true)
    expect(allowsKind('all', 'done')).toBe(true)
    expect(allowsKind('questions', 'question')).toBe(true)
    expect(allowsKind('questions', 'done')).toBe(false)
    expect(allowsKind('off', 'question')).toBe(false)
    expect(allowsKind('off', 'done')).toBe(false)
    expect(allowsKind('done', 'done')).toBe(true)
    expect(allowsKind('done', 'question')).toBe(false)
  })
})

describe('NotificationGate', () => {
  it('muestra con título y cuerpo cuando la ventana no tiene el foco', () => {
    const h = harness()
    expect(h.gate.show('s1', 'alpha pregunta', 'Bash(ls)', 'question', false)).toBe(true)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]).toMatchObject({ title: 'alpha pregunta', body: 'Bash(ls)' })
    expect(h.gate.size).toBe(1)
  })

  it('solo calla cuando la ventana tiene el foco Y la sesión está en pantalla', () => {
    const h = harness({ focused: true })
    expect(h.gate.show('s1', 't', 'b', 'question', true)).toBe(false)
    expect(h.spawned).toHaveLength(0)
    // Foco en la ventana pero el pane fuera de pantalla (otro tab, otra vista, oculto): avisa.
    expect(h.gate.show('s2', 't', 'b', 'question', true)).toBe(false)
    expect(h.gate.show('s2', 't', 'b', 'question', false)).toBe(true)
    h.focused.value = false
    expect(h.gate.show('s3', 't', 'b', 'question', true)).toBe(true)
    expect(h.gate.show('s4', 't', 'b', 'question', false)).toBe(true)
    expect(h.spawned).toHaveLength(3)
  })

  it('respeta el ajuste leído en el momento', () => {
    const h = harness({ setting: 'questions' })
    expect(h.gate.show('s1', 't', 'b', 'done', false)).toBe(false)
    expect(h.gate.show('s1', 't', 'b', 'question', false)).toBe(true)
    h.setting.value = 'off'
    expect(h.gate.show('s2', 't', 'b', 'question', false)).toBe(false)
    expect(h.spawned).toHaveLength(1)
  })

  it('plataforma sin soporte: no se guarda nada', () => {
    const h = harness({ unsupported: true })
    expect(h.gate.show('s1', 't', 'b', 'question', false)).toBe(false)
    expect(h.gate.size).toBe(0)
  })

  it('agrupa: una viva por sesión y tipo; otra sesión u otro tipo sí entran', () => {
    const h = harness()
    expect(h.gate.show('s1', 't', 'b', 'question', false)).toBe(true)
    expect(h.gate.show('s1', 't2', 'b2', 'question', false)).toBe(false)
    expect(h.gate.show('s1', 't', 'b', 'done', false)).toBe(true)
    expect(h.gate.show('s2', 't', 'b', 'question', false)).toBe(true)
    expect(h.spawned).toHaveLength(3)
    expect(h.gate.size).toBe(3)
  })

  it('dismiss cierra todas las de la sesión y libera el hueco', () => {
    const h = harness()
    h.gate.show('s1', 't', 'b', 'question', false)
    h.gate.show('s1', 't', 'b', 'done', false)
    h.gate.show('s2', 't', 'b', 'question', false)
    h.gate.dismiss('s1')
    expect(h.closed.sort()).toEqual([0, 1])
    expect(h.gate.size).toBe(1)
    expect(h.gate.show('s1', 't', 'b', 'question', false)).toBe(true)
    h.gate.dismiss('nadie')
    expect(h.closed).toHaveLength(2)
  })

  it('cerrarse libera el hueco sin avisar a nadie', () => {
    const h = harness()
    const listener = vi.fn()
    h.gate.onActivate(listener)
    h.gate.show('s1', 't', 'b', 'question', false)
    h.spawned[0].onClose()
    expect(h.gate.size).toBe(0)
    expect(listener).not.toHaveBeenCalled()
    expect(h.gate.show('s1', 't', 'b', 'question', false)).toBe(true)
  })

  it('clic avisa con el id de la sesión y libera el hueco; el listener se puede quitar', () => {
    const h = harness()
    const a = vi.fn()
    const b = vi.fn()
    h.gate.onActivate(a)
    const off = h.gate.onActivate(b)
    h.gate.show('s1', 't', 'b', 'question', false)
    h.spawned[0].onClick()
    expect(a).toHaveBeenCalledWith('s1')
    expect(b).toHaveBeenCalledWith('s1')
    expect(h.gate.size).toBe(0)
    off()
    h.gate.show('s2', 't', 'b', 'done', false)
    h.spawned[1].onClick()
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('un cierre tardío de una notificación ya reemplazada no borra la nueva', () => {
    const h = harness()
    h.gate.show('s1', 't', 'b', 'question', false)
    const stale = h.spawned[0]
    h.gate.dismiss('s1')
    h.gate.show('s1', 't', 'b', 'question', false)
    stale.onClose()
    expect(h.gate.size).toBe(1)
  })
})
