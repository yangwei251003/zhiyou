import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { TextDecoder } from 'node:util'

import { MAX_RPC_LINE_BYTES } from './limits.js'
import { AiProviderError } from './types.js'

interface JsonRpcSuccess {
  jsonrpc?: '2.0'
  id: string | number
  result: unknown
}

interface JsonRpcFailure {
  jsonrpc?: '2.0'
  id: string | number
  error: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: string | number
}

type JsonRpcMessage = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification | JsonRpcServerRequest

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

export interface RpcNotification {
  method: string
  params: unknown
}

/**
 * Minimal JSON-lines peer for Codex App Server. It deliberately rejects every
 * server-initiated request so uploaded content can never escalate into a tool action.
 */
export class JsonLinesRpcPeer {
  readonly notifications = new EventEmitter()
  private readonly pending = new Map<string | number, PendingRequest>()
  private sequence = 0
  private closed = false
  private writeTail: Promise<void> = Promise.resolve()
  private inputChunks: Buffer[] = []
  private inputLength = 0

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly timeoutMs = 30_000,
    private readonly onFatal?: (error: AiProviderError) => void,
  ) {
    input.on('data', (chunk: Buffer | string) => this.onData(chunk))
    input.on('error', () => {
      this.failTransport(new AiProviderError('OFFLINE', 'Codex App Server read channel failed'))
    })
    input.on('end', () => {
      if (!this.closed && this.inputLength > 0) this.consumeBufferedLine()
      this.failTransport(new AiProviderError('OFFLINE', 'Codex App Server closed'))
    })
    input.on('close', () => {
      this.failTransport(new AiProviderError('OFFLINE', 'Codex App Server closed'))
    })
    output.on('error', () => {
      this.failTransport(new AiProviderError('OFFLINE', 'Codex App Server write channel failed'))
    })
    input.resume()
  }

  isClosed(): boolean {
    return this.closed
  }

  terminate(reason: AiProviderError): void {
    this.failTransport(reason)
  }

  async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new AiProviderError('OFFLINE', 'Codex App Server is not connected')
    const id = `${++this.sequence}:${randomUUID()}`
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout: null,
      })
    })
    try {
      await this.enqueueLine(`${JSON.stringify(payload)}\n`)
      const pending = this.pending.get(id)
      if (pending !== undefined && pending.timeout === null) {
        pending.timeout = setTimeout(() => {
          this.failTransport(
            new AiProviderError(
              'OUTCOME_UNKNOWN',
              `Codex request outcome is unknown after timeout: ${method}`,
            ),
          )
        }, this.timeoutMs)
      }
    } catch (cause) {
      const pending = this.pending.get(id)
      if (pending !== undefined) {
        this.pending.delete(id)
        pending.reject(
          cause instanceof AiProviderError
            ? cause
            : new AiProviderError('OFFLINE', 'Codex App Server write failed'),
        )
      }
    }
    return response
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) throw new AiProviderError('OFFLINE', 'Codex App Server is not connected')
    const payload = { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }
    await this.enqueueLine(`${JSON.stringify(payload)}\n`)
  }

  close(reason: Error = new AiProviderError('OFFLINE', 'Codex connection closed')): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      if (pending.timeout !== null) clearTimeout(pending.timeout)
      pending.reject(reason)
    }
    this.pending.clear()
  }

  private onData(chunk: Buffer | string): void {
    if (this.closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    let offset = 0
    while (offset < bytes.length && !this.closed) {
      const newline = bytes.indexOf(0x0a, offset)
      const end = newline === -1 ? bytes.length : newline
      const piece = bytes.subarray(offset, end)
      if (this.inputLength + piece.length > MAX_RPC_LINE_BYTES) {
        this.rejectOversizedLine(this.inputLength + piece.length)
        return
      }
      if (piece.length > 0) {
        this.inputChunks.push(Buffer.from(piece))
        this.inputLength += piece.length
      }
      if (newline === -1) return
      this.consumeBufferedLine()
      offset = newline + 1
    }
  }

  private consumeBufferedLine(): void {
    const line =
      this.inputChunks.length === 1
        ? this.inputChunks[0]!
        : Buffer.concat(this.inputChunks, this.inputLength)
    this.inputChunks = []
    this.inputLength = 0
    this.consumeLine(line)
  }

  private consumeLine(lineBytes: Buffer): void {
    const normalized =
      lineBytes.at(-1) === 0x0d ? lineBytes.subarray(0, lineBytes.length - 1) : lineBytes
    let line: string
    try {
      line = new TextDecoder('utf-8', { fatal: true }).decode(normalized)
    } catch {
      this.rejectInvalidLine(normalized.length)
      return
    }
    this.onLine(line)
  }

  private rejectOversizedLine(lineLength: number): void {
    this.emitNotification({
      method: 'protocol/invalidJson',
      params: { lineLength },
    })
    this.failTransport(
      new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex sent an oversized protocol message'),
    )
  }

  private rejectInvalidLine(lineLength: number): void {
    this.emitNotification({
      method: 'protocol/invalidJson',
      params: { lineLength },
    })
    this.failTransport(
      new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex sent an invalid protocol message'),
    )
  }

  private onLine(line: string): void {
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
      this.rejectOversizedLine(Buffer.byteLength(line, 'utf8'))
      return
    }
    const message = parseJsonRpcMessage(line)
    if (message === null) {
      this.rejectInvalidLine(Buffer.byteLength(line, 'utf8'))
      return
    }

    if (isServerRequest(message)) {
      this.rejectServerRequest(message)
      return
    }

    if (isResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      if (pending.timeout !== null) clearTimeout(pending.timeout)
      this.pending.delete(message.id)
      if ('error' in message) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
      return
    }

    this.emitNotification({
      method: message.method,
      params: message.params,
    })
  }

  private rejectServerRequest(message: JsonRpcServerRequest): void {
    void this.enqueueLine(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32_001,
          message: 'BossHunter does not grant Codex tool or approval requests',
        },
      })}\n`,
    ).catch(() => {
      this.failTransport(new AiProviderError('OFFLINE', 'Codex App Server write failed'))
    })
    this.emitNotification({
      method: 'security/serverRequestRejected',
      params: { method: message.method },
    })
  }

  private emitNotification(notification: RpcNotification): void {
    try {
      this.notifications.emit('notification', notification)
    } catch {
      this.failTransport(
        new AiProviderError('INTERNAL', 'Codex notification handling failed safely'),
      )
    }
  }

  private enqueueLine(line: string): Promise<void> {
    if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
      return Promise.reject(
        new AiProviderError(
          'PAYLOAD_TOO_LARGE',
          'Codex protocol message exceeds the fixed transport budget',
        ),
      )
    }
    const operation = this.writeTail.then(() => this.writeLine(line))
    this.writeTail = operation.catch(() => undefined)
    return operation
  }

  private writeLine(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new AiProviderError('OFFLINE', 'Codex App Server is not connected'))
        return
      }
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        this.output.off('error', onError)
        if (error === undefined) resolve()
        else reject(error)
      }
      const onError = (): void => {
        const error = new AiProviderError('OFFLINE', 'Codex App Server write failed')
        finish(error)
        this.failTransport(error)
      }
      this.output.once('error', onError)
      timer = setTimeout(() => {
        const error = new AiProviderError('OUTCOME_UNKNOWN', 'Codex App Server write timed out')
        finish(error)
        this.failTransport(error)
      }, this.timeoutMs)
      try {
        this.output.write(line, (error) => {
          if (error) {
            const providerError = new AiProviderError('OFFLINE', 'Codex App Server write failed')
            finish(providerError)
            this.failTransport(providerError)
          } else finish()
        })
      } catch {
        const error = new AiProviderError('OFFLINE', 'Codex App Server write failed')
        finish(error)
        this.failTransport(error)
      }
    })
  }

  private failTransport(error: AiProviderError): void {
    if (this.closed) return
    this.close(error)
    this.input.destroy()
    this.output.destroy()
    try {
      this.onFatal?.(error)
    } catch {
      // A transport failure is already terminal; callback diagnostics must not escape an event.
    }
  }
}

function parseJsonRpcMessage(line: string): JsonRpcMessage | null {
  let value: unknown
  try {
    value = JSON.parse(line) as unknown
  } catch {
    return null
  }
  if (!isRecord(value) || (value['jsonrpc'] !== undefined && value['jsonrpc'] !== '2.0')) {
    return null
  }
  const hasId = hasOwn(value, 'id')
  const id = value['id']
  const method = value['method']
  if (typeof method === 'string' && method.length > 0) {
    if (!hasId) return { jsonrpc: '2.0', method, params: value['params'] }
    if (!isRpcId(id)) return null
    return { jsonrpc: '2.0', id, method, params: value['params'] }
  }
  if (!hasId || !isRpcId(id)) return null
  const hasResult = hasOwn(value, 'result')
  const hasError = hasOwn(value, 'error')
  if (hasResult === hasError) return null
  if (hasResult) return { jsonrpc: '2.0', id, result: value['result'] }
  const error = value['error']
  if (
    !isRecord(error) ||
    typeof error['code'] !== 'number' ||
    !Number.isInteger(error['code']) ||
    typeof error['message'] !== 'string'
  ) {
    return null
  }
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: error['code'],
      message: error['message'],
      ...(hasOwn(error, 'data') ? { data: error['data'] } : {}),
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isRpcId(value: unknown): value is string | number {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
}

function isServerRequest(message: JsonRpcMessage): message is JsonRpcServerRequest {
  return 'method' in message && 'id' in message
}

function isResponse(message: JsonRpcMessage): message is JsonRpcSuccess | JsonRpcFailure {
  return 'id' in message && !('method' in message)
}

export interface CodexRpcTransport {
  request<T>(method: string, params?: unknown): Promise<T>
  notifications?: EventEmitter
}
