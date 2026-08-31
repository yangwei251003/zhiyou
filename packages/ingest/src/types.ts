import type { IngestError, SerializedIngestError } from './errors.js'

export type DocumentKind = 'markdown' | 'text' | 'pdf' | 'docx' | 'png' | 'jpeg'

export interface ArchiveInspection {
  entryCount: number
  compressedBytes: number
  uncompressedBytes: number
  entryNames: readonly string[]
  containsMacros: boolean
}

export interface IngestMetadata {
  pageCount?: number
  hasTextLayer?: boolean
  archive?: ArchiveInspection
}

export interface IngestInput {
  fileName: string
  bytes: Uint8Array
  declaredMimeType?: string | null
  sourcePath?: string
  allowedRoot?: string
  metadata?: IngestMetadata
}

export interface IngestLimits {
  maxBytes: number
  maxPages: number
  maxArchiveEntries: number
  maxArchiveUncompressedBytes: number
  maxDocxXmlBytes: number
  maxCompressionRatio: number
  maxExtractedCharacters: number
  maxFragmentCharacters: number
  maxFragments: number
}

export interface ValidatedIngestInput {
  safeFileName: string
  kind: DocumentKind
  mimeType: string
  contentHash: string
  bytes: Uint8Array
  metadata: IngestMetadata
}

export interface SourceFragment {
  id: string
  ordinal: number
  page: number | null
  startOffset: number
  endOffset: number
  offsetUnit: 'utf16_code_unit'
  content: string
  contentHash: string
  contentRole: 'data'
  trust: 'untrusted_user_content'
  renderMode: 'plain_text'
}

export interface ParsedDocument {
  fileName: string
  kind: DocumentKind
  mimeType: string
  contentHash: string
  parserId: string
  fragments: readonly SourceFragment[]
}

export interface ParserContext {
  input: ValidatedIngestInput
  limits: IngestLimits
}

export interface ParserPlugin {
  readonly id: string
  readonly supportedKinds: readonly DocumentKind[]
  parse(context: ParserContext): Promise<ParsedDocument>
}

export type IngestJobStatus =
  'queued' | 'validating' | 'parsing' | 'needs_ocr' | 'completed' | 'failed'

export interface IngestStateEvent {
  status: IngestJobStatus
  at: string
  parserId?: string
  error?: SerializedIngestError
}

interface IngestRunBase {
  jobId: string
  history: readonly IngestStateEvent[]
}

export type IngestRun =
  | (IngestRunBase & {
      status: 'completed'
      document: ParsedDocument
    })
  | (IngestRunBase & {
      status: 'needs_ocr' | 'failed'
      error: SerializedIngestError
    })

export interface IngestOptions {
  limits?: Partial<IngestLimits>
  registry?: ParserRegistryLike
  jobId?: string
  now?: () => Date
  onStateChange?: (event: IngestStateEvent) => void
}

export interface ParserRegistryLike {
  get(kind: DocumentKind): ParserPlugin
}

export interface WorkerParseDocument {
  safeFileName: string
  kind: DocumentKind
  mimeType: string
  contentHash: string
  bytes: ArrayBuffer
  metadata: IngestMetadata
}

export interface ParseWorkerRequest {
  protocolVersion: 1
  type: 'parse_document'
  requestId: string
  document: WorkerParseDocument
  limits: IngestLimits
}

export type ParseWorkerResponse =
  | {
      protocolVersion: 1
      type: 'parse_succeeded'
      requestId: string
      document: ParsedDocument
    }
  | {
      protocolVersion: 1
      type: 'parse_failed'
      requestId: string
      error: SerializedIngestError
    }

export interface WorkerParserExecutor {
  execute(
    request: ParseWorkerRequest,
    transfer: readonly ArrayBuffer[],
  ): Promise<ParseWorkerResponse>
}

export type ParserFailure = IngestError
