import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Binario con el que main lanza procesos Node propios (el daemon, los servidores de lenguaje) con
 * `ELECTRON_RUN_AS_NODE=1`. En macOS se usa el "Helper" que Electron trae dentro del bundle
 * (`<app>.app/Contents/Frameworks/<app> Helper.app`, `LSUIElement`): si se usara el ejecutable
 * principal, LaunchServices registraría al daemon como la app abierta y, con la ventana cerrada,
 * abrir omni desde el Finder fallaba ("omni is not open anymore", error -600) porque intentaba
 * traer al frente un proceso sin ventana. Sin Helper (otra plataforma, layout raro) se usa
 * `execPath` tal cual. Exportada para tests.
 */
export function nodeExecPath(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync): string {
  if (platform !== 'darwin') return execPath
  const name = basename(execPath)
  const helper = join(dirname(execPath), '..', 'Frameworks', `${name} Helper.app`, 'Contents', 'MacOS', `${name} Helper`)
  return exists(helper) ? helper : execPath
}
