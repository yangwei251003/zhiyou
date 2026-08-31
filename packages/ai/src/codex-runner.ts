import { mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { JsonLinesRpcPeer, RpcNotification } from './codex-rpc.js'
import type { StructuredCodexRunner } from './provider.js'
import { AiProviderError } from './types.js'

interface ThreadStartResponse {
  thread: { id: string }
  model: string
}

interface TurnStartResponse {
  turn: TurnRecord
}

interface TurnRecord {
  id: string
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress'
  error: { message?: string } | null
  items: unknown[]
}

interface ItemEnvelope {
  threadId: string
  turnId: string
  item: unknown
}

interface TurnEnvelope {
  threadId: string
  turn: TurnRecord
}

const SAFE_ITEM_TYPES = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan'])
const TURN_STATUSES = new Set<TurnRecord['status']>([
  'completed',
  'interrupted',
  'failed',
  'inProgress',
])
const MAX_BUFFERED_NOTIFICATIONS = 1_000

export class CodexAppServerRunner implements StructuredCodexRunner {
  constructor(
    private readonly connect: () => Promise<JsonLinesRpcPeer>,
    private readonly sandboxDirectory: string,
    private readonly timeoutMs = 120_000,
  ) {
    if (!isAbsolute(sandboxDirectory)) {
      throw new AiProviderError('INTERNAL', 'Codex 隔离目录必须是绝对路径')
    }
  }

  async runStructured(input: {
    operation: string
    system: string
    payload: unknown
    outputSchema: unknown
    signal?: AbortSignal
  }): Promise<{ output: unknown; model: string | null; requestId?: string }> {
    if (input.signal?.aborted === true) {
      throw new AiProviderError('CANCELLED', 'AI 请求已取消')
    }
    await mkdir(this.sandboxDirectory, { recursive: true })
    const rpc = await this.connect()
    assertNotAborted(input.signal)
    const buffered: RpcNotification[] = []
    let threadId: string | null = null
    let turnId: string | null = null
    let settled = false
    let terminalError: Error | null = null
    const turnCompletion = createDeferred<TurnRecord>()
    void turnCompletion.promise.catch(() => undefined)

    const interrupt = (): void => {
      if (threadId !== null && turnId !== null) {
        void rpc.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      }
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      terminalError = error
      interrupt()
      turnCompletion.reject(error)
    }
    const inspectItem = (item: unknown): void => {
      const error = unsafeItemError(item)
      if (error !== null) fail(error)
    }
    const processNotification = (notification: RpcNotification): void => {
      if (settled) return
      if (notification.method === 'security/serverRequestRejected') {
        fail(new AiProviderError('TOOL_REQUEST_REJECTED', 'Codex 工具请求已被安全边界拒绝'))
        return
      }
      if (notification.method === 'item/started' || notification.method === 'item/completed') {
        const params = parseItemEnvelope(notification.params)
        if (params === null) {
          fail(invalidNotificationError(notification.method))
          return
        }
        if (params.threadId === threadId && params.turnId === turnId) inspectItem(params.item)
        return
      }
      if (notification.method !== 'turn/completed') return
      const params = parseTurnEnvelope(notification.params)
      if (params === null) {
        fail(invalidNotificationError(notification.method))
        return
      }
      if (params.threadId !== threadId || params.turn.id !== turnId) return
      settled = true
      turnCompletion.resolve(params.turn)
    }
    const onNotification = (notification: RpcNotification): void => {
      const validationError = validateRelevantNotification(notification)
      if (validationError !== null) {
        fail(validationError)
        return
      }
      if (notification.method === 'security/serverRequestRejected') {
        processNotification(notification)
        return
      }
      if (threadId === null || turnId === null) {
        if (buffered.length >= MAX_BUFFERED_NOTIFICATIONS) {
          fail(new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex 在任务启动前发送了过多协议消息'))
          return
        }
        buffered.push(notification)
      } else processNotification(notification)
    }
    rpc.notifications.on('notification', onNotification)

    const onAbort = (): void => {
      if (threadId !== null && turnId === null && !rpc.isClosed()) {
        rpc.terminate(
          new AiProviderError(
            'OUTCOME_UNKNOWN',
            'AI 请求在任务编号确认前被取消，已终止 Codex 连接以阻止后台继续运行',
          ),
        )
      }
      fail(new AiProviderError('CANCELLED', 'AI 请求已取消'))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const threadValue = await rpc.request<unknown>('thread/start', {
        cwd: this.sandboxDirectory,
        runtimeWorkspaceRoots: [this.sandboxDirectory],
        approvalPolicy: 'never',
        permissions: ':read-only',
        baseInstructions: input.system,
        developerInstructions:
          'Return only one JSON value matching the supplied output schema. Never use tools.',
        ephemeral: true,
        sessionStartSource: 'startup',
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
      })
      assertRunActive(input.signal, terminalError)
      const thread = parseThreadStartResponse(threadValue)
      if (thread === null) {
        throw new AiProviderError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex thread/start 返回了不兼容的协议消息',
        )
      }
      threadId = thread.thread.id
      assertRunActive(input.signal, terminalError)
      const startedValue = await rpc.request<unknown>('turn/start', {
        threadId,
        input: [
          {
            type: 'text',
            text: JSON.stringify({ operation: input.operation, context: input.payload }),
            text_elements: [],
          },
        ],
        approvalPolicy: 'never',
        permissions: ':read-only',
        environments: [],
        cwd: this.sandboxDirectory,
        runtimeWorkspaceRoots: [this.sandboxDirectory],
        outputSchema: input.outputSchema,
      })
      const started = parseTurnStartResponse(startedValue)
      if (started === null) {
        throw new AiProviderError(
          'PROTOCOL_INCOMPATIBLE',
          'Codex turn/start 返回了不兼容的协议消息',
        )
      }
      turnId = started.turn.id
      if (isSignalAborted(input.signal)) {
        interrupt()
        throw new AiProviderError('CANCELLED', 'AI 请求已取消')
      }
      assertRunActive(input.signal, terminalError)
      for (const notification of buffered.splice(0)) processNotification(notification)
      assertRunActive(input.signal, terminalError)
      if (started.turn.status !== 'inProgress') {
        settled = true
        turnCompletion.resolve(started.turn)
      }

      timer = setTimeout(
        () => fail(new AiProviderError('OFFLINE', 'Codex 响应超时，请稍后重试')),
        this.timeoutMs,
      )
      const completed = await turnCompletion.promise
      if (completed.status === 'interrupted') {
        throw new AiProviderError('CANCELLED', 'Codex 请求已中断')
      }
      if (completed.status === 'failed') {
        throw new AiProviderError('INTERNAL', completed.error?.message ?? 'Codex 生成失败')
      }
      for (const item of completed.items) {
        const error = unsafeItemError(item)
        if (error !== null) throw error
      }
      const answer = findFinalAgentMessage(completed.items)
      if (answer === null) {
        throw new AiProviderError('OUTPUT_INVALID', 'Codex 没有返回结构化结果')
      }
      try {
        return { output: JSON.parse(answer), model: thread.model, requestId: completed.id }
      } catch {
        throw new AiProviderError('OUTPUT_INVALID', 'Codex 返回的内容不是有效 JSON')
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      rpc.notifications.off('notification', onNotification)
    }
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (isSignalAborted(signal)) {
    throw new AiProviderError('CANCELLED', 'AI 请求已取消')
  }
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false
}

function assertRunActive(signal: AbortSignal | undefined, error: Error | null): void {
  assertNotAborted(signal)
  if (error !== null) throw error
}

function invalidNotificationError(method: string): AiProviderError {
  return new AiProviderError('PROTOCOL_INCOMPATIBLE', `Codex ${method} 通知缺少必需字段`)
}

function validateRelevantNotification(notification: RpcNotification): AiProviderError | null {
  if (notification.method === 'item/started' || notification.method === 'item/completed') {
    return parseItemEnvelope(notification.params) === null
      ? invalidNotificationError(notification.method)
      : null
  }
  if (notification.method === 'turn/completed') {
    return parseTurnEnvelope(notification.params) === null
      ? invalidNotificationError(notification.method)
      : null
  }
  return null
}

function parseThreadStartResponse(value: unknown): ThreadStartResponse | null {
  if (!isRecord(value) || !isRecord(value['thread'])) return null
  const id = value['thread']['id']
  const model = value['model']
  if (typeof id !== 'string' || id.length === 0 || typeof model !== 'string') return null
  return { thread: { id }, model }
}

function parseTurnStartResponse(value: unknown): TurnStartResponse | null {
  if (!isRecord(value)) return null
  const turn = parseTurnRecord(value['turn'])
  return turn === null ? null : { turn }
}

function parseItemEnvelope(value: unknown): ItemEnvelope | null {
  if (
    !isRecord(value) ||
    typeof value['threadId'] !== 'string' ||
    value['threadId'].length === 0 ||
    typeof value['turnId'] !== 'string' ||
    value['turnId'].length === 0 ||
    !Object.prototype.hasOwnProperty.call(value, 'item')
  ) {
    return null
  }
  return { threadId: value['threadId'], turnId: value['turnId'], item: value['item'] }
}

function parseTurnEnvelope(value: unknown): TurnEnvelope | null {
  if (!isRecord(value) || typeof value['threadId'] !== 'string' || value['threadId'].length === 0) {
    return null
  }
  const turn = parseTurnRecord(value['turn'])
  return turn === null ? null : { threadId: value['threadId'], turn }
}

function parseTurnRecord(value: unknown): TurnRecord | null {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    value['id'].length === 0 ||
    typeof value['status'] !== 'string' ||
    !TURN_STATUSES.has(value['status'] as TurnRecord['status']) ||
    !Array.isArray(value['items'])
  ) {
    return null
  }
  const error = value['error']
  if (
    error !== null &&
    (!isRecord(error) || (error['message'] !== undefined && typeof error['message'] !== 'string'))
  ) {
    return null
  }
  return {
    id: value['id'],
    status: value['status'] as TurnRecord['status'],
    error:
      error === null
        ? null
        : { ...(typeof error['message'] === 'string' ? { message: error['message'] } : {}) },
    items: value['items'],
  }
}

function findFinalAgentMessage(items: readonly unknown[]): string | null {
  const messages = items.filter(
    (item): item is Record<string, unknown> =>
      isRecord(item) && item['type'] === 'agentMessage' && typeof item['text'] === 'string',
  )
  const final = [...messages].reverse().find((item) => item['phase'] === 'final_answer')
  const candidate = final ?? messages.at(-1)
  return typeof candidate?.['text'] === 'string' ? candidate['text'] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unsafeItemError(item: unknown): AiProviderError | null {
  if (!isRecord(item) || typeof item['type'] !== 'string') {
    return new AiProviderError('OUTPUT_INVALID', 'Codex 返回了无法识别的消息')
  }
  if (!SAFE_ITEM_TYPES.has(item['type'])) {
    return new AiProviderError('TOOL_REQUEST_REJECTED', `Codex 尝试了被禁止的能力：${item['type']}`)
  }
  return null
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
