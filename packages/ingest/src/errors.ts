export const INGEST_ERROR_CODES = [
  'EMPTY_FILE',
  'INVALID_FILENAME',
  'PATH_TRAVERSAL',
  'DOUBLE_EXTENSION',
  'UNSUPPORTED_TYPE',
  'LEGACY_DOC_REJECTED',
  'MACRO_DOCUMENT_REJECTED',
  'FILE_TOO_LARGE',
  'MIME_MISMATCH',
  'MAGIC_MISMATCH',
  'BINARY_TEXT_REJECTED',
  'PAGE_LIMIT_EXCEEDED',
  'EXTRACTED_TEXT_LIMIT_EXCEEDED',
  'FRAGMENT_LIMIT_EXCEEDED',
  'ARCHIVE_LIMIT_EXCEEDED',
  'ARCHIVE_BOMB_SUSPECTED',
  'ARCHIVE_UNSAFE_PATH',
  'ARCHIVE_INVALID',
  'ENCRYPTED_DOCUMENT_REJECTED',
  'OCR_REQUIRED',
  'DEPENDENCY_UNAVAILABLE',
  'PARSER_UNAVAILABLE',
  'PARSE_FAILED',
  'PARSE_TIMEOUT',
  'RESOURCE_LIMIT_EXCEEDED',
  'INVALID_WORKER_MESSAGE',
  'INVALID_TRANSITION',
] as const

export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number]

export function isIngestErrorCode(value: unknown): value is IngestErrorCode {
  return typeof value === 'string' && INGEST_ERROR_CODES.some((code) => code === value)
}

export type IngestErrorDetail = string | number | boolean | null

export interface SerializedIngestError {
  code: IngestErrorCode
  message: string
  retryable: boolean
  details: Readonly<Record<string, IngestErrorDetail>>
}

export class IngestError extends Error {
  readonly code: IngestErrorCode
  readonly retryable: boolean
  readonly details: Readonly<Record<string, IngestErrorDetail>>

  constructor(
    code: IngestErrorCode,
    message: string,
    options: {
      retryable?: boolean
      details?: Readonly<Record<string, IngestErrorDetail>>
    } = {},
  ) {
    super(message)
    this.name = 'IngestError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? {}
  }
}

export function serializeIngestError(error: IngestError): SerializedIngestError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    details: { ...error.details },
  }
}

export function toIngestError(error: unknown): IngestError {
  if (error instanceof IngestError) return error
  if (error instanceof Error) {
    return new IngestError('PARSE_FAILED', error.message, { retryable: true })
  }
  return new IngestError('PARSE_FAILED', 'The parser failed with an unknown error', {
    retryable: true,
  })
}
