import { deflateRawSync } from 'node:zlib'

interface ZipEntry {
  name: string
  data: Uint8Array
  compression?: 'store' | 'deflate'
  declaredChecksum?: number
  declaredCompressedBytes?: number
  declaredUncompressedBytes?: number
  trailingCompressedData?: Uint8Array
}

interface MinimalDocxOptions {
  relationshipTarget?: string
}

const encode = (value: string): Uint8Array => new TextEncoder().encode(value)

export function createMinimalPdf(text: string | null): Uint8Array {
  const contentStream =
    text === null
      ? '0 0 120 40 re f\n'
      : `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfString(text)}) Tj\nET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${encode(contentStream).byteLength} >>\nstream\n${contentStream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) {
    offsets.push(encode(body).byteLength)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = encode(body).byteLength
  body += `xref\n0 ${objects.length + 1}\n`
  body += '0000000000 65535 f \n'
  for (const offset of offsets.slice(1)) {
    body += `${offset.toString().padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  body += `startxref\n${xrefOffset}\n%%EOF\n`
  return encode(body)
}

export function createMinimalDocx(
  text = 'DOCX 中的真实项目证据',
  additionalEntries: readonly ZipEntry[] = [],
  options: MinimalDocxOptions = {},
): Uint8Array {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="${options.relationshipTarget ?? 'word/document.xml'}"/>
</Relationships>`
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`

  return createZip([
    { name: '[Content_Types].xml', data: encode(contentTypes) },
    { name: '_rels/.rels', data: encode(relationships) },
    { name: 'word/document.xml', data: encode(document) },
    ...additionalEntries,
  ])
}

function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let localOffset = 0

  for (const entry of entries) {
    const name = encode(entry.name)
    const checksum = entry.declaredChecksum ?? crc32(entry.data)
    const compressionMethod = entry.compression === 'deflate' ? 8 : 0
    const encodedData =
      compressionMethod === 8 ? Uint8Array.from(deflateRawSync(entry.data)) : entry.data
    const compressedData = entry.trailingCompressedData
      ? concatBytes([encodedData, entry.trailingCompressedData])
      : encodedData
    const compressedBytes = entry.declaredCompressedBytes ?? compressedData.byteLength
    const uncompressedBytes = entry.declaredUncompressedBytes ?? entry.data.byteLength
    const localHeader = new Uint8Array(30)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, compressionMethod, true)
    localView.setUint32(14, checksum, true)
    localView.setUint32(18, compressedBytes, true)
    localView.setUint32(22, uncompressedBytes, true)
    localView.setUint16(26, name.byteLength, true)
    const localPart = concatBytes([localHeader, name, compressedData])
    localParts.push(localPart)

    const centralHeader = new Uint8Array(46)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, compressionMethod, true)
    centralView.setUint32(16, checksum, true)
    centralView.setUint32(20, compressedBytes, true)
    centralView.setUint32(24, uncompressedBytes, true)
    centralView.setUint16(28, name.byteLength, true)
    centralView.setUint32(42, localOffset, true)
    centralParts.push(concatBytes([centralHeader, name]))
    localOffset += localPart.byteLength
  }

  const centralDirectory = concatBytes(centralParts)
  const endRecord = new Uint8Array(22)
  const endView = new DataView(endRecord.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralDirectory.byteLength, true)
  endView.setUint32(16, localOffset, true)
  return concatBytes([...localParts, centralDirectory, endRecord])
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
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

function escapePdfString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
