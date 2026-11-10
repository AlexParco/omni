import { describe, expect, it } from 'vitest'
import { nodeExecPath } from './node-exec'

describe('nodeExecPath', () => {
  const exe = '/Applications/omni.app/Contents/MacOS/omni'
  const helper = '/Applications/omni.app/Contents/Frameworks/omni Helper.app/Contents/MacOS/omni Helper'

  it('en macOS usa el Helper del bundle (no queda registrado como la app abierta)', () => {
    expect(nodeExecPath(exe, 'darwin', (p) => p === helper)).toBe(helper)
  })

  it('sirve igual para el Electron de desarrollo', () => {
    const dev = '/x/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'
    const devHelper = '/x/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper'
    expect(nodeExecPath(dev, 'darwin', (p) => p === devHelper)).toBe(devHelper)
  })

  it('sin Helper o fuera de macOS, el ejecutable tal cual', () => {
    expect(nodeExecPath(exe, 'darwin', () => false)).toBe(exe)
    expect(nodeExecPath('/usr/lib/omni/omni', 'linux', () => true)).toBe('/usr/lib/omni/omni')
  })
})
