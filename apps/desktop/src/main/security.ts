import type { BrowserWindow, Event, HandlerDetails, WebContents } from 'electron'
import { safeStorage, shell } from 'electron'

const EXTERNAL_HOST_ALLOWLIST = new Set([
  'openai.com',
  'www.openai.com',
  'help.openai.com',
  'platform.openai.com',
  'auth.openai.com',
  'login.openai.com',
  'chatgpt.com',
  'www.chatgpt.com',
  'github.com',
  'www.github.com',
])

export interface StableFileMetadata {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  isFile(): boolean
}

export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'https:' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      EXTERNAL_HOST_ALLOWLIST.has(url.hostname)
    )
  } catch {
    return false
  }
}

export function isAllowedDevelopmentRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
  } catch {
    return false
  }
}

export function isHostEncryptionSecure(platform: NodeJS.Platform = process.platform): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (platform !== 'linux') return true
  return safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

export async function openAllowedExternalUrl(rawUrl: string): Promise<boolean> {
  if (!isAllowedExternalUrl(rawUrl)) return false
  await shell.openExternal(rawUrl, { activate: true })
  return true
}

export function isSameApplicationOrigin(candidate: string, applicationUrl: string): boolean {
  try {
    const next = new URL(candidate)
    const current = new URL(applicationUrl)
    if (current.protocol === 'file:') {
      next.hash = ''
      current.hash = ''
      return next.href === current.href
    }
    return next.origin === current.origin
  } catch {
    return false
  }
}

export function isTrustedIpcFrame(
  candidateUrl: string,
  applicationUrl: string,
  sameWebContents: boolean,
  isMainFrame: boolean,
): boolean {
  return sameWebContents && isMainFrame && isSameApplicationOrigin(candidateUrl, applicationUrl)
}

export function isSameOpenedFile(
  before: StableFileMetadata,
  after: StableFileMetadata,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Electron on Windows can report different device ids for lstat and fstat on
  // the same file. The bigint inode is stable there; all other platforms also
  // have to match the device id.
  const sameDevice = platform === 'win32' || before.dev === after.dev
  return (
    before.isFile() &&
    after.isFile() &&
    sameDevice &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  )
}

export function hardenWebContents(webContents: WebContents, applicationUrl: string): void {
  webContents.setWindowOpenHandler(({ url }: HandlerDetails) => {
    void openAllowedExternalUrl(url)
    return { action: 'deny' }
  })

  webContents.on('will-navigate', (event: Event, url: string) => {
    if (isSameApplicationOrigin(url, applicationUrl)) return
    event.preventDefault()
    void openAllowedExternalUrl(url)
  })

  webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

export function hardenWindow(window: BrowserWindow, applicationUrl: string): void {
  hardenWebContents(window.webContents, applicationUrl)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  window.webContents.session.setPermissionCheckHandler(() => false)
}
