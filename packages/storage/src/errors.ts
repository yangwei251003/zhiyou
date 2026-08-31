export type StorageErrorCode =
  | 'STORAGE_WRITE_LOCKED'
  | 'STORAGE_CLOSED'
  | 'STORAGE_CORRUPT'
  | 'ENCRYPTION_FAILED'
  | 'ENCRYPTION_REQUIRED'
  | 'MIGRATION_FAILED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    readonly causeValue?: unknown,
  ) {
    super(message, causeValue === undefined ? undefined : { cause: causeValue })
    this.name = 'StorageError'
  }
}
