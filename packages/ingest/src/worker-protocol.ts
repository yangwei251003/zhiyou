import { IngestError, isIngestErrorCode, serializeIngestError, toIngestError } from './errors.js'
import { assertParserOutput, ParserRegistry } from './parsers.js'
import { sha256Bytes } from './security.js'
import type {
  DocumentKind,
  IngestLimits,
  ParseWorkerRequest,
  ParseWorkerResponse,
  ParsedDocument,
  ValidatedIngestInput,
} from './types.js'

export const INGEST_WORKER_PROTOCOL_VERSION = 1 as const

export function createParseWorkerRequest(
  requestId: string,
  input: ValidatedIngestInput,
  limits: IngestLimits,
): { request: ParseWorkerRequest; transfer: readonly ArrayBuffer[] } {
  if (requestId.trim().length === 0) {
    throw new IngestError('INVALID_WORKER_MESSAGE', 'Worker requests require a request id')
  }
  const ownedBytes = Uint8Array.from(input.bytes)
  const bytes = ownedBytes.buffer
  return {
    request: {
      protocolVersion: INGEST_WORKER_PROTOCOL_VERSION,
      type: 'parse_document',
      requestId,
      document: {
        safeFileName: input.safeFileName,
        kind: input.kind,
        mimeType: input.mimeType,
        contentHash: input.contentHash,
        bytes,
        metadata: input.metadata,
      },
      limits,
    },
    transfer: [bytes],
  }
}

export function workerSuccess(requestId: string, document: ParsedDocument): ParseWorkerResponse {
  return {
    protocolVersion: INGEST_WORKER_PROTOCOL_VERSION,
    type: 'parse_succeeded',
    requestId,
    document,
  }
}

export function workerFailure(requestId: string, error: IngestError): ParseWorkerResponse {
  return {
    protocolVersion: INGEST_WORKER_PROTOCOL_VERSION,
    type: 'parse_failed',
    requestId,
    error: serializeIngestError(error),
  }
}

export async function handleParseWorkerRequest(
  value: unknown,
  registry = new ParserRegistry(),
): Promise<ParseWorkerResponse> {
  const requestId = readRequestId(value)
  try {
    assertWorkerRequest(value)
    const input: ValidatedIngestInput = {
      safeFileName: value.document.safeFileName,
      kind: value.document.kind,
      mimeType: value.document.mimeType,
      contentHash: value.document.contentHash,
      bytes: new Uint8Array(value.document.bytes),
      metadata: value.document.metadata,
    }
    if (sha256Bytes(input.bytes) !== input.contentHash) {
      throw new IngestError(
        'INVALID_WORKER_MESSAGE',
        'Worker document bytes do not match the validated content hash',
      )
    }
    const parser = registry.get(input.kind)
    const document = await parser.parse({ input, limits: value.limits })
    assertParserOutput(document, input, parser, value.limits)
    return workerSuccess(value.requestId, document)
  } catch (error) {
    return workerFailure(requestId, toIngestError(error))
  }
}

export function assertWorkerRequest(value: unknown): asserts value is ParseWorkerRequest {
  if (!isRecord(value)) throwInvalidWorkerMessage('Worker request must be an object')
  if (value['protocolVersion'] !== INGEST_WORKER_PROTOCOL_VERSION) {
    throwInvalidWorkerMessage('Worker protocol version is incompatible')
  }
  if (value['type'] !== 'parse_document') {
    throwInvalidWorkerMessage('Worker request type is not recognized')
  }
  if (typeof value['requestId'] !== 'string' || value['requestId'].trim().length === 0) {
    throwInvalidWorkerMessage('Worker request id is invalid')
  }
  if (!isRecord(value['document'])) {
    throwInvalidWorkerMessage('Worker request is missing its document')
  }
  const document = value['document']
  if (
    typeof document['safeFileName'] !== 'string' ||
    !isDocumentKind(document['kind']) ||
    typeof document['mimeType'] !== 'string' ||
    typeof document['contentHash'] !== 'string' ||
    !(document['bytes'] instanceof ArrayBuffer) ||
    !isRecord(document['metadata'])
  ) {
    throwInvalidWorkerMessage('Worker document payload is invalid')
  }
  if (!isIngestLimits(value['limits'])) {
    throwInvalidWorkerMessage('Worker ingestion limits are invalid')
  }
}

export function assertWorkerResponse(
  value: unknown,
  expectedRequestId: string,
): asserts value is ParseWorkerResponse {
  if (!isRecord(value)) throwInvalidWorkerMessage('Worker response must be an object')
  if (value['protocolVersion'] !== INGEST_WORKER_PROTOCOL_VERSION) {
    throwInvalidWorkerMessage('Worker protocol version is incompatible')
  }
  if (value['requestId'] !== expectedRequestId) {
    throwInvalidWorkerMessage('Worker response does not match the request id')
  }
  if (value['type'] !== 'parse_succeeded' && value['type'] !== 'parse_failed') {
    throwInvalidWorkerMessage('Worker response type is not recognized')
  }
  if (value['type'] === 'parse_succeeded') {
    if (!isParsedDocumentShape(value['document'])) {
      throwInvalidWorkerMessage('Worker success response contains an invalid document')
    }
  } else if (!isSerializedErrorShape(value['error'])) {
    throwInvalidWorkerMessage('Worker failure response contains an invalid error')
  }
}

function isParsedDocumentShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['fileName'] === 'string' &&
    isDocumentKind(value['kind']) &&
    typeof value['mimeType'] === 'string' &&
    typeof value['contentHash'] === 'string' &&
    typeof value['parserId'] === 'string' &&
    Array.isArray(value['fragments'])
  )
}

function isSerializedErrorShape(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isIngestErrorCode(value['code']) ||
    typeof value['message'] !== 'string' ||
    typeof value['retryable'] !== 'boolean' ||
    !isRecord(value['details'])
  ) {
    return false
  }
  return Object.values(value['details']).every(
    (detail) =>
      detail === null ||
      typeof detail === 'string' ||
      typeof detail === 'number' ||
      typeof detail === 'boolean',
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDocumentKind(value: unknown): value is DocumentKind {
  return (
    value === 'markdown' ||
    value === 'text' ||
    value === 'pdf' ||
    value === 'docx' ||
    value === 'png' ||
    value === 'jpeg'
  )
}

function isIngestLimits(value: unknown): value is IngestLimits {
  if (!isRecord(value)) return false
  return [
    'maxBytes',
    'maxPages',
    'maxArchiveEntries',
    'maxArchiveUncompressedBytes',
    'maxDocxXmlBytes',
    'maxCompressionRatio',
    'maxExtractedCharacters',
    'maxFragmentCharacters',
    'maxFragments',
  ].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] > 0)
}

function readRequestId(value: unknown): string {
  if (isRecord(value) && typeof value['requestId'] === 'string' && value['requestId'].length > 0) {
    return value['requestId']
  }
  return 'invalid-request'
}

function throwInvalidWorkerMessage(message: string): never {
  throw new IngestError('INVALID_WORKER_MESSAGE', message)
}
