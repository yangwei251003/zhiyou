import { lstat, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => ({
  encryptionAvailable: true,
  userData: '',
  decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
    getVersion: () => '0.1.0-test',
    isPackaged: false,
  },
  dialog: {
    showMessageBox: electronState.showMessageBox,
    showOpenDialog: electronState.showOpenDialog,
    showSaveDialog: vi.fn(),
  },
  safeStorage: {
    decryptString: electronState.decryptString,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    getSelectedStorageBackend: () => 'kwallet6',
    isEncryptionAvailable: () => electronState.encryptionAvailable,
  },
  shell: {
    openExternal: vi.fn(),
  },
}))

import { CareerBackend } from './careerBackend'

const temporaryDirectories: string[] = []

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

beforeEach(async () => {
  electronState.encryptionAvailable = true
  electronState.userData = await mkdtemp(join(tmpdir(), 'bosshunter-vault-availability-'))
  temporaryDirectories.push(electronState.userData)
  electronState.showMessageBox.mockReset()
  electronState.showOpenDialog.mockReset()
  electronState.decryptString.mockClear()
})

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('career vault encryption availability lifecycle', () => {
  it('stops accepting work synchronously and waits for work accepted before close', async () => {
    const backend = new CareerBackend()
    await backend.initialize({ displayName: '小陈', targetRole: '产品经理' })

    let releaseDialog: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined
    electronState.showOpenDialog.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDialog = resolve
        }),
    )
    const acceptedImport = backend.importEvidence()
    await vi.waitFor(() => expect(electronState.showOpenDialog).toHaveBeenCalledTimes(1))

    const firstClose = backend.close()
    const secondClose = backend.close()
    expect(secondClose).toBe(firstClose)
    await expect(backend.importEvidence()).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: '应用正在退出，本次操作没有开始。' },
    })
    expect(electronState.showOpenDialog).toHaveBeenCalledTimes(1)

    releaseDialog?.({ canceled: true, filePaths: [] })
    await expect(acceptedImport).resolves.toMatchObject({ ok: true })
    await firstClose
  })

  it('locks an existing vault, blocks plaintext export, deletes without decrypting, and cannot resurrect', async () => {
    const secureBackend = new CareerBackend()
    const initialized = await secureBackend.initialize({
      displayName: '小林',
      targetRole: '产品经理',
    })
    expect(initialized).toMatchObject({
      ok: true,
      value: {
        persistenceMode: 'encrypted',
        vaultAccess: { status: 'ready' },
        workspace: { displayName: '小林' },
      },
    })
    await secureBackend.close()
    const decryptCallsAfterSecureOpen = electronState.decryptString.mock.calls.length

    const dataDirectory = join(electronState.userData, 'career-data')
    expect(await pathExists(dataDirectory)).toBe(true)

    electronState.encryptionAvailable = false
    const unavailableBackend = new CareerBackend()
    const lockedSnapshot = await unavailableBackend.snapshot()
    expect(lockedSnapshot).toMatchObject({
      ok: true,
      value: {
        persistenceMode: 'encrypted',
        vaultAccess: { status: 'locked' },
        workspace: null,
      },
    })

    const shadowInitialization = await unavailableBackend.initialize({
      displayName: '遮蔽库',
      targetRole: '不应创建',
    })
    expect(shadowInitialization).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_FAILED' },
    })

    const exportAttempt = await unavailableBackend.exportVault()
    expect(exportAttempt).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_FAILED' },
    })
    expect(electronState.showOpenDialog).not.toHaveBeenCalled()

    electronState.showMessageBox.mockResolvedValueOnce({ response: 1 })
    const deletion = await unavailableBackend.deleteVault()
    expect(deletion, JSON.stringify(deletion)).toMatchObject({
      ok: true,
      value: {
        deleted: true,
        snapshot: {
          persistenceMode: 'memory-only',
          vaultAccess: { status: 'ready' },
          workspace: null,
        },
      },
    })
    expect(await pathExists(dataDirectory)).toBe(false)
    expect(electronState.decryptString).toHaveBeenCalledTimes(decryptCallsAfterSecureOpen)
    await unavailableBackend.close()

    electronState.encryptionAvailable = true
    const restoredBackend = new CareerBackend()
    const restoredSnapshot = await restoredBackend.snapshot()
    expect(restoredSnapshot).toMatchObject({
      ok: true,
      value: {
        persistenceMode: 'encrypted',
        vaultAccess: { status: 'ready' },
        workspace: null,
      },
    })
    await restoredBackend.close()
  })

  it('never reports deletion success if the verified vault path changes after confirmation', async () => {
    const secureBackend = new CareerBackend()
    await secureBackend.initialize({ displayName: '小周', targetRole: '设计师' })
    await secureBackend.close()

    electronState.encryptionAvailable = false
    const lockedBackend = new CareerBackend()
    await lockedBackend.snapshot()
    const dataDirectory = join(electronState.userData, 'career-data')
    electronState.showMessageBox.mockImplementationOnce(async () => {
      await rm(dataDirectory, { recursive: true, force: true })
      return { response: 1 }
    })

    await expect(lockedBackend.deleteVault()).resolves.toMatchObject({
      ok: false,
      error: { code: 'STORAGE_FAILED' },
    })
    await lockedBackend.close()
  })
})
