import { IngestError } from './errors.js'
import { sha256Text } from './security.js'
import { verifyDocxArchiveInflation } from './zip-security.js'
import type {
  DocumentKind,
  ParsedDocument,
  IngestLimits,
  ParserContext,
  ParserPlugin,
  ParserRegistryLike,
  SourceFragment,
  ValidatedIngestInput,
} from './types.js'

class PlainTextParser implements ParserPlugin {
  readonly id = 'plain-text@1'
  readonly supportedKinds = ['markdown', 'text'] as const

  parse({ input, limits }: ParserContext): Promise<ParsedDocument> {
    const content = decodePlainText(input.bytes, limits.maxExtractedCharacters)
    if (content.trim().length === 0) {
      throw new IngestError('EMPTY_FILE', 'The text document does not contain readable content')
    }
    const fragments = splitIntoFragments(content, input.contentHash, limits)
    return Promise.resolve({
      fileName: input.safeFileName,
      kind: input.kind,
      mimeType: input.mimeType,
      contentHash: input.contentHash,
      parserId: this.id,
      fragments,
    })
  }
}

class PdfTextParser implements ParserPlugin {
  readonly id = 'pdf2json-text@1'
  readonly supportedKinds = ['pdf'] as const

  async parse({ input, limits }: ParserContext): Promise<ParsedDocument> {
    if (input.metadata.hasTextLayer === false) {
      throw new IngestError('OCR_REQUIRED', 'This PDF has no usable text layer and requires OCR')
    }

    const PdfParser = await loadPdf2Json()
    try {
      const parsed = await parsePdfBuffer(PdfParser, input.bytes)
      const pages = extractPdfPages(parsed)
      if (pages.length === 0) {
        throw new IngestError('PARSE_FAILED', 'The PDF reports an invalid page count')
      }
      if (pages.length > limits.maxPages) {
        throw new IngestError('PAGE_LIMIT_EXCEEDED', 'The PDF has too many pages', {
          details: { pageCount: pages.length, maxPages: limits.maxPages },
        })
      }

      const fragments: SourceFragment[] = []
      const pagesRequiringOcr: number[] = []
      let documentOffset = 0
      for (const [pageIndex, rawPageText] of pages.entries()) {
        const pageNumber = pageIndex + 1
        const remainingCharacters = limits.maxExtractedCharacters - documentOffset
        const pageText = normalizePlainText(rawPageText, remainingCharacters)
        if (pageText.trim().length > 0) {
          const pageFragments = splitIntoFragments(
            pageText,
            input.contentHash,
            limits,
            pageNumber,
            documentOffset,
            fragments.length,
          )
          fragments.push(...pageFragments)
          documentOffset += pageText.length
        } else {
          pagesRequiringOcr.push(pageNumber)
        }
      }

      if (pagesRequiringOcr.length > 0) {
        throw new IngestError(
          'OCR_REQUIRED',
          'One or more PDF pages contain content but no extractable text',
          { details: { pages: pagesRequiringOcr.join(','), pageCount: pages.length } },
        )
      }
      if (fragments.length === 0) {
        throw new IngestError('EMPTY_FILE', 'The PDF does not contain readable content')
      }

      return {
        fileName: input.safeFileName,
        kind: input.kind,
        mimeType: input.mimeType,
        contentHash: input.contentHash,
        parserId: this.id,
        fragments,
      }
    } catch (error) {
      if (error instanceof IngestError) throw error
      if (isPdfPasswordError(error)) {
        throw new IngestError(
          'ENCRYPTED_DOCUMENT_REJECTED',
          'Password-protected PDFs are not accepted',
        )
      }
      throw new IngestError('PARSE_FAILED', errorMessage(error, 'PDF text extraction failed'), {
        retryable: true,
      })
    }
  }
}

class DocxTextParser implements ParserPlugin {
  readonly id = 'mammoth-raw-text@1'
  readonly supportedKinds = ['docx'] as const

  async parse({ input, limits }: ParserContext): Promise<ParsedDocument> {
    const archive = verifyDocxArchiveInflation(input.bytes, limits)
    if (archive.containsMacros) {
      throw new IngestError('MACRO_DOCUMENT_REJECTED', 'DOCX files containing macros are rejected')
    }

    const mammoth = await loadMammoth()
    let result: MammothRawTextResult
    try {
      result = await mammoth.extractRawText({ buffer: Buffer.from(input.bytes) })
    } catch (error) {
      throw new IngestError('PARSE_FAILED', errorMessage(error, 'DOCX text extraction failed'), {
        retryable: true,
      })
    }

    const content = normalizePlainText(result.value, limits.maxExtractedCharacters)
    if (content.trim().length === 0) {
      throw new IngestError(
        'OCR_REQUIRED',
        'The DOCX contains no extractable text; embedded images require OCR',
      )
    }

    return {
      fileName: input.safeFileName,
      kind: input.kind,
      mimeType: input.mimeType,
      contentHash: input.contentHash,
      parserId: this.id,
      fragments: splitIntoFragments(content, input.contentHash, limits),
    }
  }
}

class ImageOcrPlaceholderParser implements ParserPlugin {
  readonly id = 'image-ocr-placeholder@1'
  readonly supportedKinds = ['png', 'jpeg'] as const

  parse(): Promise<ParsedDocument> {
    return Promise.reject(
      new IngestError('OCR_REQUIRED', 'Image documents require the OCR adapter'),
    )
  }
}

export class ParserRegistry implements ParserRegistryLike {
  readonly #byKind = new Map<DocumentKind, ParserPlugin>()

  constructor(plugins: readonly ParserPlugin[] = defaultParserPlugins()) {
    for (const plugin of plugins) this.register(plugin)
  }

  register(plugin: ParserPlugin): void {
    if (plugin.id.trim().length === 0 || plugin.supportedKinds.length === 0) {
      throw new IngestError('PARSER_UNAVAILABLE', 'Parser plugins require an id and file kinds')
    }
    for (const kind of plugin.supportedKinds) {
      if (this.#byKind.has(kind)) {
        throw new IngestError('PARSER_UNAVAILABLE', 'Only one parser may own a file kind', {
          details: { kind, parserId: plugin.id },
        })
      }
      this.#byKind.set(kind, plugin)
    }
  }

  get(kind: DocumentKind): ParserPlugin {
    const parser = this.#byKind.get(kind)
    if (parser === undefined) {
      throw new IngestError('PARSER_UNAVAILABLE', 'No parser is registered for this file type', {
        details: { kind },
      })
    }
    return parser
  }
}

export function defaultParserPlugins(): readonly ParserPlugin[] {
  return [
    new PlainTextParser(),
    new PdfTextParser(),
    new DocxTextParser(),
    new ImageOcrPlaceholderParser(),
  ]
}

export function assertParserOutput(
  document: ParsedDocument,
  input: ValidatedIngestInput,
  parser: ParserPlugin,
  limits: IngestLimits,
): void {
  if (
    document.fileName !== input.safeFileName ||
    document.kind !== input.kind ||
    document.mimeType !== input.mimeType ||
    document.contentHash !== input.contentHash ||
    document.parserId !== parser.id ||
    !parser.supportedKinds.includes(input.kind)
  ) {
    throw new IngestError('PARSE_FAILED', 'Parser output does not match the validated input')
  }
  if (document.fragments.length === 0) {
    throw new IngestError('PARSE_FAILED', 'Parser output must contain at least one source fragment')
  }
  if (document.fragments.length > limits.maxFragments) {
    throw new IngestError(
      'FRAGMENT_LIMIT_EXCEEDED',
      'The extracted document contains too many text fragments',
      {
        details: {
          fragmentCount: document.fragments.length,
          maxFragments: limits.maxFragments,
        },
      },
    )
  }

  const extractedCharacters = document.fragments.reduce(
    (total, fragment) => total + fragment.content.length,
    0,
  )
  if (
    !Number.isSafeInteger(extractedCharacters) ||
    extractedCharacters > limits.maxExtractedCharacters
  ) {
    throw new IngestError(
      'EXTRACTED_TEXT_LIMIT_EXCEEDED',
      'The extracted document text exceeds the safe character limit',
      {
        details: { extractedCharacters, maxExtractedCharacters: limits.maxExtractedCharacters },
      },
    )
  }

  let expectedOffset = 0
  const fragmentIds = new Set<string>()
  for (const [index, fragment] of document.fragments.entries()) {
    const pageIsValid =
      fragment.page === null || (Number.isInteger(fragment.page) && fragment.page > 0)
    const fragmentIsValid =
      fragment.id.length > 0 &&
      fragment.ordinal === index &&
      fragment.startOffset === expectedOffset &&
      Number.isInteger(fragment.startOffset) &&
      Number.isInteger(fragment.endOffset) &&
      fragment.endOffset > fragment.startOffset &&
      pageIsValid &&
      fragment.contentHash === sha256Text(fragment.content) &&
      fragment.contentRole === 'data' &&
      fragment.trust === 'untrusted_user_content' &&
      fragment.renderMode === 'plain_text' &&
      !fragmentIds.has(fragment.id)
    if (!fragmentIsValid) {
      throw new IngestError('PARSE_FAILED', 'Parser returned an invalid source fragment', {
        details: { fragmentIndex: index, parserId: parser.id },
      })
    }
    fragmentIds.add(fragment.id)
    expectedOffset = fragment.endOffset
  }
}

function decodePlainText(bytes: Uint8Array, maxCharacters: number): string {
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return normalizePlainText(
    decoded.startsWith('\uFEFF') ? decoded.slice(1) : decoded,
    maxCharacters,
  )
}

function splitIntoFragments(
  content: string,
  documentHash: string,
  limits: IngestLimits,
  page: number | null = null,
  baseOffset = 0,
  baseOrdinal = 0,
): SourceFragment[] {
  if (content.length === 0) return []

  const fragments: SourceFragment[] = []
  let localStartOffset = 0
  while (localStartOffset < content.length) {
    if (baseOrdinal + fragments.length >= limits.maxFragments) {
      throw new IngestError(
        'FRAGMENT_LIMIT_EXCEEDED',
        'The extracted document contains too many text fragments',
        {
          details: {
            fragmentCount: baseOrdinal + fragments.length + 1,
            maxFragments: limits.maxFragments,
          },
        },
      )
    }
    const localEndOffset = findFragmentEnd(content, localStartOffset, limits.maxFragmentCharacters)
    const fragmentContent = content.slice(localStartOffset, localEndOffset)
    const contentHash = sha256Text(fragmentContent)
    const startOffset = baseOffset + localStartOffset
    const endOffset = baseOffset + localEndOffset
    fragments.push({
      id: sha256Text(
        `${documentHash}:${page ?? 'none'}:${startOffset}:${endOffset}:${contentHash}`,
      ),
      ordinal: baseOrdinal + fragments.length,
      page,
      startOffset,
      endOffset,
      offsetUnit: 'utf16_code_unit',
      content: fragmentContent,
      contentHash,
      contentRole: 'data',
      trust: 'untrusted_user_content',
      renderMode: 'plain_text',
    })
    localStartOffset = localEndOffset
  }
  return fragments
}

function findFragmentEnd(content: string, startOffset: number, maxCharacters: number): number {
  const hardEnd = Math.min(startOffset + maxCharacters, content.length)
  if (hardEnd === content.length) return hardEnd

  const preferredBoundary = content.lastIndexOf('\n', hardEnd)
  const minimumUsefulBoundary = startOffset + Math.floor(maxCharacters / 2)
  if (preferredBoundary >= minimumUsefulBoundary) return preferredBoundary + 1

  if (isHighSurrogate(content.charCodeAt(hardEnd - 1))) return hardEnd - 1
  return hardEnd
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff
}

function normalizePlainText(value: string, maxCharacters: number): string {
  if (maxCharacters < 0 || value.length > maxCharacters) {
    throw new IngestError(
      'EXTRACTED_TEXT_LIMIT_EXCEEDED',
      'The extracted document text exceeds the safe character limit',
      { details: { extractedCharacters: value.length, maxExtractedCharacters: maxCharacters } },
    )
  }

  const chunks: string[] = []
  let chunk = ''
  let outputLength = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    let character: string
    if (codeUnit === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1
      character = '\n'
    } else if (codeUnit === 0x0a || codeUnit === 0x09) {
      character = value.charAt(index)
    } else if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      character = ' '
    } else {
      character = value.charAt(index)
    }
    outputLength += character.length
    if (outputLength > maxCharacters) {
      throw new IngestError(
        'EXTRACTED_TEXT_LIMIT_EXCEEDED',
        'The extracted document text exceeds the safe character limit',
        { details: { extractedCharacters: outputLength, maxExtractedCharacters: maxCharacters } },
      )
    }
    chunk += character
    if (chunk.length >= 8_192) {
      chunks.push(chunk)
      chunk = ''
    }
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks.join('')
}

const PDF2JSON_MODULE_ID = 'pdf2json'
const MAMMOTH_MODULE_ID = 'mammoth'

interface Pdf2JsonParser {
  once(event: 'pdfParser_dataReady', listener: (data: unknown) => void): void
  once(event: 'pdfParser_dataError', listener: (error: unknown) => void): void
  removeListener(event: string, listener: (value: unknown) => void): void
  parseBuffer(buffer: Buffer): void
  destroy?: () => void
}

interface Pdf2JsonConstructor {
  new (context?: unknown, verbosity?: number): Pdf2JsonParser
}

interface MammothApi {
  extractRawText(input: { buffer: Buffer }): Promise<MammothRawTextResult>
}

interface MammothRawTextResult {
  value: string
  messages: readonly unknown[]
}

function parsePdfBuffer(PdfParser: Pdf2JsonConstructor, bytes: Uint8Array): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parser: Pdf2JsonParser
    try {
      parser = new PdfParser(null, 0)
    } catch (error) {
      reject(asError(error, 'Failed to initialize the PDF parser'))
      return
    }

    const onReady = (data: unknown): void => {
      cleanup()
      resolve(data)
    }
    const onError = (error: unknown): void => {
      cleanup()
      reject(asError(unwrapPdfParserError(error), 'PDF parsing failed'))
    }
    const cleanup = (): void => {
      ignoreCleanupFailure(() => parser.removeListener('pdfParser_dataReady', onReady))
      ignoreCleanupFailure(() => parser.removeListener('pdfParser_dataError', onError))
      ignoreCleanupFailure(() => parser.destroy?.())
    }

    parser.once('pdfParser_dataReady', onReady)
    parser.once('pdfParser_dataError', onError)
    try {
      // pdf2json inspects the backing ArrayBuffer. Give it an exact, zero-offset copy so a
      // pooled Node Buffer cannot make startxref point into unrelated slab bytes.
      const ownedBytes = Uint8Array.from(bytes)
      parser.parseBuffer(
        Buffer.from(ownedBytes.buffer, ownedBytes.byteOffset, ownedBytes.byteLength),
      )
    } catch (error) {
      cleanup()
      reject(asError(error, 'PDF parsing failed'))
    }
  })
}

function extractPdfPages(value: unknown): string[] {
  const root =
    isRecord(value) && Array.isArray(value['Pages'])
      ? value
      : isRecord(value) && isRecord(value['formImage'])
        ? value['formImage']
        : null
  if (root === null || !Array.isArray(root['Pages'])) {
    throw new IngestError('PARSE_FAILED', 'pdf2json returned no page collection')
  }
  return root['Pages'].map((page, pageIndex) => extractPdfPage(page, pageIndex))
}

function extractPdfPage(value: unknown, pageIndex: number): string {
  if (!isRecord(value)) {
    throw new IngestError('PARSE_FAILED', 'pdf2json returned an invalid page', {
      details: { page: pageIndex + 1 },
    })
  }
  const texts = Array.isArray(value['Texts']) ? value['Texts'] : []
  const blocks = texts
    .map((text, index) => extractPdfTextBlock(text, index))
    .filter((block): block is PdfTextBlock => block !== null)
    .sort((left, right) => left.y - right.y || left.x - right.x || left.index - right.index)

  const lines: Array<{ y: number; text: string }> = []
  for (const block of blocks) {
    const line = lines.at(-1)
    if (line === undefined || Math.abs(line.y - block.y) > 0.15) {
      lines.push({ y: block.y, text: block.text })
    } else {
      line.text = joinPdfText(line.text, block.text)
    }
  }
  return lines.map((line) => line.text).join('\n')
}

interface PdfTextBlock {
  x: number
  y: number
  index: number
  text: string
}

function extractPdfTextBlock(value: unknown, index: number): PdfTextBlock | null {
  if (!isRecord(value) || !Array.isArray(value['R'])) return null
  const text = value['R']
    .map((run) => {
      if (!isRecord(run) || typeof run['T'] !== 'string') return ''
      return decodePdfText(run['T'])
    })
    .join('')
  if (text.trim().length === 0) return null
  return {
    x: typeof value['x'] === 'number' && Number.isFinite(value['x']) ? value['x'] : index,
    y: typeof value['y'] === 'number' && Number.isFinite(value['y']) ? value['y'] : index,
    index,
    text,
  }
}

function decodePdfText(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function joinPdfText(left: string, right: string): string {
  if (left.length === 0 || right.length === 0) return left + right
  if (/\s$/u.test(left) || /^\s/u.test(right)) return left + right
  if (/\p{Script=Han}$/u.test(left) && /^\p{Script=Han}/u.test(right)) return left + right
  return `${left} ${right}`
}

function unwrapPdfParserError(value: unknown): unknown {
  if (isRecord(value) && value['parserError'] !== undefined) return value['parserError']
  return value
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (isRecord(value) && typeof value['message'] === 'string') {
    return new Error(value['message'])
  }
  if (typeof value === 'string' && value.length > 0) return new Error(value)
  return new Error(fallback)
}

function ignoreCleanupFailure(operation: () => void): void {
  try {
    operation()
  } catch {
    return
  }
}

async function loadPdf2Json(): Promise<Pdf2JsonConstructor> {
  const imported = await importDependency(PDF2JSON_MODULE_ID, 'pdf2json')
  const candidate = unwrapDefault(imported)
  if (typeof candidate !== 'function') {
    throw new IngestError('DEPENDENCY_UNAVAILABLE', 'pdf2json has an incompatible API')
  }
  return candidate as Pdf2JsonConstructor
}

async function loadMammoth(): Promise<MammothApi> {
  const imported = await importDependency(MAMMOTH_MODULE_ID, 'mammoth')
  const candidate = unwrapDefault(imported)
  if (!isRecord(candidate) || typeof candidate['extractRawText'] !== 'function') {
    throw new IngestError('DEPENDENCY_UNAVAILABLE', 'mammoth has an incompatible API')
  }
  const extractRawText = candidate['extractRawText'] as (input: {
    buffer: Buffer
  }) => Promise<unknown>
  return {
    async extractRawText(input) {
      const result = await extractRawText.call(candidate, input)
      if (!isRecord(result) || typeof result['value'] !== 'string') {
        throw new IngestError('PARSE_FAILED', 'mammoth returned an invalid text result')
      }
      return {
        value: result['value'],
        messages: Array.isArray(result['messages']) ? result['messages'] : [],
      }
    },
  }
}

async function importDependency(moduleId: string, dependency: string): Promise<unknown> {
  try {
    const imported: unknown = await import(moduleId)
    return imported
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new IngestError(
        'DEPENDENCY_UNAVAILABLE',
        `${dependency} is required to parse this document`,
        { retryable: true, details: { dependency } },
      )
    }
    throw new IngestError(
      'DEPENDENCY_UNAVAILABLE',
      errorMessage(error, `${dependency} could not be loaded`),
      { retryable: true, details: { dependency } },
    )
  }
}

function unwrapDefault(value: unknown): unknown {
  if (isRecord(value) && value['default'] !== undefined) return value['default']
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isModuleNotFound(error: unknown): boolean {
  return (
    isRecord(error) &&
    (error['code'] === 'ERR_MODULE_NOT_FOUND' || error['code'] === 'MODULE_NOT_FOUND')
  )
}

function isPdfPasswordError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'PasswordException' || /password|encrypted/iu.test(error.message))
  )
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback
}
