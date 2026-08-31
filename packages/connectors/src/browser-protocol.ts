import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { jobIdentitySchema, platformIdSchema, preparedActionSchema } from './contracts.js'

export const browserCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('health'), platform: platformIdSchema }),
  z.object({
    type: z.literal('collect'),
    platform: platformIdSchema,
    keywords: z.array(z.string().min(1)).min(1).max(10),
    cityCodes: z.array(z.string().min(1)).max(20),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().nullable(),
  }),
  z.object({ type: z.literal('inspect'), identity: jobIdentitySchema }),
  z.object({ type: z.literal('execute'), action: preparedActionSchema }),
  z.object({ type: z.literal('reconcile'), action: preparedActionSchema }),
])

export type BrowserCommand = z.infer<typeof browserCommandSchema>

export const browserRequestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  command: browserCommandSchema,
})

export const browserResponseSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).optional(),
})

export type BrowserRequest = z.infer<typeof browserRequestSchema>
export type BrowserResponse = z.infer<typeof browserResponseSchema>

export interface BrowserWorkerChannel {
  send(message: BrowserRequest): void
  onMessage(listener: (message: unknown) => void): () => void
}

export class BrowserWorkerProtocol {
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()
  private readonly unsubscribe: () => void

  constructor(
    private readonly channel: BrowserWorkerChannel,
    private readonly timeoutMs = 20_000,
  ) {
    this.unsubscribe = channel.onMessage((message) => this.handleMessage(message))
  }

  request<T>(command: BrowserCommand): Promise<T> {
    const request: BrowserRequest = {
      protocolVersion: 1,
      requestId: randomUUID(),
      command: browserCommandSchema.parse(command),
    }
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.requestId)
        reject(new Error('Browser worker request timed out'))
      }, this.timeoutMs)
      this.pending.set(request.requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
      this.channel.send(request)
    })
  }

  close(): void {
    this.unsubscribe()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Browser worker channel closed'))
    }
    this.pending.clear()
  }

  private handleMessage(raw: unknown): void {
    const parsed = browserResponseSchema.safeParse(raw)
    if (!parsed.success) return
    const pending = this.pending.get(parsed.data.requestId)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending.delete(parsed.data.requestId)
    if (!parsed.data.ok) {
      pending.reject(new Error(parsed.data.error?.message ?? 'Browser worker failed'))
    } else {
      pending.resolve(parsed.data.result)
    }
  }
}
