import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertWorkerResponse,
  createParseWorkerRequest,
  IngestError,
  mergeIngestLimits,
  validateIngestInput,
  type IngestInput,
  type IngestLimits,
  type ParsedDocument,
} from '@bosshunter/ingest'
import type { UtilityProcess } from 'electron'

export const INGEST_WORKER_TIMEOUT_MS = 15_000
export const INGEST_WORKER_TERMINATION_TIMEOUT_MS = 5_000
export const INGEST_WORKER_MAX_OLD_GENERATION_MB = 192

export interface IngestWorkerClientOptions {
  readonly limits?: Partial<IngestLimits>
  readonly timeoutMs?: number
  readonly terminationTimeoutMs?: number
  readonly requestId?: string
  readonly processFactory?: (moduleUrl: URL) => Promise<UtilityProcess> | UtilityProcess
}

type WorkerOutcome =
  | { readonly kind: 'resolve'; readonly document: ParsedDocument }
  | { readonly kind: 'reject'; readonly error: IngestError }

export class IngestWorkerExecutor {
  #tail: Promise<void> = Promise.resolve()
  #poisoned: IngestError | null = null

  parse(input: IngestInput, options: IngestWorkerClientOptions = {}): Promise<ParsedDocument> {
    const execution = this.#tail.then(() => this.#execute(input, options))
    this.#tail = execution.then(
      () => undefined,
      () => undefined,
    )
    return execution
  }

  async #execute(input: IngestInput, options: IngestWorkerClientOptions): Promise<ParsedDocument> {
    if (this.#poisoned !== null) throw this.#poisoned
    const timeoutMs = positiveTimeout(options.timeoutMs, INGEST_WORKER_TIMEOUT_MS)
    const terminationTimeoutMs = positiveTimeout(
      options.terminationTimeoutMs,
      INGEST_WORKER_TERMINATION_TIMEOUT_MS,
    )
    const limits = mergeIngestLimits(options.limits)
    const validated = validateIngestInput(input, limits)
    const requestId = options.requestId ?? randomUUID()
    const { request } = createParseWorkerRequest(requestId, validated, limits)
    const moduleUrl = new URL('./ingestWorker.js', import.meta.url)
    let child: UtilityProcess
    try {
      child = await (options.processFactory?.(moduleUrl) ?? createUtilityProcess(moduleUrl))
    } catch {
      throw new IngestError('PARSE_FAILED', 'The isolated parser process could not start', {
        retryable: true,
      })
    }

    return new Promise((resolve, reject) => {
      let phase: 'starting' | 'running' | 'terminating' | 'settled' =
        options.processFactory === undefined ? 'starting' : 'running'
      let outcome: WorkerOutcome | null = null
      let terminationTimer: ReturnType<typeof setTimeout> | undefined

      const cleanup = (): void => {
        clearTimeout(parseTimer)
        if (terminationTimer !== undefined) clearTimeout(terminationTimer)
        child.off('spawn', onSpawn)
        child.off('message', onMessage)
        child.off('error', onFatalError)
        child.off('exit', onExit)
      }
      const settle = (result: WorkerOutcome): void => {
        phase = 'settled'
        cleanup()
        if (result.kind === 'resolve') resolve(result.document)
        else reject(result.error)
      }
      const poison = (): void => {
        phase = 'settled'
        cleanup()
        reject(this.#poison())
      }
      const beginTermination = (result: WorkerOutcome): void => {
        if (phase === 'terminating' || phase === 'settled') return
        phase = 'terminating'
        outcome = result
        clearTimeout(parseTimer)
        // Arm the confirmation timeout before kill(): a test double or a platform implementation
        // may emit `exit` synchronously from kill(). onExit then clears this already-created timer.
        terminationTimer = setTimeout(poison, terminationTimeoutMs)
        try {
          child.kill()
        } catch {
          // Exit confirmation, not kill()'s return value, is authoritative.
        }
      }
      const sendRequest = (): void => {
        if (phase === 'terminating' || phase === 'settled') return
        phase = 'running'
        try {
          child.postMessage(request)
        } catch {
          beginTermination({
            kind: 'reject',
            error: new IngestError(
              'INVALID_WORKER_MESSAGE',
              'The parser request could not be transferred',
            ),
          })
        }
      }
      const onSpawn = (): void => sendRequest()
      const onMessage = (value: unknown): void => {
        if (phase !== 'running') return
        try {
          assertWorkerResponse(value, requestId)
          if (value.type === 'parse_failed') {
            beginTermination({
              kind: 'reject',
              error: new IngestError(value.error.code, value.error.message, {
                retryable: value.error.retryable,
                details: value.error.details,
              }),
            })
            return
          }
          beginTermination({ kind: 'resolve', document: value.document })
        } catch (error) {
          beginTermination({
            kind: 'reject',
            error:
              error instanceof IngestError
                ? error
                : new IngestError(
                    'INVALID_WORKER_MESSAGE',
                    'The parser process response was invalid',
                  ),
          })
        }
      }
      const onFatalError = (): void => {
        const failure: WorkerOutcome = {
          kind: 'reject',
          error: new IngestError(
            'RESOURCE_LIMIT_EXCEEDED',
            'The isolated parser process encountered a fatal resource failure',
          ),
        }
        if (phase === 'settled') return
        if (phase === 'terminating') {
          // A success envelope is not authoritative until the child has exited cleanly enough to
          // be reaped. A fatal process event observed first must win over the provisional result.
          outcome = failure
          return
        }
        beginTermination(failure)
      }
      const onExit = (exitCode: number): void => {
        if (phase === 'settled') return
        if (phase === 'terminating' && outcome !== null) {
          settle(outcome)
          return
        }
        settle({
          kind: 'reject',
          error: new IngestError(
            exitCode === 0 ? 'PARSE_FAILED' : 'RESOURCE_LIMIT_EXCEEDED',
            exitCode === 0
              ? 'The parser process exited before returning a result'
              : 'The parser process was terminated by a resource limit',
            { details: { exitCode } },
          ),
        })
      }
      const parseTimer = setTimeout(() => {
        beginTermination({
          kind: 'reject',
          error: new IngestError('PARSE_TIMEOUT', 'The isolated parser exceeded its time limit'),
        })
      }, timeoutMs)

      child.once('spawn', onSpawn)
      child.once('message', onMessage)
      child.once('error', onFatalError)
      child.once('exit', onExit)
      if (options.processFactory !== undefined) sendRequest()
    })
  }

  #poison(): IngestError {
    this.#poisoned ??= new IngestError(
      'RESOURCE_LIMIT_EXCEEDED',
      'The previous parser process could not be confirmed stopped; parsing is locked for this run',
    )
    return this.#poisoned
  }
}

const defaultIngestWorkerExecutor = new IngestWorkerExecutor()

export function parseDocumentInWorker(
  input: IngestInput,
  options: IngestWorkerClientOptions = {},
): Promise<ParsedDocument> {
  return defaultIngestWorkerExecutor.parse(input, options)
}

async function createUtilityProcess(moduleUrl: URL): Promise<UtilityProcess> {
  const { utilityProcess } = await import('electron')
  const modulePath = fileURLToPath(moduleUrl)
  return utilityProcess.fork(modulePath, [], {
    cwd: dirname(modulePath),
    env: {},
    execArgv: [`--max-old-space-size=${INGEST_WORKER_MAX_OLD_GENERATION_MB}`],
    serviceName: 'BossHunter document parser',
    stdio: 'ignore',
  })
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new IngestError('PARSE_FAILED', 'Parser process timeouts must be positive')
  }
  return timeout
}
