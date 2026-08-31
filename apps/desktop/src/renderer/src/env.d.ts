/// <reference types="vite/client" />

import type { DesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    bossHunter?: DesktopApi
  }
}

export {}
