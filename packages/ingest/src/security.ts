import { createHash } from 'node:crypto'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { IngestError } from './errors.js'
import type {
  ArchiveInspection,
  DocumentKind,
  IngestInput,
  IngestLimits,
  ValidatedIngestInput,
} from './types.js'
import { inspectDocxArchive } from './zip-security.js'

const MEBIBYTE = 1024 * 1024

export const DEFAULT_INGEST_LIMITS: Readonly<IngestLimits> = Object.freeze({
  maxBytes: 10 * MEBIBYTE,
  maxPages: 100,
  maxArchiveEntries: 2_048,
  maxArchiveUncompressedBytes: 100 * MEBIBYTE,
  maxDocxXmlBytes: 8 * MEBIBYTE,
  maxCompressionRatio: 100,
  maxExtractedCharacters: 2_000_000,
  maxFragmentCharacters: 8_000,
  maxFragments: 2_000,
})

const EXTENSION_TO_KIND: Readonly<Record<string, DocumentKind>> = Object.freeze({
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
})

const MIME_BY_KIND: Readonly<Record<DocumentKind, readonly string[]>> = Object.freeze({
  markdown: ['text/markdown', 'text/plain'],
  text: ['text/plain'],
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/pjpeg'],
})

const SUSPICIOUS_INNER_EXTENSIONS = new Set([
  '.bat',
  '.cmd',
  '.com',
  '.doc',
  '.docm',
  '.docx',
  '.exe',
  '.htm',
  '.html',
  '.jar',
  '.js',
  '.jpeg',
  '.jpg',
  '.lnk',
  '.markdown',
  '.md',
  '.msi',
  '.pdf',
  '.png',
  '.ps1',
  '.scr',
  '.txt',
  '.vbs',
  '.zip',
])

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const OLE_COMPOUND_MAGIC = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const PDF_MAGIC = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])
const ZIP_LOCAL_MAGIC = Uint8Array.from([0x50, 0x4b, 0x03, 0x04])
const ZIP_EMPTY_MAGIC = Uint8Array.from([0x50, 0x4b, 0x05, 0x06])
const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Uint8Array.from([0xff, 0xd8, 0xff])

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, 'utf8'))
}

export function mergeIngestLimits(overrides: Partial<IngestLimits> = {}): IngestLimits {
  const merged = { ...DEFAULT_INGEST_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new IngestError('PARSE_FAILED', `Invalid ingestion limit: ${name}`, {
        details: { limit: name, value },
      })
    }
  }
  return merged
}

export function validateIngestInput(
  input: IngestInput,
  limits: IngestLimits = mergeIngestLimits(),
): ValidatedIngestInput {
  const safeFileName = validateFileName(input.fileName)
  validateSourcePath(input.sourcePath, input.allowedRoot)

  const extension = extname(safeFileName).toLowerCase()
  rejectLegacyOrMacroExtension(extension)
  rejectSuspiciousDoubleExtension(safeFileName, extension)

  const kind = EXTENSION_TO_KIND[extension]
  if (kind === undefined) {
    throw new IngestError('UNSUPPORTED_TYPE', 'This file type is not supported', {
      details: { extension: extension || '(none)' },
    })
  }

  if (input.bytes.byteLength === 0) {
    throw new IngestError('EMPTY_FILE', 'The selected file is empty')
  }
  if (input.bytes.byteLength > limits.maxBytes) {
    throw new IngestError('FILE_TOO_LARGE', 'The selected file exceeds the ingestion limit', {
      details: { bytes: input.bytes.byteLength, maxBytes: limits.maxBytes },
    })
  }

  if (startsWith(input.bytes, OLE_COMPOUND_MAGIC)) {
    throw new IngestError(
      'LEGACY_DOC_REJECTED',
      'Legacy Office compound documents are not accepted; export a DOCX file instead',
    )
  }

  const mimeType = normalizeMime(input.declaredMimeType) ?? defaultMimeFor(kind)
  validateDeclaredMime(kind, mimeType)
  validateMagicAndText(kind, input.bytes)

  const metadata = input.metadata ?? {}
  validatePageLimit(metadata.pageCount, limits)
  if (kind === 'docx') validateDocxArchive(input.bytes, metadata.archive, limits)

  return {
    safeFileName,
    kind,
    mimeType,
    contentHash: sha256Bytes(input.bytes),
    bytes: Uint8Array.from(input.bytes),
    metadata,
  }
}

function validateFileName(value: string): string {
  if (value.length === 0 || value.length > 255 || hasControlCharacter(value)) {
    throw new IngestError('INVALID_FILENAME', 'The selected file has an invalid name')
  }
  if (
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    basename(value) !== value
  ) {
    throw new IngestError('PATH_TRAVERSAL', 'File names must not contain a path')
  }
  if (value.endsWith('.') || value.endsWith(' ') || value.includes(':')) {
    throw new IngestError('INVALID_FILENAME', 'The selected file name is unsafe on Windows')
  }
  if (WINDOWS_RESERVED_NAME.test(value)) {
    throw new IngestError('INVALID_FILENAME', 'The selected file name is reserved by Windows')
  }
  return value.normalize('NFC')
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function validateSourcePath(sourcePath: string | undefined, allowedRoot: string | undefined): void {
  if (sourcePath === undefined && allowedRoot === undefined) return
  if (sourcePath === undefined || allowedRoot === undefined) {
    throw new IngestError(
      'PATH_TRAVERSAL',
      'A source path and its allowed root must be supplied together',
    )
  }

  const root = resolve(allowedRoot)
  const candidate = resolve(sourcePath)
  const pathFromRoot = relative(root, candidate)
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new IngestError('PATH_TRAVERSAL', 'The selected file is outside the allowed import root')
  }
}

function rejectLegacyOrMacroExtension(extension: string): void {
  if (extension === '.doc') {
    throw new IngestError(
      'LEGACY_DOC_REJECTED',
      'Legacy .doc files are not accepted; export a DOCX file instead',
    )
  }
  if (extension === '.docm' || extension === '.dotm') {
    throw new IngestError('MACRO_DOCUMENT_REJECTED', 'Macro-enabled Office files are not accepted')
  }
}

function rejectSuspiciousDoubleExtension(fileName: string, extension: string): void {
  const withoutFinalExtension = fileName.slice(0, fileName.length - extension.length)
  const innerExtension = extname(withoutFinalExtension).toLowerCase()
  if (innerExtension.length > 0 && SUSPICIOUS_INNER_EXTENSIONS.has(innerExtension)) {
    throw new IngestError(
      'DOUBLE_EXTENSION',
      'Suspicious double-extension file names are rejected',
      { details: { innerExtension, extension } },
    )
  }
}

function normalizeMime(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.trim().length === 0) return null
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? null
}

function validateDeclaredMime(kind: DocumentKind, mimeType: string): void {
  if (!MIME_BY_KIND[kind].includes(mimeType)) {
    throw new IngestError('MIME_MISMATCH', 'The declared MIME type does not match the extension', {
      details: { kind, mimeType },
    })
  }
}

function defaultMimeFor(kind: DocumentKind): string {
  const mimeType = MIME_BY_KIND[kind][0]
  if (mimeType === undefined) {
    throw new IngestError('UNSUPPORTED_TYPE', 'No MIME type is registered for this file kind', {
      details: { kind },
    })
  }
  return mimeType
}

function validateMagicAndText(kind: DocumentKind, bytes: Uint8Array): void {
  switch (kind) {
    case 'pdf':
      requireMagic(bytes, PDF_MAGIC, kind)
      return
    case 'docx':
      if (!startsWith(bytes, ZIP_LOCAL_MAGIC) && !startsWith(bytes, ZIP_EMPTY_MAGIC)) {
        throwMagicMismatch(kind)
      }
      return
    case 'png':
      requireMagic(bytes, PNG_MAGIC, kind)
      return
    case 'jpeg':
      requireMagic(bytes, JPEG_MAGIC, kind)
      return
    case 'markdown':
    case 'text':
      if (
        startsWith(bytes, PDF_MAGIC) ||
        startsWith(bytes, ZIP_LOCAL_MAGIC) ||
        startsWith(bytes, PNG_MAGIC) ||
        startsWith(bytes, JPEG_MAGIC)
      ) {
        throwMagicMismatch(kind)
      }
      validateUtf8Text(bytes)
  }
}

function validateUtf8Text(bytes: Uint8Array): void {
  if (bytes.includes(0)) {
    throw new IngestError('BINARY_TEXT_REJECTED', 'Text documents must not contain NUL bytes')
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new IngestError('BINARY_TEXT_REJECTED', 'Text documents must contain valid UTF-8')
  }
}

function requireMagic(bytes: Uint8Array, magic: Uint8Array, kind: DocumentKind): void {
  if (!startsWith(bytes, magic)) throwMagicMismatch(kind)
}

function throwMagicMismatch(kind: DocumentKind): never {
  throw new IngestError('MAGIC_MISMATCH', 'The file signature does not match its extension', {
    details: { kind },
  })
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false
  return prefix.every((value, index) => bytes[index] === value)
}

function validatePageLimit(pageCount: number | undefined, limits: IngestLimits): void {
  if (pageCount === undefined) return
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new IngestError('PAGE_LIMIT_EXCEEDED', 'Page count metadata is invalid', {
      details: { pageCount },
    })
  }
  if (pageCount > limits.maxPages) {
    throw new IngestError('PAGE_LIMIT_EXCEEDED', 'The document has too many pages', {
      details: { pageCount, maxPages: limits.maxPages },
    })
  }
}

function validateDocxArchive(
  bytes: Uint8Array,
  archive: ArchiveInspection | undefined,
  limits: IngestLimits,
): void {
  const inspected = inspectDocxArchive(bytes, limits)
  if (inspected.containsMacros) {
    throw new IngestError('MACRO_DOCUMENT_REJECTED', 'DOCX files containing macros are rejected')
  }
  if (archive === undefined) return
  validateReportedArchive(archive, limits)
  if (
    archive.entryCount !== inspected.entryCount ||
    archive.compressedBytes !== inspected.compressedBytes ||
    archive.uncompressedBytes !== inspected.uncompressedBytes
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'Reported DOCX archive metadata is inconsistent')
  }
}

function validateReportedArchive(archive: ArchiveInspection, limits: IngestLimits): void {
  if (
    !Number.isSafeInteger(archive.entryCount) ||
    archive.entryCount < 0 ||
    archive.entryNames.length !== archive.entryCount ||
    !Number.isSafeInteger(archive.compressedBytes) ||
    archive.compressedBytes < 0 ||
    !Number.isSafeInteger(archive.uncompressedBytes) ||
    archive.uncompressedBytes < 0
  ) {
    throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'Archive inspection metadata is invalid')
  }
  if (
    archive.entryCount > limits.maxArchiveEntries ||
    archive.uncompressedBytes > limits.maxArchiveUncompressedBytes
  ) {
    throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'The DOCX archive exceeds safe limits', {
      details: {
        entryCount: archive.entryCount,
        uncompressedBytes: archive.uncompressedBytes,
      },
    })
  }
  const ratio =
    archive.compressedBytes === 0
      ? archive.uncompressedBytes === 0
        ? 1
        : Number.POSITIVE_INFINITY
      : archive.uncompressedBytes / archive.compressedBytes
  if (ratio > limits.maxCompressionRatio) {
    throw new IngestError('ARCHIVE_BOMB_SUSPECTED', 'The DOCX compression ratio is unsafe', {
      details: {
        compressionRatio: Number.isFinite(ratio) ? ratio : 'infinite',
        maxCompressionRatio: limits.maxCompressionRatio,
      },
    })
  }
}
