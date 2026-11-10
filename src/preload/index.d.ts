import type { OmniBridge } from '@shared/ipc'

declare global {
  interface Window {
    omni: OmniBridge
  }
}

export {}
