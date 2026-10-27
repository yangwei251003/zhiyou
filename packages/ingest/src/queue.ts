import { randomUUID } from 'node:crypto'

import { IngestError, serializeIngestError, toIngestError } from './errors.js'
import { assertParserOutput, ParserRegistry } from './parsers.js'
import { mergeIngestLimits, validateIngestInput } from './security.js'
import type {
  IngestInput,
  IngestJobStatus,
  IngestOptions,
  IngestRun,
  IngestStateEvent,
  ParsedDocument,
} from './types.js'

const ALLOWED_TRANSITIONS: Readonly<Record<IngestJobStatus, readonly IngestJobStatus[]>> = {
  queued: ['validating'],
  validating: ['parsing', 'failed'],
  parsing: ['completed', 'needs_ocr', 'failed'],
  needs_ocr: [],
  completed: [],
  failed: [],
}

export async function ingestDocument(
  input: IngestInput,
  options: IngestOptions = {},
): Promise<IngestRun> {
  const jobId = options.jobId ?? randomUUID()
  const now = options.now ?? (() => new Date())
  const limits = mergeIngestLimits(options.limits)
  const registry = options.registry ?? new ParserRegistry()
  const history: IngestStateEvent[] = []

  appendState(history, { status: 'queued', at: now().toISOString() }, options)
  appendState(history, { status: 'validating', at: now().toISOString() }, options)

  try {
    const validated = validateIngestInput(input, limits)
    const parser = registry.get(validated.kind)
    appendState(
      history,
      { status: 'parsing', at: now().toISOString(), parserId: parser.id },
      options,
    )
    const parsedDocument: ParsedDocument = await parser.parse({ input: validated, limits })
    assertParserOutput(parsedDocument, validated, parser, limits)
    appendState(
      history,
      { status: 'completed', at: now().toISOString(), parserId: parser.id },
      options,
    )
    return { jobId, status: 'completed', document: parsedDocument, history: [...history] }
  } catch (cause) {
    const error = toIngestError(cause)
    const status = error.code === 'OCR_REQUIRED' ? 'needs_ocr' : 'failed'
    appendState(
      history,
      { status, at: now().toISOString(), error: serializeIngestError(error) },
      options,
    )
    return { jobId, status, error: serializeIngestError(error), history: [...history] }
  }
}

export function assertIngestTransition(previous: IngestJobStatus, next: IngestJobStatus): void {
  if (!ALLOWED_TRANSITIONS[previous].includes(next)) {
    throw new IngestError(
      'INVALID_TRANSITION',
      `Cannot transition ingestion from ${previous} to ${next}`,
      { details: { previous, next } },
    )
  }
}

function appendState(
  history: IngestStateEvent[],
  event: IngestStateEvent,
  options: IngestOptions,
): void {
  const previous = history.at(-1)
  if (previous !== undefined) assertIngestTransition(previous.status, event.status)
  options.onStateChange?.(event)
  history.push(event)
}
