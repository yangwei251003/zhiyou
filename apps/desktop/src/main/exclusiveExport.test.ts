import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ApplicationError } from '@bosshunter/application'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { writeExclusiveCommittedExport } from './exclusiveExport'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bosshunter-export-test-'))
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

describe('exclusive resume export lifecycle', () => {
  it('writes a new file before committing and returns the committed result', async () => {
    const directory = await temporaryDirectory()
    const destination = join(directory, 'resume.txt')
    const commit = vi.fn(() => Promise.resolve({ filename: 'resume.txt' }))

    await expect(
      writeExclusiveCommittedExport({
        destination,
        bytes: Buffer.from('verified resume', 'utf8'),
        commit,
      }),
    ).resolves.toEqual({ filename: 'resume.txt' })
    expect(await readFile(destination, 'utf8')).toBe('verified resume')
    expect(commit).toHaveBeenCalledOnce()
  })

  it('never overwrites an existing destination or commits its export state', async () => {
    const directory = await temporaryDirectory()
    const destination = join(directory, 'resume.txt')
    await writeFile(destination, 'keep me', 'utf8')
    const commit = vi.fn(() => Promise.resolve({ filename: 'resume.txt' }))

    await expect(
      writeExclusiveCommittedExport({
        destination,
        bytes: Buffer.from('replacement', 'utf8'),
        commit,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await readFile(destination, 'utf8')).toBe('keep me')
    expect(commit).not.toHaveBeenCalled()
  })

  it('removes the plaintext file when the export-state commit fails', async () => {
    const directory = await temporaryDirectory()
    const destination = join(directory, 'resume.txt')
    const commitError = new Error('commit failed')

    await expect(
      writeExclusiveCommittedExport({
        destination,
        bytes: Buffer.from('uncommitted', 'utf8'),
        commit: () => Promise.reject(commitError),
      }),
    ).rejects.toBe(commitError)
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports the exact residual path when rollback cleanup also fails', async () => {
    const destination = 'C:\\private\\resume.txt'
    const cleanupError = new Error('cleanup failed')

    await expect(
      writeExclusiveCommittedExport({
        destination,
        bytes: Buffer.from('uncommitted', 'utf8'),
        commit: () => Promise.reject(new Error('commit failed')),
        operations: {
          write: () => Promise.resolve(),
          remove: () => Promise.reject(cleanupError),
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'STORAGE_FAILED' &&
        error.userMessage.includes(destination) &&
        error.cause instanceof AggregateError,
    )
  })
})
