import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CodexAccountClient } from './codex-account.js'
import { CodexAppServerRunner } from './codex-runner.js'
import { JsonLinesRpcPeer } from './codex-rpc.js'
import { CodexProvider, MockAiProvider } from './provider.js'
import { AiProviderError } from './types.js'

describe('CodexAccountClient', () => {
  it('uses the official managed ChatGPT login surface', async () => {
    const calls: Array<{ method: string; params?: unknown }> = []
    const client = new CodexAccountClient({
      request<T>(method: string, params?: unknown): Promise<T> {
        calls.push({ method, params })
        return Promise.resolve({
          type: 'chatgpt',
          loginId: 'login-1',
          authUrl: 'https://auth.openai.com/example',
        } as T)
      },
    })

    await expect(client.startBrowserLogin()).resolves.toMatchObject({ type: 'chatgpt' })
    expect(calls).toEqual([
      {
        method: 'account/login/start',
        params: { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' },
      },
    ])
  })
})

describe('JsonLinesRpcPeer', () => {
  it('rejects every server-initiated request', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    new JsonLinesRpcPeer(input, output)
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tool/approval', params: {} })}\n`,
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toContain('does not grant Codex tool')
    expect(written).toContain('"id":9')
  })

  it('writes notifications without inventing a request id', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    const peer = new JsonLinesRpcPeer(input, output)
    await peer.notify('initialized')
    expect(JSON.parse(written)).toEqual({ jsonrpc: '2.0', method: 'initialized' })
  })

  it('honors writable backpressure before starting the response deadline', async () => {
    const input = new PassThrough()
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
        const call = JSON.parse(chunk.toString()) as { id: string }
        setTimeout(() => {
          callback()
          setTimeout(() => {
            input.write(`${JSON.stringify({ id: call.id, result: { ok: true } })}\n`)
          }, 40)
        }, 40)
      },
    })
    const peer = new JsonLinesRpcPeer(input, output, 60)

    await expect(
      peer.request('large/request', { content: 'x'.repeat(512 * 1024) }),
    ).resolves.toEqual({ ok: true })
    peer.close()
  })

  it('closes the transport safely when an inbound JSON value is not an object', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const onFatal = vi.fn()
    const peer = new JsonLinesRpcPeer(input, output, 100, onFatal)
    const pending = peer.request('account/read')
    await new Promise((resolve) => setImmediate(resolve))

    input.write('null\n')

    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(peer.isClosed()).toBe(true)
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROTOCOL_INCOMPATIBLE' }))
  })

  it('treats a response timeout as outcome-unknown and poisons the transport', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const onFatal = vi.fn()
    const peer = new JsonLinesRpcPeer(input, output, 15, onFatal)

    await expect(peer.request('turn/start', { threadId: 'thread-1' })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
    expect(peer.isClosed()).toBe(true)
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'OUTCOME_UNKNOWN' }))
  })

  it('rejects an oversized outbound line before writing it', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const onFatal = vi.fn()
    let writtenBytes = 0
    output.on('data', (chunk: Buffer) => {
      writtenBytes += chunk.length
    })
    const peer = new JsonLinesRpcPeer(input, output, 100, onFatal)

    await expect(
      peer.notify('oversized', { content: 'x'.repeat(2 * 1024 * 1024) }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(writtenBytes).toBe(0)
    expect(onFatal).not.toHaveBeenCalled()
    peer.close()
  })

  it('stops buffering an oversized inbound line before a newline arrives', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const onFatal = vi.fn()
    const peer = new JsonLinesRpcPeer(input, output, 100, onFatal)
    const pending = peer.request('account/read')
    await new Promise((resolve) => setImmediate(resolve))

    input.write(Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))

    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(peer.isClosed()).toBe(true)
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROTOCOL_INCOMPATIBLE' }))
  })
})

describe('CodexAppServerRunner', () => {
  it('uses an ephemeral read-only thread and parses schema-constrained JSON', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonLinesRpcPeer(input, output)
    const calls: Array<Record<string, unknown>> = []
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split(/\r?\n/u)) {
        if (!line) continue
        const call = JSON.parse(line) as Record<string, unknown>
        calls.push(call)
        if (call['method'] === 'thread/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })}\n`,
          )
        }
        if (call['method'] === 'turn/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { turn: { id: 'turn-1', status: 'inProgress', error: null, items: [] } } })}\n`,
          )
          queueMicrotask(() => {
            input.write(
              `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', error: null, items: [{ type: 'agentMessage', id: 'message-1', text: '{"ok":true}', phase: 'final_answer' }] } } })}\n`,
            )
          })
        }
      }
    })

    const runner = new CodexAppServerRunner(() => Promise.resolve(peer), 'C:\\BossHunterSandbox')
    await expect(
      runner.runStructured({
        operation: 'test',
        system: 'Return JSON',
        payload: { evidence: 'verified' },
        outputSchema: { type: 'object' },
      }),
    ).resolves.toMatchObject({ output: { ok: true }, model: 'gpt-test', requestId: 'turn-1' })
    const threadCall = calls.find((call) => call['method'] === 'thread/start')
    expect(threadCall?.['params']).toMatchObject({
      approvalPolicy: 'never',
      permissions: ':read-only',
      ephemeral: true,
      dynamicTools: [],
    })
  })

  it('fails closed as soon as Codex emits a tool item', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonLinesRpcPeer(input, output)
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split(/\r?\n/u)) {
        if (!line) continue
        const call = JSON.parse(line) as Record<string, unknown>
        if (call['method'] === 'thread/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })}\n`,
          )
        }
        if (call['method'] === 'turn/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { turn: { id: 'turn-1', status: 'inProgress', error: null, items: [] } } })}\n`,
          )
          queueMicrotask(() => {
            input.write(
              `${JSON.stringify({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'commandExecution', command: 'whoami' } } })}\n`,
            )
          })
        }
        if (call['method'] === 'turn/interrupt') {
          input.write(`${JSON.stringify({ id: call['id'], result: {} })}\n`)
        }
      }
    })
    const runner = new CodexAppServerRunner(() => Promise.resolve(peer), 'C:\\BossHunterSandbox')
    await expect(
      runner.runStructured({
        operation: 'test',
        system: 'Return JSON',
        payload: {},
        outputSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_REQUEST_REJECTED' })
  })

  it('rejects a tool item even if it only appears in the completed turn snapshot', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonLinesRpcPeer(input, output)
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split(/\r?\n/u)) {
        if (!line) continue
        const call = JSON.parse(line) as Record<string, unknown>
        if (call['method'] === 'thread/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })}\n`,
          )
        }
        if (call['method'] === 'turn/start') {
          input.write(
            `${JSON.stringify({
              id: call['id'],
              result: {
                turn: {
                  id: 'turn-1',
                  status: 'completed',
                  error: null,
                  items: [
                    { type: 'webSearch', id: 'search-1', query: 'private data' },
                    {
                      type: 'agentMessage',
                      id: 'message-1',
                      text: '{"ok":true}',
                      phase: 'final_answer',
                    },
                  ],
                },
              },
            })}\n`,
          )
        }
      }
    })
    const runner = new CodexAppServerRunner(() => Promise.resolve(peer), 'C:\\BossHunterSandbox')
    await expect(
      runner.runStructured({
        operation: 'test',
        system: 'Return JSON',
        payload: {},
        outputSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ code: 'TOOL_REQUEST_REJECTED' })
  })

  it('rejects malformed notification params without throwing outside the request', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const peer = new JsonLinesRpcPeer(input, output)
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split(/\r?\n/u)) {
        if (!line) continue
        const call = JSON.parse(line) as Record<string, unknown>
        if (call['method'] === 'thread/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })}\n`,
          )
        }
        if (call['method'] === 'turn/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { turn: { id: 'turn-1', status: 'inProgress', error: null, items: [] } } })}\n`,
          )
          queueMicrotask(() => {
            input.write(`${JSON.stringify({ method: 'item/started', params: null })}\n`)
          })
        }
        if (call['method'] === 'turn/interrupt') {
          input.write(`${JSON.stringify({ id: call['id'], result: {} })}\n`)
        }
      }
    })
    const runner = new CodexAppServerRunner(() => Promise.resolve(peer), 'C:\\BossHunterSandbox')

    await expect(
      runner.runStructured({
        operation: 'test',
        system: 'Return JSON',
        payload: {},
        outputSchema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
  })

  it('terminates the transport when cancellation races with turn/start acknowledgement', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const onFatal = vi.fn()
    const peer = new JsonLinesRpcPeer(input, output, 1_000, onFatal)
    const controller = new AbortController()
    output.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().trim().split(/\r?\n/u)) {
        if (!line) continue
        const call = JSON.parse(line) as Record<string, unknown>
        if (call['method'] === 'thread/start') {
          input.write(
            `${JSON.stringify({ id: call['id'], result: { thread: { id: 'thread-1' }, model: 'gpt-test' } })}\n`,
          )
        }
        if (call['method'] === 'turn/start') controller.abort()
      }
    })
    const runner = new CodexAppServerRunner(() => Promise.resolve(peer), 'C:\\BossHunterSandbox')

    await expect(
      runner.runStructured({
        operation: 'test',
        system: 'Return JSON',
        payload: {},
        outputSchema: { type: 'object' },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' })
    expect(peer.isClosed()).toBe(true)
    expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 'OUTCOME_UNKNOWN' }))
  })
})

describe('AI providers', () => {
  it('validates all structured output', async () => {
    const provider = new MockAiProvider(() => ({ question: '你本人具体做了什么？' }))
    const result = await provider.run({
      operation: 'next_interview_question',
      instructions: 'Ask one evidence-seeking question',
      context: [],
      outputSchema: z.object({ question: z.string().min(1) }),
    })
    expect(result.value.question).toContain('具体')
  })

  it('does not send context that lacks AI permission', async () => {
    let captured: unknown
    const provider = new CodexProvider(
      () =>
        Promise.resolve({
          availability: 'ready',
          authMode: 'chatgpt',
          planType: 'plus',
          message: 'ready',
          retryAt: null,
        }),
      {
        runStructured(input) {
          captured = input.payload
          return Promise.resolve({ output: { ok: true }, model: 'test' })
        },
      },
    )
    await provider.run({
      operation: 'extract_fact_proposals',
      instructions: 'Extract only supported facts',
      context: [
        { id: 'allowed', kind: 'source_excerpt', content: 'A', trusted: false, aiAllowed: true },
        { id: 'private', kind: 'source_excerpt', content: 'B', trusted: false, aiAllowed: false },
      ],
      outputSchema: z.object({ ok: z.boolean() }),
    })
    expect(JSON.stringify(captured)).toContain('allowed')
    expect(JSON.stringify(captured)).not.toContain('private')
  })

  it('rejects aggregate context beyond the fixed budget before invoking Codex', async () => {
    const runStructured = vi.fn(() => Promise.resolve({ output: { ok: true }, model: 'test' }))
    const provider = new CodexProvider(
      () =>
        Promise.resolve({
          availability: 'ready',
          authMode: 'chatgpt',
          planType: 'plus',
          message: 'ready',
          retryAt: null,
        }),
      { runStructured },
    )

    await expect(
      provider.run({
        operation: 'extract_fact_proposals',
        instructions: 'Extract facts',
        context: Array.from({ length: 30 }, (_, index) => ({
          id: `fragment-${index}`,
          kind: 'source_excerpt' as const,
          content: 'x'.repeat(12_000),
          trusted: false,
          aiAllowed: true,
        })),
        outputSchema: z.object({ ok: z.boolean() }),
      }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(runStructured).not.toHaveBeenCalled()
  })

  it('fails closed when Codex is not ready', async () => {
    const provider = new CodexProvider(
      () =>
        Promise.resolve({
          availability: 'auth_required',
          authMode: null,
          planType: null,
          message: 'login',
          retryAt: null,
        }),
      {
        runStructured() {
          return Promise.reject(new Error('must not run'))
        },
      },
    )
    await expect(
      provider.run({
        operation: 'decompose_job',
        instructions: 'x',
        context: [],
        outputSchema: z.object({}),
      }),
    ).rejects.toBeInstanceOf(AiProviderError)
  })
})
