import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { PersonProfile, Workspace } from '@bosshunter/domain'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Aes256GcmCodec,
  BASE_MIGRATIONS,
  SingleWriterStorage,
  StorageError,
  applyMigrations,
  type SqlMigration,
} from './index.js'

const createdDirectories: string[] = []
const now = '2026-08-31T00:00:00.000Z'

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bosshunter-storage-test-'))
  createdDirectories.push(directory)
  return directory
}

function codec(seed = 7): Aes256GcmCodec {
  return new Aes256GcmCodec(Uint8Array.from({ length: 32 }, (_, index) => (seed + index) % 256))
}

function workspace(): Workspace {
  return {
    id: 'workspace-1',
    name: 'Private career vault',
    locale: 'zh-CN',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function profile(): PersonProfile {
  return {
    id: 'profile-1',
    workspaceId: 'workspace-1',
    displayName: 'Test Person',
    targetRoles: ['Product manager'],
    languages: ['Chinese'],
    createdAt: now,
    updatedAt: now,
  }
}

function expectStorageErrorCode(operation: () => unknown, code: StorageError['code']): void {
  let caught: unknown
  try {
    operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(StorageError)
  if (!(caught instanceof StorageError)) throw new Error('Expected a StorageError')
  expect(caught.code).toBe(code)
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AES-256-GCM sensitive field codec', () => {
  it('round-trips Unicode content and authenticates its storage context', () => {
    const subject = codec()
    const encoded = subject.encrypt('教育经历：可信', 'profile:1')
    expect(encoded).not.toContain('教育经历')
    expect(subject.decrypt(encoded, 'profile:1')).toBe('教育经历：可信')
    expect(() => subject.decrypt(encoded, 'profile:2')).toThrow(StorageError)
  })

  it('requires exactly 256 bits of host-provided key material', () => {
    expectStorageErrorCode(() => new Aes256GcmCodec(new Uint8Array(31)), 'ENCRYPTION_REQUIRED')
  })
})

describe('migration framework', () => {
  it('applies contiguous migrations and reports the schema version', () => {
    const database = new DatabaseSync(':memory:')
    const migration2: SqlMigration = {
      version: 2,
      name: 'test-index',
      checksum: 'test-v2',
      up(subject) {
        subject.exec('CREATE TABLE migration_test(id TEXT PRIMARY KEY) STRICT;')
      },
    }
    expect(applyMigrations(database, [...BASE_MIGRATIONS, migration2])).toBe(2)
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 })
    database.close()
  })

  it('rolls back a failed migration atomically', () => {
    const database = new DatabaseSync(':memory:')
    const badMigration: SqlMigration = {
      version: 2,
      name: 'intentional-failure',
      checksum: 'test-failure',
      up(subject) {
        subject.exec('CREATE TABLE should_rollback(id TEXT PRIMARY KEY) STRICT;')
        throw new Error('stop')
      },
    }
    expectStorageErrorCode(
      () => applyMigrations(database, [...BASE_MIGRATIONS, badMigration]),
      'MIGRATION_FAILED',
    )
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
      .get()
    expect(table).toBeUndefined()
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
    database.close()
  })
})

describe('single-writer encrypted repository', () => {
  it('enables integrity pragmas and stores domain payloads encrypted', () => {
    const directory = createDirectory()
    const filename = join(directory, 'vault.sqlite3')
    const storage = SingleWriterStorage.open(filename, { codec: codec() })
    storage.put('workspace', workspace())
    storage.put('person_profile', profile())

    expect(storage.diagnostics()).toMatchObject({
      schemaVersion: 1,
      foreignKeys: true,
      journalMode: 'wal',
      synchronous: 2,
    })
    expect(storage.get('person_profile', 'profile-1')).toEqual(profile())
    expect(storage.list('person_profile', 'workspace-1')).toEqual([profile()])
    storage.close()

    const raw = new DatabaseSync(filename, { readOnly: true })
    const row = raw
      .prepare('SELECT payload, encrypted FROM domain_records WHERE id = ?')
      .get('profile-1') as {
      payload: string
      encrypted: number
    }
    expect(row.encrypted).toBe(1)
    expect(row.payload.startsWith('bhenc:v1:')).toBe(true)
    expect(row.payload).not.toContain('Test Person')
    raw.close()

    expect(readFileSync(filename).includes(Buffer.from('Test Person'))).toBe(false)
  })

  it('rolls back every repository write when a transaction fails', () => {
    const storage = SingleWriterStorage.open(':memory:', { codec: codec() })
    storage.put('workspace', workspace())
    expect(() =>
      storage.transaction(() => {
        storage.put('person_profile', profile())
        throw new Error('abort')
      }),
    ).toThrow('abort')
    expect(storage.get('person_profile', 'profile-1')).toBeUndefined()
    storage.close()
  })

  it('enforces one writer per on-disk vault in the process', () => {
    const filename = join(createDirectory(), 'vault.sqlite3')
    const first = SingleWriterStorage.open(filename, { codec: codec() })
    expectStorageErrorCode(
      () => SingleWriterStorage.open(filename, { codec: codec() }),
      'STORAGE_WRITE_LOCKED',
    )
    first.close()
    const reopened = SingleWriterStorage.open(filename, { codec: codec() })
    reopened.close()
  })

  it('uses foreign-key cascade for true workspace deletion', () => {
    const storage = SingleWriterStorage.open(':memory:', { codec: codec() })
    storage.put('workspace', workspace())
    storage.put('person_profile', profile())
    expect(storage.delete('workspace', 'workspace-1')).toBe(true)
    expect(storage.get('person_profile', 'profile-1')).toBeUndefined()
    storage.close()
  })

  it('validates records before persistence', () => {
    const storage = SingleWriterStorage.open(':memory:', { codec: codec() })
    const invalid = { ...workspace(), ignored: true } as unknown as Workspace
    expectStorageErrorCode(() => storage.put('workspace', invalid), 'VALIDATION_FAILED')
    storage.close()
  })
})
