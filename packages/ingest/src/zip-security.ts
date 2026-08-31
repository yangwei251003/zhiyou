import { inflateRawSync } from 'node:zlib'
import { posix } from 'node:path'

import { IngestError } from './errors.js'
import type { ArchiveInspection, IngestLimits } from './types.js'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const LOCAL_FILE_SIGNATURE = 0x04034b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const MAX_ZIP_COMMENT_BYTES = 65_535
const EOCD_FIXED_BYTES = 22
const CENTRAL_FILE_FIXED_BYTES = 46
const LOCAL_FILE_FIXED_BYTES = 30

interface DocxArchiveEntry {
  readonly name: string
  readonly flags: number
  readonly compressionMethod: 0 | 8
  readonly checksum: number
  readonly compressedBytes: number
  readonly uncompressedBytes: number
  readonly localHeaderOffset: number
  readonly dataOffset: number
  readonly usesDataDescriptor: boolean
}

interface ParsedDocxArchive {
  readonly inspection: ArchiveInspection
  readonly entries: readonly DocxArchiveEntry[]
}

export function inspectDocxArchive(bytes: Uint8Array, limits: IngestLimits): ArchiveInspection {
  return readDocxArchive(bytes, limits).inspection
}

/**
 * Re-inflates every XML/relationship part that the DOCX parser can consume. Central-directory
 * sizes are attacker-controlled, so declaration-only checks are insufficient. maxOutputLength is
 * a hard native zlib bound and this function is called inside the isolated parser worker.
 */
export function verifyDocxArchiveInflation(
  bytes: Uint8Array,
  limits: IngestLimits,
): ArchiveInspection {
  const parsed = readDocxArchive(bytes, limits)
  let actualXmlBytes = 0
  const relationshipParts = new Map<string, Uint8Array>()
  for (const entry of parsed.entries) {
    if (!isDocxParserXmlEntry(entry.name)) continue
    const remaining = limits.maxDocxXmlBytes - actualXmlBytes
    const compressed = Buffer.from(
      bytes.buffer,
      bytes.byteOffset + entry.dataOffset,
      entry.compressedBytes,
    )
    let actualData: Uint8Array
    if (entry.compressionMethod === 0) {
      actualData = compressed
    } else {
      try {
        const inflated = inflateRawSync(compressed, {
          maxOutputLength: Math.max(1, remaining + 1),
          info: true,
        }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } }
        if (inflated.engine.bytesWritten !== compressed.byteLength) {
          throw new IngestError(
            'ARCHIVE_INVALID',
            'A DOCX compressed XML part contains trailing bytes',
            { details: { entryName: entry.name.slice(0, 240) } },
          )
        }
        actualData = inflated.buffer
      } catch (error) {
        if (error instanceof IngestError) throw error
        if (isInflateOutputLimit(error)) {
          throw new IngestError(
            'EXTRACTED_TEXT_LIMIT_EXCEEDED',
            'The DOCX XML expands beyond the safe extraction limit',
            {
              details: {
                actualXmlBytesAtLeast: limits.maxDocxXmlBytes + 1,
                maxDocxXmlBytes: limits.maxDocxXmlBytes,
              },
            },
          )
        }
        throw new IngestError('ARCHIVE_INVALID', 'A DOCX XML part cannot be safely decompressed', {
          details: { entryName: entry.name.slice(0, 240) },
        })
      }
    }
    const actualBytes = actualData.byteLength
    actualXmlBytes = safeAdd(actualXmlBytes, actualBytes)
    if (actualXmlBytes > limits.maxDocxXmlBytes) {
      throw new IngestError(
        'EXTRACTED_TEXT_LIMIT_EXCEEDED',
        'The DOCX XML expands beyond the safe extraction limit',
        { details: { actualXmlBytes, maxDocxXmlBytes: limits.maxDocxXmlBytes } },
      )
    }
    if (actualBytes !== entry.uncompressedBytes) {
      throw new IngestError(
        'ARCHIVE_INVALID',
        'A DOCX XML part does not match its declared uncompressed size',
        {
          details: {
            entryName: entry.name.slice(0, 240),
            declaredBytes: entry.uncompressedBytes,
            actualBytes,
          },
        },
      )
    }
    if (crc32(actualData) !== entry.checksum) {
      throw new IngestError('ARCHIVE_INVALID', 'A DOCX XML part failed its CRC integrity check', {
        details: { entryName: entry.name.slice(0, 240) },
      })
    }
    if (entry.name.toLocaleLowerCase('en-US').endsWith('.rels')) {
      relationshipParts.set(entry.name, actualData)
    }
  }
  validateRelationshipTargets(relationshipParts, new Set(parsed.entries.map((entry) => entry.name)))
  return parsed.inspection
}

function validateRelationshipTargets(
  relationshipParts: ReadonlyMap<string, Uint8Array>,
  entryNames: ReadonlySet<string>,
): void {
  const rootRelationships = relationshipParts.get('_rels/.rels')
  if (rootRelationships === undefined) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX root relationship part is missing')
  }
  let officeDocumentTargets = 0
  for (const [relationshipPath, bytes] of relationshipParts) {
    if (bytes.byteLength > 256 * 1024) {
      throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'A DOCX relationship part is too large', {
        details: { entryName: relationshipPath, bytes: bytes.byteLength },
      })
    }
    const value = decodeXml(bytes, relationshipPath)
    for (const tag of scanRelationshipTags(value, relationshipPath)) {
      const type = readXmlAttribute(tag, 'Type')
      const target = readXmlAttribute(tag, 'Target')
      const targetMode = readXmlAttribute(tag, 'TargetMode')
      if (type === null || target === null) {
        throw new IngestError(
          'ARCHIVE_INVALID',
          'A DOCX relationship is missing its type or target',
        )
      }
      if (type.includes('&')) {
        throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship type is ambiguously encoded')
      }
      const typeName = type.slice(type.lastIndexOf('/') + 1)
      const isOfficeDocument = typeName === 'officeDocument'
      const isParserXmlRelationship = DOCX_PARSER_XML_RELATIONSHIPS.has(typeName)
      if (!isOfficeDocument && !isParserXmlRelationship) continue
      if (targetMode !== null && targetMode.toLocaleLowerCase('en-US') === 'external') {
        throw new IngestError(
          'ARCHIVE_INVALID',
          'A parser-relevant DOCX relationship cannot target an external resource',
        )
      }
      const resolvedTarget = resolveRelationshipTarget(relationshipPath, target)
      if (isOfficeDocument) {
        officeDocumentTargets += 1
        if (relationshipPath !== '_rels/.rels' || resolvedTarget !== 'word/document.xml') {
          throw new IngestError(
            'ARCHIVE_INVALID',
            'The DOCX main document must use the canonical local word/document.xml target',
          )
        }
      } else if (!resolvedTarget.toLocaleLowerCase('en-US').endsWith('.xml')) {
        throw new IngestError(
          'ARCHIVE_INVALID',
          'A parser-relevant DOCX relationship must target an XML part',
          { details: { relationshipType: typeName, target: resolvedTarget.slice(0, 240) } },
        )
      }
      if (!entryNames.has(resolvedTarget)) {
        throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship target is missing', {
          details: { target: resolvedTarget.slice(0, 240) },
        })
      }
    }
  }
  if (officeDocumentTargets !== 1) {
    throw new IngestError(
      'ARCHIVE_INVALID',
      'The DOCX must contain exactly one canonical office-document relationship',
    )
  }
}

const DOCX_PARSER_XML_RELATIONSHIPS = new Set([
  'comments',
  'endnotes',
  'fontTable',
  'footnotes',
  'glossaryDocument',
  'numbering',
  'settings',
  'styles',
  'theme',
  'webSettings',
])

function decodeXml(bytes: Uint8Array, entryName: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship part is not valid UTF-8', {
      details: { entryName },
    })
  }
}

function scanRelationshipTags(value: string, entryName: string): readonly string[] {
  const tags: string[] = []
  let cursor = 0
  while (cursor < value.length) {
    const tagStart = value.indexOf('<', cursor)
    if (tagStart < 0) break
    const tagEnd = value.indexOf('>', tagStart + 1)
    if (tagEnd < 0 || tagEnd - tagStart > 4_096) {
      throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship tag is malformed', {
        details: { entryName },
      })
    }
    const tag = value.slice(tagStart, tagEnd + 1)
    if (/^<(?:[A-Za-z_][\w.-]*:)?Relationship(?:\s|\/?>)/u.test(tag)) tags.push(tag)
    cursor = tagEnd + 1
  }
  return tags
}

function readXmlAttribute(tag: string, name: 'Target' | 'TargetMode' | 'Type'): string | null {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'gu')
  const matches = [...tag.matchAll(pattern)]
  if (matches.length > 1) {
    throw new IngestError('ARCHIVE_INVALID', `A DOCX relationship repeats ${name}`)
  }
  const match = matches[0]
  return match?.[1] ?? match?.[2] ?? null
}

function resolveRelationshipTarget(relationshipPath: string, target: string): string {
  if (
    target.length === 0 ||
    target.length > 1_024 ||
    target.includes('\\') ||
    target.includes(':') ||
    target.includes('?') ||
    target.includes('#') ||
    target.includes('&') ||
    target.includes('%')
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship target is unsafe')
  }
  const sourcePath = relationshipSourcePath(relationshipPath)
  const rootRelativeTarget = target.startsWith('/') ? target.slice(1) : target
  const targetBase = target.startsWith('/') ? '' : posix.dirname(sourcePath)
  const resolved = posix.normalize(posix.join(targetBase, rootRelativeTarget))
  if (
    resolved.length === 0 ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    resolved.startsWith('/')
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship escapes the archive root')
  }
  return resolved
}

function relationshipSourcePath(relationshipPath: string): string {
  if (relationshipPath === '_rels/.rels') return 'package.xml'
  const marker = '/_rels/'
  const markerIndex = relationshipPath.lastIndexOf(marker)
  if (markerIndex < 0 || !relationshipPath.endsWith('.rels')) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX relationship part has an invalid path')
  }
  return `${relationshipPath.slice(0, markerIndex)}/${relationshipPath.slice(
    markerIndex + marker.length,
    -'.rels'.length,
  )}`
}

function readDocxArchive(bytes: Uint8Array, limits: IngestLimits): ParsedDocxArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocdOffset = findEndOfCentralDirectory(view)
  const diskNumber = readUint16(view, eocdOffset + 4)
  const centralDirectoryDisk = readUint16(view, eocdOffset + 6)
  const entriesOnDisk = readUint16(view, eocdOffset + 8)
  const entryCount = readUint16(view, eocdOffset + 10)
  const centralDirectoryBytes = readUint32(view, eocdOffset + 12)
  const centralDirectoryOffset = readUint32(view, eocdOffset + 16)
  const commentBytes = readUint16(view, eocdOffset + 20)

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectoryBytes === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'Multi-disk and ZIP64 DOCX archives are not accepted')
  }
  if (eocdOffset + EOCD_FIXED_BYTES + commentBytes !== bytes.byteLength) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX end record is truncated or ambiguous')
  }
  if (entryCount > limits.maxArchiveEntries) {
    throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'The DOCX archive has too many entries', {
      details: { entryCount, maxArchiveEntries: limits.maxArchiveEntries },
    })
  }

  const centralDirectoryEnd = safeAdd(centralDirectoryOffset, centralDirectoryBytes)
  if (centralDirectoryEnd !== eocdOffset || centralDirectoryEnd > bytes.byteLength) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX central directory is outside the file')
  }

  const names: string[] = []
  const entries: DocxArchiveEntry[] = []
  const seenNames = new Set<string>()
  const seenLocalOffsets = new Set<number>()
  let containsMacros = false
  let compressedBytes = 0
  let uncompressedBytes = 0
  let declaredXmlBytes = 0
  let cursor = centralDirectoryOffset

  for (let index = 0; index < entryCount; index += 1) {
    requireRange(view, cursor, CENTRAL_FILE_FIXED_BYTES)
    if (readUint32(view, cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new IngestError('ARCHIVE_INVALID', 'The DOCX central directory is malformed')
    }

    const flags = readUint16(view, cursor + 8)
    const compressionMethod = readUint16(view, cursor + 10)
    const checksum = readUint32(view, cursor + 16)
    const entryCompressedBytes = readUint32(view, cursor + 20)
    const entryUncompressedBytes = readUint32(view, cursor + 24)
    const nameBytes = readUint16(view, cursor + 28)
    const extraBytes = readUint16(view, cursor + 30)
    const entryCommentBytes = readUint16(view, cursor + 32)
    const startDisk = readUint16(view, cursor + 34)
    const externalAttributes = readUint32(view, cursor + 38)
    const localHeaderOffset = readUint32(view, cursor + 42)

    if (
      entryCompressedBytes === 0xffffffff ||
      entryUncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      startDisk !== 0
    ) {
      throw new IngestError('ARCHIVE_INVALID', 'ZIP64 and split DOCX entries are not accepted')
    }
    if ((flags & 0x0001) !== 0) {
      throw new IngestError(
        'ENCRYPTED_DOCUMENT_REJECTED',
        'Encrypted DOCX entries are not accepted',
      )
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new IngestError('ARCHIVE_INVALID', 'The DOCX uses an unsupported compression method', {
        details: { compressionMethod },
      })
    }
    if (isUnixSymlink(externalAttributes)) {
      throw new IngestError('ARCHIVE_UNSAFE_PATH', 'Symbolic links are not accepted in DOCX files')
    }
    if (seenLocalOffsets.has(localHeaderOffset)) {
      throw new IngestError('ARCHIVE_INVALID', 'DOCX entries share a local header offset')
    }
    seenLocalOffsets.add(localHeaderOffset)

    const variableBytes = safeAdd(nameBytes, safeAdd(extraBytes, entryCommentBytes))
    requireRange(view, cursor + CENTRAL_FILE_FIXED_BYTES, variableBytes)
    const name = decodeEntryName(
      bytes.subarray(
        cursor + CENTRAL_FILE_FIXED_BYTES,
        cursor + CENTRAL_FILE_FIXED_BYTES + nameBytes,
      ),
    )
    validateEntryName(name)
    if (seenNames.has(name)) {
      throw new IngestError('ARCHIVE_INVALID', 'Duplicate DOCX archive entries are rejected', {
        details: { entryName: name },
      })
    }
    seenNames.add(name)
    names.push(name)
    containsMacros ||= /(^|\/)vbaproject\.bin$/iu.test(name)

    const local = validateLocalHeader(
      view,
      bytes,
      localHeaderOffset,
      name,
      flags,
      compressionMethod,
      checksum,
      entryCompressedBytes,
      entryUncompressedBytes,
      centralDirectoryOffset,
    )
    entries.push({
      name,
      flags,
      compressionMethod,
      checksum,
      compressedBytes: entryCompressedBytes,
      uncompressedBytes: entryUncompressedBytes,
      localHeaderOffset,
      dataOffset: local.dataOffset,
      usesDataDescriptor: local.usesDataDescriptor,
    })
    compressedBytes = safeAdd(compressedBytes, entryCompressedBytes)
    uncompressedBytes = safeAdd(uncompressedBytes, entryUncompressedBytes)
    if (isDocxParserXmlEntry(name)) {
      declaredXmlBytes = safeAdd(declaredXmlBytes, entryUncompressedBytes)
      if (declaredXmlBytes > limits.maxDocxXmlBytes) {
        throw new IngestError(
          'EXTRACTED_TEXT_LIMIT_EXCEEDED',
          'The declared DOCX XML expands beyond the safe extraction limit',
          {
            details: {
              declaredXmlBytes,
              maxDocxXmlBytes: limits.maxDocxXmlBytes,
            },
          },
        )
      }
    }
    enforceEntryLimits(entryCompressedBytes, entryUncompressedBytes, limits, name)
    cursor = safeAdd(cursor, safeAdd(CENTRAL_FILE_FIXED_BYTES, variableBytes))
  }

  if (cursor !== centralDirectoryEnd) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX central directory length is inconsistent')
  }
  if (!seenNames.has('[Content_Types].xml') || !seenNames.has('word/document.xml')) {
    throw new IngestError('ARCHIVE_INVALID', 'The ZIP file is not a valid DOCX document')
  }
  enforceTotalLimits(compressedBytes, uncompressedBytes, limits)
  validateLocalEntryLayout(view, entries, centralDirectoryOffset)

  return {
    inspection: {
      entryCount,
      compressedBytes,
      uncompressedBytes,
      entryNames: names,
      containsMacros,
    },
    entries,
  }
}

function validateLocalHeader(
  view: DataView,
  bytes: Uint8Array,
  offset: number,
  expectedName: string,
  expectedFlags: number,
  expectedCompressionMethod: 0 | 8,
  expectedChecksum: number,
  compressedBytes: number,
  uncompressedBytes: number,
  centralDirectoryOffset: number,
): { dataOffset: number; usesDataDescriptor: boolean } {
  requireRange(view, offset, LOCAL_FILE_FIXED_BYTES)
  if (readUint32(view, offset) !== LOCAL_FILE_SIGNATURE) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX local file header is missing')
  }
  const flags = readUint16(view, offset + 6)
  const compressionMethod = readUint16(view, offset + 8)
  const localChecksum = readUint32(view, offset + 14)
  const localCompressedBytes = readUint32(view, offset + 18)
  const localUncompressedBytes = readUint32(view, offset + 22)
  const nameBytes = readUint16(view, offset + 26)
  const extraBytes = readUint16(view, offset + 28)
  const usesDataDescriptor = (flags & 0x0008) !== 0
  if (
    flags !== expectedFlags ||
    compressionMethod !== expectedCompressionMethod ||
    (!usesDataDescriptor &&
      (localChecksum !== expectedChecksum ||
        localCompressedBytes !== compressedBytes ||
        localUncompressedBytes !== uncompressedBytes))
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'DOCX local and central entry metadata differ')
  }
  requireRange(view, offset + LOCAL_FILE_FIXED_BYTES, safeAdd(nameBytes, extraBytes))
  const localName = decodeEntryName(
    bytes.subarray(offset + LOCAL_FILE_FIXED_BYTES, offset + LOCAL_FILE_FIXED_BYTES + nameBytes),
  )
  if (localName !== expectedName) {
    throw new IngestError('ARCHIVE_INVALID', 'DOCX local and central entry names differ')
  }
  const dataOffset = safeAdd(offset + LOCAL_FILE_FIXED_BYTES, safeAdd(nameBytes, extraBytes))
  requireRange(view, dataOffset, compressedBytes)
  if (safeAdd(dataOffset, compressedBytes) > centralDirectoryOffset) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX entry overlaps its central directory')
  }
  return { dataOffset, usesDataDescriptor }
}

function validateLocalEntryLayout(
  view: DataView,
  entries: readonly DocxArchiveEntry[],
  centralDirectoryOffset: number,
): void {
  const ordered = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  )
  if (ordered[0]?.localHeaderOffset !== 0) {
    throw new IngestError('ARCHIVE_INVALID', 'DOCX local entries must begin at byte zero')
  }
  for (const [index, entry] of ordered.entries()) {
    const compressedEnd = safeAdd(entry.dataOffset, entry.compressedBytes)
    const nextOffset = ordered[index + 1]?.localHeaderOffset ?? centralDirectoryOffset
    if (entry.usesDataDescriptor) {
      validateDataDescriptor(view, compressedEnd, nextOffset, entry)
    } else if (compressedEnd !== nextOffset) {
      throw new IngestError(
        'ARCHIVE_INVALID',
        'A DOCX entry has undeclared bytes outside its compressed payload',
        { details: { entryName: entry.name.slice(0, 240) } },
      )
    }
  }
}

function validateDataDescriptor(
  view: DataView,
  descriptorOffset: number,
  nextOffset: number,
  entry: DocxArchiveEntry,
): void {
  const descriptorBytes = nextOffset - descriptorOffset
  const hasSignature = descriptorBytes === 16
  if (descriptorBytes !== 12 && !hasSignature) {
    throw new IngestError('ARCHIVE_INVALID', 'A DOCX data descriptor has an invalid length')
  }
  let cursor = descriptorOffset
  if (hasSignature) {
    if (readUint32(view, cursor) !== DATA_DESCRIPTOR_SIGNATURE) {
      throw new IngestError('ARCHIVE_INVALID', 'A DOCX data descriptor signature is invalid')
    }
    cursor += 4
  }
  if (
    readUint32(view, cursor) !== entry.checksum ||
    readUint32(view, cursor + 4) !== entry.compressedBytes ||
    readUint32(view, cursor + 8) !== entry.uncompressedBytes
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'DOCX data descriptor metadata is inconsistent')
  }
}

function isDocxParserXmlEntry(name: string): boolean {
  const normalized = name.toLocaleLowerCase('en-US')
  return normalized.endsWith('.xml') || normalized.endsWith('.rels')
}

function isInflateOutputLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as Error & { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ||
      /buffer larger|maxoutputlength/iu.test(error.message))
  )
}

function findEndOfCentralDirectory(view: DataView): number {
  const earliestOffset = Math.max(0, view.byteLength - EOCD_FIXED_BYTES - MAX_ZIP_COMMENT_BYTES)
  for (let offset = view.byteLength - EOCD_FIXED_BYTES; offset >= earliestOffset; offset -= 1) {
    if (readUint32(view, offset) === EOCD_SIGNATURE) return offset
  }
  throw new IngestError('ARCHIVE_INVALID', 'The DOCX central directory was not found')
}

function validateEntryName(name: string): void {
  const segments = name.split('/')
  if (
    name.length === 0 ||
    name.length > 1_024 ||
    name.startsWith('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    segments.includes('..') ||
    segments.includes('.') ||
    segments.some((segment) => hasControlCharacter(segment))
  ) {
    throw new IngestError('ARCHIVE_UNSAFE_PATH', 'The DOCX contains an unsafe archive path', {
      details: { entryName: name.slice(0, 240) },
    })
  }
}

function enforceEntryLimits(
  compressedBytes: number,
  uncompressedBytes: number,
  limits: IngestLimits,
  name: string,
): void {
  if (uncompressedBytes > limits.maxArchiveUncompressedBytes) {
    throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'A DOCX entry is too large', {
      details: { entryName: name.slice(0, 240), uncompressedBytes },
    })
  }
  const ratio = compressionRatio(compressedBytes, uncompressedBytes)
  if (ratio > limits.maxCompressionRatio) {
    throw new IngestError(
      'ARCHIVE_BOMB_SUSPECTED',
      'A DOCX entry has an unsafe compression ratio',
      {
        details: { entryName: name.slice(0, 240), compressionRatio: ratioDetail(ratio) },
      },
    )
  }
}

function enforceTotalLimits(
  compressedBytes: number,
  uncompressedBytes: number,
  limits: IngestLimits,
): void {
  if (uncompressedBytes > limits.maxArchiveUncompressedBytes) {
    throw new IngestError('ARCHIVE_LIMIT_EXCEEDED', 'The DOCX expands beyond the safe limit', {
      details: { uncompressedBytes, maxBytes: limits.maxArchiveUncompressedBytes },
    })
  }
  const ratio = compressionRatio(compressedBytes, uncompressedBytes)
  if (ratio > limits.maxCompressionRatio) {
    throw new IngestError('ARCHIVE_BOMB_SUSPECTED', 'The DOCX compression ratio is unsafe', {
      details: { compressionRatio: ratioDetail(ratio) },
    })
  }
}

function compressionRatio(compressedBytes: number, uncompressedBytes: number): number {
  if (compressedBytes === 0) return uncompressedBytes === 0 ? 1 : Number.POSITIVE_INFINITY
  return uncompressedBytes / compressedBytes
}

function ratioDetail(ratio: number): number | string {
  return Number.isFinite(ratio) ? ratio : 'infinite'
}

function decodeEntryName(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  } catch {
    throw new IngestError('ARCHIVE_INVALID', 'DOCX entry names must be valid UTF-8')
  }
}

function isUnixSymlink(externalAttributes: number): boolean {
  const unixMode = Math.floor(externalAttributes / 65_536) & 0xffff
  return (unixMode & 0xf000) === 0xa000
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
  })
}

function readUint16(view: DataView, offset: number): number {
  requireRange(view, offset, 2)
  return view.getUint16(offset, true)
}

function readUint32(view: DataView, offset: number): number {
  requireRange(view, offset, 4)
  return view.getUint32(offset, true)
}

function requireRange(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > view.byteLength ||
    length > view.byteLength - offset
  ) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX archive contains an invalid byte range')
  }
}

function safeAdd(left: number, right: number): number {
  const value = left + right
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IngestError('ARCHIVE_INVALID', 'The DOCX archive contains an unsafe size value')
  }
  return value
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff
  for (const byte of bytes) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (0xedb88320 & -(checksum & 1))
    }
  }
  return (checksum ^ 0xffffffff) >>> 0
}
