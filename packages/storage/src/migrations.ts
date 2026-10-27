import type { DatabaseSync } from 'node:sqlite'

import { StorageError } from './errors.js'

export interface SqlMigration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  up(database: DatabaseSync): void
}

interface AppliedMigrationRow {
  version: number
  name: string
  checksum: string
}

export const BASE_MIGRATIONS: readonly SqlMigration[] = [
  {
    version: 1,
    name: 'encrypted-domain-records',
    checksum: 'sha256:3bc2d7a18d4f7e539f75b60bd2e07bdb0d41ee165df61c15de8e11a78c3b30be',
    up(database) {
      database.exec(`
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          encrypted INTEGER NOT NULL CHECK (encrypted = 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE domain_records (
          kind TEXT NOT NULL,
          id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          encrypted INTEGER NOT NULL CHECK (encrypted = 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (kind, id),
          FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
        ) STRICT;

        CREATE INDEX domain_records_workspace_kind
          ON domain_records(workspace_id, kind, updated_at DESC);
      `)
    },
  },
]

function validateMigrationSet(migrations: readonly SqlMigration[]): readonly SqlMigration[] {
  const sorted = [...migrations].sort((left, right) => left.version - right.version)
  sorted.forEach((migration, index) => {
    const expected = index + 1
    if (!Number.isInteger(migration.version) || migration.version !== expected) {
      throw new StorageError(
        'MIGRATION_FAILED',
        `Migration versions must be contiguous from 1; expected ${expected}`,
      )
    }
    if (migration.name.trim().length === 0 || migration.checksum.trim().length === 0) {
      throw new StorageError(
        'MIGRATION_FAILED',
        `Migration ${migration.version} lacks identity data`,
      )
    }
  })
  return sorted
}

export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly SqlMigration[] = BASE_MIGRATIONS,
): number {
  const ordered = validateMigrationSet(migrations)
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `)

  const applied = database
    .prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    .all() as unknown as AppliedMigrationRow[]
  const latestAvailable = ordered.at(-1)?.version ?? 0
  const currentVersion = readPragmaNumber(database, 'user_version')
  if (currentVersion > latestAvailable) {
    throw new StorageError(
      'MIGRATION_FAILED',
      `Database schema ${currentVersion} is newer than supported schema ${latestAvailable}`,
    )
  }

  for (const row of applied) {
    const expected = ordered.find((migration) => migration.version === row.version)
    if (
      expected === undefined ||
      expected.name !== row.name ||
      expected.checksum !== row.checksum
    ) {
      throw new StorageError(
        'MIGRATION_FAILED',
        `Applied migration ${row.version} does not match this application build`,
      )
    }
  }

  const recordMigration = database.prepare(
    'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  )
  for (const migration of ordered) {
    if (migration.version <= currentVersion) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      migration.up(database)
      recordMigration.run(
        migration.version,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      )
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw new StorageError(
        'MIGRATION_FAILED',
        `Migration ${migration.version} (${migration.name}) failed and was rolled back`,
        error,
      )
    }
  }

  return readPragmaNumber(database, 'user_version')
}

function readPragmaNumber(database: DatabaseSync, pragma: 'user_version'): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown> | undefined
  const value = row?.[pragma]
  if (typeof value !== 'number' && typeof value !== 'bigint') {
    throw new StorageError('STORAGE_CORRUPT', `PRAGMA ${pragma} did not return a number`)
  }
  return Number(value)
}
