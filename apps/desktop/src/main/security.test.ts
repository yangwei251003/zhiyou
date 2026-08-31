import { describe, expect, it, vi } from 'vitest'

const { getSelectedStorageBackend } = vi.hoisted(() => ({
  getSelectedStorageBackend: vi.fn(() => 'kwallet6'),
}))

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend,
  },
}))

import {
  isAllowedDevelopmentRendererUrl,
  isAllowedExternalUrl,
  isHostEncryptionSecure,
  isSameApplicationOrigin,
  isSameOpenedFile,
  isTrustedIpcFrame,
} from './security'

describe('desktop navigation policy', () => {
  it('allows only exact HTTPS hosts without embedded credentials or ports', () => {
    expect(isAllowedExternalUrl('https://openai.com/index/example')).toBe(true)
    expect(isAllowedExternalUrl('https://auth.openai.com/authorize')).toBe(true)
    expect(isAllowedExternalUrl('https://chatgpt.com/auth/login')).toBe(true)
    expect(isAllowedExternalUrl('https://github.com/example/repository')).toBe(true)
    expect(isAllowedExternalUrl('http://openai.com')).toBe(false)
    expect(isAllowedExternalUrl('https://docs.openai.com')).toBe(false)
    expect(isAllowedExternalUrl('https://openai.com.evil.example')).toBe(false)
    expect(isAllowedExternalUrl('https://auth.openai.com.evil.example/authorize')).toBe(false)
    expect(isAllowedExternalUrl('https://user@openai.com')).toBe(false)
    expect(isAllowedExternalUrl('https://openai.com:8443')).toBe(false)
  })

  it('keeps production navigation on the exact renderer document', () => {
    const applicationUrl = 'file:///C:/BossHunter/out/renderer/index.html'
    expect(isSameApplicationOrigin(`${applicationUrl}#resume`, applicationUrl)).toBe(true)
    expect(
      isSameApplicationOrigin('file:///C:/BossHunter/out/renderer/other.html', applicationUrl),
    ).toBe(false)
    expect(isSameApplicationOrigin('https://openai.com', applicationUrl)).toBe(false)
  })

  it('allows same-origin development navigation and rejects other origins', () => {
    const applicationUrl = 'http://localhost:5173/'
    expect(isSameApplicationOrigin('http://localhost:5173/resume', applicationUrl)).toBe(true)
    expect(isSameApplicationOrigin('http://127.0.0.1:5173/', applicationUrl)).toBe(false)
    expect(isSameApplicationOrigin('https://localhost:5173/', applicationUrl)).toBe(false)
  })

  it('accepts only loopback development renderer URLs', () => {
    expect(isAllowedDevelopmentRendererUrl('http://localhost:5173/')).toBe(true)
    expect(isAllowedDevelopmentRendererUrl('https://127.0.0.1:5173/')).toBe(true)
    expect(isAllowedDevelopmentRendererUrl('http://[::1]:5173/')).toBe(true)
    expect(isAllowedDevelopmentRendererUrl('https://example.com/')).toBe(false)
    expect(isAllowedDevelopmentRendererUrl('file:///C:/attacker.html')).toBe(false)
    expect(isAllowedDevelopmentRendererUrl('http://user@localhost:5173/')).toBe(false)
  })

  it('rejects Linux basic-text key storage', () => {
    expect(isHostEncryptionSecure('win32')).toBe(true)
    expect(isHostEncryptionSecure('linux')).toBe(true)
    getSelectedStorageBackend.mockReturnValueOnce('basic_text')
    expect(isHostEncryptionSecure('linux')).toBe(false)
  })

  it('accepts IPC only from the expected top-level application frame', () => {
    const applicationUrl = 'file:///C:/BossHunter/out/renderer/index.html'
    expect(isTrustedIpcFrame(`${applicationUrl}#resume`, applicationUrl, true, true)).toBe(true)
    expect(isTrustedIpcFrame('https://attacker.example/', applicationUrl, true, true)).toBe(false)
    expect(isTrustedIpcFrame(applicationUrl, applicationUrl, false, true)).toBe(false)
    expect(isTrustedIpcFrame(applicationUrl, applicationUrl, true, false)).toBe(false)
  })

  it('checks opened-file identity without trusting incompatible Windows device ids', () => {
    const metadata = (overrides: Partial<Parameters<typeof isSameOpenedFile>[0]> = {}) => ({
      dev: 1n,
      ino: 31_500_000_000_000_001n,
      size: 128n,
      mtimeNs: 50n,
      ctimeNs: 40n,
      isFile: () => true,
      ...overrides,
    })
    const selected = metadata()

    expect(isSameOpenedFile(selected, metadata({ dev: 3_967_199_839n }), 'win32')).toBe(true)
    expect(isSameOpenedFile(selected, metadata({ dev: 2n }), 'linux')).toBe(false)
    expect(isSameOpenedFile(selected, metadata({ ino: selected.ino + 1n }), 'win32')).toBe(false)
    expect(isSameOpenedFile(selected, metadata({ size: 129n }), 'win32')).toBe(false)
    expect(isSameOpenedFile(selected, metadata({ mtimeNs: 51n }), 'win32')).toBe(false)
    expect(isSameOpenedFile(selected, metadata({ ctimeNs: 41n }), 'win32')).toBe(false)
    expect(isSameOpenedFile(selected, metadata({ isFile: () => false }), 'win32')).toBe(false)
  })
})
