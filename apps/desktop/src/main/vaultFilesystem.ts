import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface PlaintextExportOperations {
  createDirectory(directory: string): Promise<void>
  writeWarning(path: string, content: string, exclusive: boolean): Promise<void>
  destinationExists?(directory: string): Promise<boolean>
  renameDirectory(source: string, destination: string): Promise<void>
  removeDirectory(directory: string): Promise<void>
}

const plaintextExportOperations: PlaintextExportOperations = {
  async createDirectory(directory) {
    await mkdir(directory, { recursive: false, mode: 0o700 })
  },
  async writeWarning(path, content, exclusive) {
    await writeFile(path, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: exclusive ? 'wx' : 'w',
    })
  },
  destinationExists: pathExists,
  async renameDirectory(source, destination) {
    await rename(source, destination)
  },
  async removeDirectory(directory) {
    await removeVerifiedChildDirectory(directory)
  },
}

export class ResidualPlaintextExportError extends Error {
  readonly stagingDirectory: string

  constructor(stagingDirectory: string, exportError: unknown, cleanupError: unknown) {
    super(`Plaintext export staging directory remains at ${stagingDirectory}`, {
      cause: new AggregateError([exportError, cleanupError]),
    })
    this.name = 'ResidualPlaintextExportError'
    this.stagingDirectory = stagingDirectory
  }
}

function assertHiddenSibling(stagingDirectory: string, destinationDirectory: string): void {
  const staging = resolve(stagingDirectory)
  const destination = resolve(destinationDirectory)
  if (
    pathsEqual(staging, destination) ||
    !pathsEqual(dirname(staging), dirname(destination)) ||
    !basename(staging).startsWith('.')
  ) {
    throw new Error('Atomic directory operation requires a hidden sibling staging directory')
  }
}

/**
 * Creates an export in an exclusive hidden sibling, places a warning before any
 * caller-provided plaintext, and only exposes the final directory via rename.
 */
export async function writeAtomicPlaintextDirectoryExport(input: {
  stagingDirectory: string
  destinationDirectory: string
  initialWarning: string
  finalWarning: string
  populate: (stagingDirectory: string) => Promise<void>
  operations?: PlaintextExportOperations
}): Promise<void> {
  assertHiddenSibling(input.stagingDirectory, input.destinationDirectory)
  const operations = input.operations ?? plaintextExportOperations
  await operations.createDirectory(input.stagingDirectory)
  try {
    await operations.writeWarning(
      join(input.stagingDirectory, 'README.txt'),
      input.initialWarning,
      true,
    )
    const destinationAlreadyExists =
      operations.destinationExists === undefined
        ? await pathExists(input.destinationDirectory)
        : await operations.destinationExists(input.destinationDirectory)
    if (destinationAlreadyExists) {
      const collision = new Error(
        'Plaintext export destination already exists',
      ) as NodeJS.ErrnoException
      collision.code = 'EEXIST'
      throw collision
    }
    await input.populate(input.stagingDirectory)
    await operations.writeWarning(
      join(input.stagingDirectory, 'README.txt'),
      input.finalWarning,
      false,
    )
    await operations.renameDirectory(input.stagingDirectory, input.destinationDirectory)
  } catch (error) {
    try {
      await operations.removeDirectory(input.stagingDirectory)
    } catch (cleanupError) {
      throw new ResidualPlaintextExportError(input.stagingDirectory, error, cleanupError)
    }
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export interface VaultDeletionOperations {
  renameDirectory(source: string, destination: string): Promise<void>
  removeKey(path: string): Promise<void>
  removeDirectory(directory: string): Promise<void>
}

const vaultDeletionOperations: VaultDeletionOperations = {
  async renameDirectory(source, destination) {
    await retryTransientWindowsFilesystemOperation(() => rename(source, destination))
  },
  async removeKey(path) {
    await retryTransientWindowsFilesystemOperation(() => rm(path, { force: true }))
  },
  async removeDirectory(directory) {
    await removeVerifiedChildDirectory(directory)
  },
}

const TRANSIENT_WINDOWS_FILESYSTEM_CODES = new Set(['EACCES', 'EBUSY', 'EPERM'])

async function retryTransientWindowsFilesystemOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const maximumAttempts = 5
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (
        process.platform !== 'win32' ||
        code === undefined ||
        !TRANSIENT_WINDOWS_FILESYSTEM_CODES.has(code) ||
        attempt >= maximumAttempts
      ) {
        throw error
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25 * 2 ** (attempt - 1)))
    }
  }
}

export class VaultKeyEraseRestoreError extends Error {
  readonly dataDirectory: string
  readonly tombstoneDirectory: string

  constructor(
    dataDirectory: string,
    tombstoneDirectory: string,
    eraseError: unknown,
    restoreError: unknown,
  ) {
    super('Could not erase the vault key or restore the original data directory', {
      cause: new AggregateError([eraseError, restoreError]),
    })
    this.name = 'VaultKeyEraseRestoreError'
    this.dataDirectory = dataDirectory
    this.tombstoneDirectory = tombstoneDirectory
  }
}

export class VaultKeyEraseError extends Error {
  readonly dataDirectory: string

  constructor(dataDirectory: string, eraseError: unknown) {
    super('Could not erase the vault key; the original data directory was restored', {
      cause: eraseError,
    })
    this.name = 'VaultKeyEraseError'
    this.dataDirectory = dataDirectory
  }
}

/**
 * Makes the live vault unreachable first, destroys the only protected key next,
 * and treats subsequent ciphertext removal as retryable housekeeping.
 */
export async function deleteEncryptedVaultDirectory(input: {
  dataDirectory: string
  tombstoneDirectory: string
  keyFileName: string
  operations?: VaultDeletionOperations
}): Promise<{ cleanupPending: boolean }> {
  assertHiddenSibling(input.tombstoneDirectory, input.dataDirectory)
  const operations = input.operations ?? vaultDeletionOperations
  await operations.renameDirectory(input.dataDirectory, input.tombstoneDirectory)
  const tombstoneKey = join(input.tombstoneDirectory, input.keyFileName)
  try {
    await operations.removeKey(tombstoneKey)
  } catch (eraseError) {
    try {
      await operations.renameDirectory(input.tombstoneDirectory, input.dataDirectory)
    } catch (restoreError) {
      throw new VaultKeyEraseRestoreError(
        input.dataDirectory,
        input.tombstoneDirectory,
        eraseError,
        restoreError,
      )
    }
    throw new VaultKeyEraseError(input.dataDirectory, eraseError)
  }

  try {
    await operations.removeDirectory(input.tombstoneDirectory)
    return { cleanupPending: false }
  } catch {
    return { cleanupPending: true }
  }
}

export interface TombstoneCleanupOperations {
  list(directory: string): Promise<readonly { name: string; isDirectory: boolean }[]>
  removeKey(path: string): Promise<void>
  removeDirectory(directory: string): Promise<void>
}

const tombstoneCleanupOperations: TombstoneCleanupOperations = {
  async list(directory) {
    return (await readdir(directory, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory() && !entry.isSymbolicLink(),
    }))
  },
  async removeKey(path) {
    await rm(path, { force: true })
  },
  async removeDirectory(directory) {
    await removeVerifiedChildDirectory(directory)
  },
}

export async function cleanupEncryptedVaultTombstones(input: {
  parentDirectory: string
  tombstonePrefix: string
  keyFileName: string
  verifyDirectory: (parent: string, candidate: string) => Promise<string | null>
  operations?: TombstoneCleanupOperations
}): Promise<readonly string[]> {
  const operations = input.operations ?? tombstoneCleanupOperations
  const cleanupPending: string[] = []
  for (const entry of await operations.list(input.parentDirectory)) {
    if (!entry.name.startsWith(input.tombstonePrefix) || !entry.isDirectory) continue
    const candidate = safeChildPath(input.parentDirectory, join(input.parentDirectory, entry.name))
    const tombstone = await input.verifyDirectory(input.parentDirectory, candidate)
    if (tombstone === null) continue
    await operations.removeKey(safeChildPath(tombstone, join(tombstone, input.keyFileName)))
    try {
      await operations.removeDirectory(tombstone)
    } catch {
      cleanupPending.push(tombstone)
    }
  }
  return cleanupPending
}

export interface AtomicSidecarOperations {
  writeExclusive(path: string, content: string): Promise<void>
  rename(source: string, destination: string): Promise<void>
  remove(path: string): Promise<void>
}

const atomicSidecarOperations: AtomicSidecarOperations = {
  async writeExclusive(path, content) {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  },
  async rename(source, destination) {
    await rename(source, destination)
  },
  async remove(path) {
    await rm(path, { force: true })
  },
}

export async function writeAtomicSidecar(input: {
  target: string
  temporary: string
  content: string
  operations?: AtomicSidecarOperations
}): Promise<void> {
  assertHiddenSibling(input.temporary, input.target)
  const operations = input.operations ?? atomicSidecarOperations
  try {
    await operations.writeExclusive(input.temporary, input.content)
    await operations.rename(input.temporary, input.target)
  } catch (error) {
    await operations.remove(input.temporary).catch(() => undefined)
    throw error
  }
}

export interface SourceBlobReconciliationOperations {
  list(directory: string): Promise<readonly string[]>
  inspect(path: string): Promise<{ isFile: boolean; isSymbolicLink: boolean }>
  remove(path: string): Promise<void>
}

const sourceBlobReconciliationOperations: SourceBlobReconciliationOperations = {
  async list(directory) {
    return readdir(directory)
  },
  async inspect(path) {
    const metadata = await lstat(path)
    return {
      isFile: metadata.isFile(),
      isSymbolicLink: metadata.isSymbolicLink(),
    }
  },
  async remove(path) {
    await rm(path, { force: true })
  },
}

export class UnsafeSourceBlobEntryError extends Error {
  readonly entryPath: string

  constructor(entryPath: string) {
    super(`Source blob is not a regular file: ${entryPath}`)
    this.name = 'UnsafeSourceBlobEntryError'
    this.entryPath = entryPath
  }
}

/** Removes only regular, unreferenced encrypted blobs and never follows links. */
export async function reconcileEncryptedSourceBlobs(input: {
  sourceDirectory: string
  referencedNames: ReadonlySet<string>
  operations?: SourceBlobReconciliationOperations
}): Promise<void> {
  const operations = input.operations ?? sourceBlobReconciliationOperations
  for (const name of await operations.list(input.sourceDirectory)) {
    const referenced = input.referencedNames.has(name)
    const removableOrphan = name.endsWith('.bhenc') && !referenced
    if (!referenced && !removableOrphan) continue
    const candidate = safeChildPath(input.sourceDirectory, join(input.sourceDirectory, name))
    const metadata = await operations.inspect(candidate)
    if (!metadata.isFile || metadata.isSymbolicLink) {
      throw new UnsafeSourceBlobEntryError(candidate)
    }
    if (removableOrphan) await operations.remove(candidate)
  }
}

function safeChildPath(parent: string, candidate: string): string {
  const resolvedParent = resolve(parent)
  const resolvedCandidate = resolve(candidate)
  const pathFromParent = relative(resolvedParent, resolvedCandidate)
  if (
    pathFromParent.length === 0 ||
    pathFromParent === '..' ||
    pathFromParent.startsWith(`..${sep}`) ||
    isAbsolute(pathFromParent)
  ) {
    throw new Error('Refused a path outside its allowed parent')
  }
  return resolvedCandidate
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function removeVerifiedChildDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Refused to recursively remove a link or non-directory')
    }
    const verified = safeChildPath(await realpath(dirname(directory)), await realpath(directory))
    await rm(verified, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
