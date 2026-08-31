import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DomainEntitySchemaMap,
  type DomainEntityKind,
  type DomainEntityMap,
  type Workspace,
} from '@bosshunter/domain'
import type { SensitiveFieldCodec } from './encryption.js'
import { StorageError } from './errors.js'
import { applyMigrations, BASE_MIGRATIONS, type SqlMigration } from './migrations.js'

interface StoredRow {
  id: string
  payload: string
  encrypted: number
}

export interface StorageOpenOptions {
  readonly codec: SensitiveFieldCodec
  readonly migrations?: readonly SqlMigration[]
  readonly busyTimeoutMs?: number
  /** Test-only failure injection at deterministic pre-write boundaries. */
  readonly faultInjector?: (event: StorageFaultEvent) => void
}

export interface StorageFaultEvent {
  readonly operation: 'put'
  readonly kind: DomainEntityKind
  readonly id: string
}

export interface StorageDiagnostics {
  readonly schemaVersion: number
  readonly foreignKeys: boolean
  readonly journalMode: string
  readonly synchronous: number
}

const writerPaths = new Set<string>()

function lockKey(filename: string): string | undefined {
  return filename === ':memory:' ? undefined : resolve(filename)
}

function parseEntity<K extends DomainEntityKind>(kind: K, input: unknown): DomainEntityMap[K] {
  try {
    const schema = DomainEntitySchemaMap[kind] as { parse(value: unknown): unknown }
    return schema.parse(input) as DomainEntityMap[K]
  } catch (error) {
    throw new StorageError('VALIDATION_FAILED', `Invalid ${kind} record`, error)
  }
}

function workspaceIdOf<K extends Exclude<DomainEntityKind, 'workspace'>>(
  entity: DomainEntityMap[K],
): string {
  return entity.workspaceId
}

export class SingleWriterStorage {
  readonly #database: DatabaseSync
  readonly #codec: SensitiveFieldCodec
  readonly #lockKey: string | undefined
  readonly #faultInjector: ((event: StorageFaultEvent) => void) | undefined
  #closed = false
  #transactionDepth = 0

  private constructor(
    database: DatabaseSync,
    codec: SensitiveFieldCodec,
    pathLock: string | undefined,
    faultInjector: ((event: StorageFaultEvent) => void) | undefined,
  ) {
    this.#database = database
    this.#codec = codec
    this.#lockKey = pathLock
    this.#faultInjector = faultInjector
  }

  static open(filename: string, options: StorageOpenOptions): SingleWriterStorage {
    const pathLock = lockKey(filename)
    if (pathLock !== undefined && writerPaths.has(pathLock)) {
      throw new StorageError(
        'STORAGE_WRITE_LOCKED',
        `A writer for ${pathLock} is already open in this process`,
      )
    }
    if (pathLock !== undefined) writerPaths.add(pathLock)

    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(filename, { timeout: options.busyTimeoutMs ?? 5_000 })
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      applyMigrations(database, options.migrations ?? BASE_MIGRATIONS)
      return new SingleWriterStorage(database, options.codec, pathLock, options.faultInjector)
    } catch (error) {
      database?.close()
      if (pathLock !== undefined) writerPaths.delete(pathLock)
      if (error instanceof StorageError) throw error
      throw new StorageError('STORAGE_CORRUPT', `Could not open database ${filename}`, error)
    }
  }

  get schemaVersion(): number {
    this.#assertOpen()
    return this.#pragmaNumber('user_version')
  }

  diagnostics(): StorageDiagnostics {
    this.#assertOpen()
    return {
      schemaVersion: this.schemaVersion,
      foreignKeys: this.#pragmaNumber('foreign_keys') === 1,
      journalMode: this.#pragmaString('journal_mode'),
      synchronous: this.#pragmaNumber('synchronous'),
    }
  }

  transaction<T>(work: (storage: SingleWriterStorage) => T): T {
    this.#assertOpen()
    const depth = this.#transactionDepth
    const savepoint = `bh_tx_${depth}`
    this.#database.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    this.#transactionDepth += 1
    try {
      const result = work(this)
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result &&
        typeof result.then === 'function'
      ) {
        throw new StorageError(
          'CONFLICT',
          'Storage transactions must be synchronous so the commit boundary is deterministic',
        )
      }
      this.#database.exec(depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      this.#database.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`)
      if (depth !== 0) this.#database.exec(`RELEASE SAVEPOINT ${savepoint}`)
      throw error
    } finally {
      this.#transactionDepth -= 1
    }
  }

  put<K extends DomainEntityKind>(kind: K, entityInput: DomainEntityMap[K]): DomainEntityMap[K] {
    this.#assertOpen()
    const entity = parseEntity(kind, entityInput)
    this.#faultInjector?.({ operation: 'put', kind, id: entity.id })
    if (kind === 'workspace') {
      this.#putWorkspace(entity as Workspace)
      return entity
    }

    const record = entity as DomainEntityMap[Exclude<DomainEntityKind, 'workspace'>]
    const workspaceId = workspaceIdOf(record)
    const storageTime = new Date().toISOString()
    const payload = this.#codec.encrypt(
      JSON.stringify(record),
      this.#recordAad(kind, record.id, workspaceId),
    )
    try {
      this.#database
        .prepare(
          `INSERT INTO domain_records(kind, id, workspace_id, payload, encrypted, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(kind, id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             payload = excluded.payload,
             encrypted = 1,
             updated_at = excluded.updated_at`,
        )
        .run(kind, record.id, workspaceId, payload, storageTime, storageTime)
    } catch (error) {
      throw new StorageError('CONFLICT', `Could not store ${kind} ${record.id}`, error)
    }
    return entity
  }

  putMany<K extends DomainEntityKind>(
    kind: K,
    entities: readonly DomainEntityMap[K][],
  ): readonly DomainEntityMap[K][] {
    return this.transaction(() => entities.map((entity) => this.put(kind, entity)))
  }

  get<K extends DomainEntityKind>(kind: K, id: string): DomainEntityMap[K] | undefined {
    this.#assertOpen()
    if (kind === 'workspace') {
      const row = this.#database
        .prepare('SELECT id, payload, encrypted FROM workspaces WHERE id = ?')
        .get(id) as StoredRow | undefined
      if (row === undefined) return undefined
      return parseEntity(kind, this.#decode(row, this.#workspaceAad(id)))
    }

    const row = this.#database
      .prepare('SELECT id, payload, encrypted FROM domain_records WHERE kind = ? AND id = ?')
      .get(kind, id) as StoredRow | undefined
    if (row === undefined) return undefined
    const workspaceId = this.#workspaceIdFor(kind, id)
    return parseEntity(kind, this.#decode(row, this.#recordAad(kind, id, workspaceId)))
  }

  list<K extends DomainEntityKind>(kind: K, workspaceId?: string): readonly DomainEntityMap[K][] {
    this.#assertOpen()
    if (kind === 'workspace') {
      const rows = this.#database
        .prepare('SELECT id, payload, encrypted FROM workspaces ORDER BY updated_at DESC, id')
        .all() as unknown as StoredRow[]
      return rows.map((row) => parseEntity(kind, this.#decode(row, this.#workspaceAad(row.id))))
    }
    if (workspaceId === undefined) {
      throw new StorageError('VALIDATION_FAILED', `Listing ${kind} requires a workspace id`)
    }
    const rows = this.#database
      .prepare(
        `SELECT id, payload, encrypted FROM domain_records
         WHERE kind = ? AND workspace_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(kind, workspaceId) as unknown as StoredRow[]
    return rows.map((row) =>
      parseEntity(kind, this.#decode(row, this.#recordAad(kind, row.id, workspaceId))),
    )
  }

  count(kind: DomainEntityKind, workspaceId?: string): number {
    this.#assertOpen()
    if (kind === 'workspace') {
      const row = this.#database.prepare('SELECT count(*) AS count FROM workspaces').get() as {
        count: number
      }
      return row.count
    }
    if (workspaceId === undefined) {
      throw new StorageError('VALIDATION_FAILED', `Counting ${kind} requires a workspace id`)
    }
    const row = this.#database
      .prepare('SELECT count(*) AS count FROM domain_records WHERE kind = ? AND workspace_id = ?')
      .get(kind, workspaceId) as { count: number }
    return row.count
  }

  delete(kind: DomainEntityKind, id: string): boolean {
    this.#assertOpen()
    const result =
      kind === 'workspace'
        ? this.#database.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
        : this.#database
            .prepare('DELETE FROM domain_records WHERE kind = ? AND id = ?')
            .run(kind, id)
    return Number(result.changes) === 1
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#database.close()
    if (this.#lockKey !== undefined) writerPaths.delete(this.#lockKey)
  }

  #putWorkspace(workspace: Workspace): void {
    const payload = this.#codec.encrypt(JSON.stringify(workspace), this.#workspaceAad(workspace.id))
    this.#database
      .prepare(
        `INSERT INTO workspaces(id, payload, encrypted, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           encrypted = 1,
           updated_at = excluded.updated_at`,
      )
      .run(workspace.id, payload, workspace.createdAt, workspace.updatedAt)
  }

  #workspaceIdFor(kind: DomainEntityKind, id: string): string {
    const row = this.#database
      .prepare('SELECT workspace_id FROM domain_records WHERE kind = ? AND id = ?')
      .get(kind, id) as { workspace_id: string } | undefined
    if (row === undefined) {
      throw new StorageError('STORAGE_CORRUPT', `Record ${kind} ${id} lost its workspace binding`)
    }
    return row.workspace_id
  }

  #decode(row: StoredRow, aad: string): unknown {
    if (row.encrypted !== 1) {
      throw new StorageError('STORAGE_CORRUPT', `Record ${row.id} is unexpectedly unencrypted`)
    }
    try {
      return JSON.parse(this.#codec.decrypt(row.payload, aad)) as unknown
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError('STORAGE_CORRUPT', `Record ${row.id} contains invalid JSON`, error)
    }
  }

  #workspaceAad(id: string): string {
    return `workspace:${id}`
  }

  #recordAad(kind: DomainEntityKind, id: string, workspaceId: string): string {
    return `record:${kind}:${id}:workspace:${workspaceId}`
  }

  #assertOpen(): void {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED', 'Storage is already closed')
  }

  #pragmaNumber(name: 'user_version' | 'foreign_keys' | 'synchronous'): number {
    const row = this.#database.prepare(`PRAGMA ${name}`).get() as
      Record<string, unknown> | undefined
    const value = row?.[name]
    if (typeof value !== 'number' && typeof value !== 'bigint') {
      throw new StorageError('STORAGE_CORRUPT', `PRAGMA ${name} did not return a number`)
    }
    return Number(value)
  }

  #pragmaString(name: 'journal_mode'): string {
    const row = this.#database.prepare(`PRAGMA ${name}`).get() as
      Record<string, unknown> | undefined
    const value = row?.[name]
    if (typeof value !== 'string') {
      throw new StorageError('STORAGE_CORRUPT', `PRAGMA ${name} did not return text`)
    }
    return value
  }
}
