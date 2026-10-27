import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  cleanupEncryptedVaultTombstones,
  deleteEncryptedVaultDirectory,
  reconcileEncryptedSourceBlobs,
  ResidualPlaintextExportError,
  UnsafeSourceBlobEntryError,
  VaultKeyEraseError,
  VaultKeyEraseRestoreError,
  writeAtomicPlaintextDirectoryExport,
  writeAtomicSidecar,
} from './vaultFilesystem'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('atomic plaintext directory export', () => {
  it('writes the warning before plaintext and atomically reveals the finished sibling', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-export-')
    const stagingDirectory = join(parent, '.export.partial')
    const destinationDirectory = join(parent, 'export')

    await writeAtomicPlaintextDirectoryExport({
      stagingDirectory,
      destinationDirectory,
      initialWarning: 'generation warning',
      finalWarning: 'finished warning',
      populate: async (staging) => {
        expect(await readFile(join(staging, 'README.txt'), 'utf8')).toBe('generation warning')
        await expect(readFile(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
        await writeFile(join(staging, 'private.json'), '{"private":true}', 'utf8')
      },
    })

    await expect(readFile(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(destinationDirectory, 'README.txt'), 'utf8')).toBe(
      'finished warning',
    )
    expect(await readFile(join(destinationDirectory, 'private.json'), 'utf8')).toBe(
      '{"private":true}',
    )
  })

  it('cleans the staging directory when population fails', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-export-fail-')
    const stagingDirectory = join(parent, '.export.partial')
    const destinationDirectory = join(parent, 'export')
    const populateError = new Error('populate failed')

    await expect(
      writeAtomicPlaintextDirectoryExport({
        stagingDirectory,
        destinationDirectory,
        initialWarning: 'generation warning',
        finalWarning: 'finished warning',
        populate: async (staging) => {
          await writeFile(join(staging, 'private.json'), 'partial', 'utf8')
          throw populateError
        },
      }),
    ).rejects.toBe(populateError)
    await expect(readFile(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(destinationDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports the exact residual staging path when cleanup fails', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-export-residual-')
    const stagingDirectory = join(parent, '.BossHunter.partial')
    const cleanupError = new Error('cleanup failed')

    await expect(
      writeAtomicPlaintextDirectoryExport({
        stagingDirectory,
        destinationDirectory: join(parent, 'BossHunter'),
        initialWarning: 'generation warning',
        finalWarning: 'finished warning',
        populate: () => Promise.reject(new Error('populate failed')),
        operations: {
          createDirectory: () => Promise.resolve(),
          writeWarning: () => Promise.resolve(),
          destinationExists: () => Promise.resolve(false),
          renameDirectory: () => Promise.resolve(),
          removeDirectory: () => Promise.reject(cleanupError),
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ResidualPlaintextExportError &&
        error.stagingDirectory === stagingDirectory &&
        error.message.includes(stagingDirectory) &&
        error.cause instanceof AggregateError,
    )
  })

  it('creates the hidden staging directory exclusively and leaves a collision untouched', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-export-collision-')
    const stagingDirectory = join(parent, '.export.partial')
    await mkdir(stagingDirectory)
    await writeFile(join(stagingDirectory, 'owner.txt'), 'existing', 'utf8')
    const populate = vi.fn(() => Promise.resolve())

    await expect(
      writeAtomicPlaintextDirectoryExport({
        stagingDirectory,
        destinationDirectory: join(parent, 'export'),
        initialWarning: 'generation warning',
        finalWarning: 'finished warning',
        populate,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(stagingDirectory, 'owner.txt'), 'utf8')).toBe('existing')
    expect(populate).not.toHaveBeenCalled()
  })

  it('does not replace an existing destination directory', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-export-target-collision-')
    const stagingDirectory = join(parent, '.export.partial')
    const destinationDirectory = join(parent, 'export')
    await mkdir(destinationDirectory)
    await writeFile(join(destinationDirectory, 'owner.txt'), 'existing', 'utf8')
    const populate = vi.fn(() => Promise.resolve())

    await expect(
      writeAtomicPlaintextDirectoryExport({
        stagingDirectory,
        destinationDirectory,
        initialWarning: 'generation warning',
        finalWarning: 'finished warning',
        populate,
      }),
    ).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(destinationDirectory, 'owner.txt'), 'utf8')).toBe('existing')
    await expect(readFile(stagingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(populate).not.toHaveBeenCalled()
  })
})

describe('encrypted vault deletion lifecycle', () => {
  it('renames, removes the key, then removes ciphertext in that exact order', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-delete-')
    const dataDirectory = join(parent, 'career-data')
    const tombstoneDirectory = join(parent, '.career-data-deleting-test')
    await mkdir(dataDirectory)
    await writeFile(join(dataDirectory, 'career-vault-key.bhkey'), 'protected-key', 'utf8')
    await writeFile(join(dataDirectory, 'career-vault.sqlite'), 'ciphertext', 'utf8')
    const events: string[] = []

    const deletion = await deleteEncryptedVaultDirectory({
      dataDirectory,
      tombstoneDirectory,
      keyFileName: 'career-vault-key.bhkey',
      operations: {
        async renameDirectory(source, destination) {
          events.push('rename-live-to-tombstone')
          await rename(source, destination)
        },
        async removeKey(path) {
          events.push('remove-key')
          await expect(readFile(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
          await rm(path, { force: true })
        },
        async removeDirectory(directory) {
          events.push('remove-ciphertext')
          await expect(readFile(join(directory, 'career-vault-key.bhkey'))).rejects.toMatchObject({
            code: 'ENOENT',
          })
          await rm(directory, { recursive: true, force: true })
        },
      },
    })

    expect(deletion).toEqual({ cleanupPending: false })
    expect(events).toEqual(['rename-live-to-tombstone', 'remove-key', 'remove-ciphertext'])
    await expect(readFile(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(tombstoneDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('restores the live directory when key deletion fails', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-delete-restore-')
    const dataDirectory = join(parent, 'career-data')
    const tombstoneDirectory = join(parent, '.career-data-deleting-test')
    await mkdir(dataDirectory)
    await writeFile(join(dataDirectory, 'career-vault-key.bhkey'), 'protected-key', 'utf8')
    const eraseError = new Error('key deletion failed')
    const events: string[] = []

    await expect(
      deleteEncryptedVaultDirectory({
        dataDirectory,
        tombstoneDirectory,
        keyFileName: 'career-vault-key.bhkey',
        operations: {
          async renameDirectory(source, destination) {
            events.push(source === dataDirectory ? 'rename-to-tombstone' : 'restore-live')
            await rename(source, destination)
          },
          removeKey: () => {
            events.push('remove-key')
            return Promise.reject(eraseError)
          },
          removeDirectory: () => {
            events.push('unexpected-remove')
            return Promise.resolve()
          },
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof VaultKeyEraseError && error.cause === eraseError,
    )
    expect(events).toEqual(['rename-to-tombstone', 'remove-key', 'restore-live'])
    expect(await readFile(join(dataDirectory, 'career-vault-key.bhkey'), 'utf8')).toBe(
      'protected-key',
    )
    await expect(readFile(tombstoneDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves both errors when key deletion and restoration fail', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-delete-double-fail-')
    const eraseError = new Error('key deletion failed')
    const restoreError = new Error('restore failed')
    let renameCount = 0

    await expect(
      deleteEncryptedVaultDirectory({
        dataDirectory: join(parent, 'career-data'),
        tombstoneDirectory: join(parent, '.career-data-deleting-test'),
        keyFileName: 'career-vault-key.bhkey',
        operations: {
          renameDirectory: () => {
            renameCount += 1
            return renameCount === 2 ? Promise.reject(restoreError) : Promise.resolve()
          },
          removeKey: () => Promise.reject(eraseError),
          removeDirectory: () => Promise.resolve(),
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof VaultKeyEraseRestoreError && error.cause instanceof AggregateError,
    )
  })

  it('reports pending cleanup after the key is gone but ciphertext removal fails', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-delete-pending-')
    const dataDirectory = join(parent, 'career-data')
    const tombstoneDirectory = join(parent, '.career-data-deleting-test')
    await mkdir(dataDirectory)
    await writeFile(join(dataDirectory, 'career-vault-key.bhkey'), 'protected-key', 'utf8')
    await writeFile(join(dataDirectory, 'career-vault.sqlite'), 'ciphertext', 'utf8')

    await expect(
      deleteEncryptedVaultDirectory({
        dataDirectory,
        tombstoneDirectory,
        keyFileName: 'career-vault-key.bhkey',
        operations: {
          renameDirectory: rename,
          removeKey: (path) => rm(path, { force: true }),
          removeDirectory: () => Promise.reject(new Error('filesystem busy')),
        },
      }),
    ).resolves.toEqual({ cleanupPending: true })
    await expect(readFile(dataDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      readFile(join(tombstoneDirectory, 'career-vault-key.bhkey')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(tombstoneDirectory, 'career-vault.sqlite'), 'utf8')).toBe(
      'ciphertext',
    )
  })
})

describe('startup tombstone cleanup', () => {
  it('destroys a tombstone key and ciphertext while leaving unrelated directories alone', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-startup-cleanup-')
    const tombstone = join(parent, '.career-data-deleting-old')
    const unrelated = join(parent, 'unrelated')
    await mkdir(tombstone)
    await mkdir(unrelated)
    await writeFile(join(tombstone, 'career-vault-key.bhkey'), 'protected-key', 'utf8')
    await writeFile(join(tombstone, 'career-vault.sqlite'), 'ciphertext', 'utf8')

    await expect(
      cleanupEncryptedVaultTombstones({
        parentDirectory: parent,
        tombstonePrefix: '.career-data-deleting-',
        keyFileName: 'career-vault-key.bhkey',
        verifyDirectory: (_parent, candidate) => Promise.resolve(candidate),
      }),
    ).resolves.toEqual([])
    await expect(readFile(tombstone)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(unrelated)).rejects.not.toMatchObject({ code: 'ENOENT' })
  })

  it('returns the exact tombstone to retry after deleting its key', async () => {
    const parent = await temporaryDirectory('bosshunter-vault-startup-pending-')
    const tombstone = join(parent, '.career-data-deleting-old')
    const events: string[] = []

    await expect(
      cleanupEncryptedVaultTombstones({
        parentDirectory: parent,
        tombstonePrefix: '.career-data-deleting-',
        keyFileName: 'career-vault-key.bhkey',
        verifyDirectory: () => Promise.resolve(tombstone),
        operations: {
          list: () => Promise.resolve([{ name: '.career-data-deleting-old', isDirectory: true }]),
          removeKey: () => {
            events.push('remove-key')
            return Promise.resolve()
          },
          removeDirectory: () => {
            events.push('remove-ciphertext')
            return Promise.reject(new Error('busy'))
          },
        },
      }),
    ).resolves.toEqual([tombstone])
    expect(events).toEqual(['remove-key', 'remove-ciphertext'])
  })
})

describe('atomic resume-draft sidecar', () => {
  it('replaces the target through an exclusive hidden temporary file', async () => {
    const parent = await temporaryDirectory('bosshunter-sidecar-')
    const target = join(parent, 'drafts.bhenc')
    const temporary = join(parent, '.drafts.bhenc.unique.tmp')
    await writeFile(target, 'old', 'utf8')

    await writeAtomicSidecar({ target, temporary, content: 'new' })

    expect(await readFile(target, 'utf8')).toBe('new')
    await expect(readFile(temporary)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the temporary file when atomic replacement fails', async () => {
    const parent = await temporaryDirectory('bosshunter-sidecar-fail-')
    const target = join(parent, 'drafts.bhenc')
    const temporary = join(parent, '.drafts.bhenc.unique.tmp')
    const replaceError = new Error('replace failed')
    const remove = vi.fn(() => Promise.resolve())

    await expect(
      writeAtomicSidecar({
        target,
        temporary,
        content: 'new',
        operations: {
          writeExclusive: () => Promise.resolve(),
          rename: () => Promise.reject(replaceError),
          remove,
        },
      }),
    ).rejects.toBe(replaceError)
    expect(remove).toHaveBeenCalledWith(temporary)
  })
})

describe('encrypted source-blob reconciliation', () => {
  it('removes only unreferenced encrypted regular files', async () => {
    const sourceDirectory = await temporaryDirectory('bosshunter-blobs-')
    await writeFile(join(sourceDirectory, 'referenced.bhenc'), 'keep', 'utf8')
    await writeFile(join(sourceDirectory, 'orphan.bhenc'), 'remove', 'utf8')
    await writeFile(join(sourceDirectory, 'notes.txt'), 'ignore', 'utf8')

    await reconcileEncryptedSourceBlobs({
      sourceDirectory,
      referencedNames: new Set(['referenced.bhenc']),
    })

    expect(await readFile(join(sourceDirectory, 'referenced.bhenc'), 'utf8')).toBe('keep')
    await expect(readFile(join(sourceDirectory, 'orphan.bhenc'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(sourceDirectory, 'notes.txt'), 'utf8')).toBe('ignore')
  })

  it('fails closed instead of removing an unreferenced encrypted link', async () => {
    const sourceDirectory = await temporaryDirectory('bosshunter-blobs-link-')
    const remove = vi.fn(() => Promise.resolve())

    await expect(
      reconcileEncryptedSourceBlobs({
        sourceDirectory,
        referencedNames: new Set(),
        operations: {
          list: () => Promise.resolve(['orphan.bhenc']),
          inspect: () => Promise.resolve({ isFile: true, isSymbolicLink: true }),
          remove,
        },
      }),
    ).rejects.toBeInstanceOf(UnsafeSourceBlobEntryError)
    expect(remove).not.toHaveBeenCalled()
  })

  it('fails closed when a referenced blob is not a regular file', async () => {
    const sourceDirectory = await temporaryDirectory('bosshunter-blobs-nonfile-')
    await expect(
      reconcileEncryptedSourceBlobs({
        sourceDirectory,
        referencedNames: new Set(['referenced.bhenc']),
        operations: {
          list: () => Promise.resolve(['referenced.bhenc']),
          inspect: () => Promise.resolve({ isFile: false, isSymbolicLink: false }),
          remove: () => Promise.resolve(),
        },
      }),
    ).rejects.toBeInstanceOf(UnsafeSourceBlobEntryError)
  })
})
