import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const processMocks = vi.hoisted(() => ({
  resolveExecutable: vi.fn(),
  createLaunch: vi.fn(),
  isTrustedSignature: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('./codex-executable.js', () => ({
  resolveTrustedCodexExecutable: processMocks.resolveExecutable,
  createTrustedCodexLaunchCommand: processMocks.createLaunch,
  isTrustedOpenAiSignature: processMocks.isTrustedSignature,
}))

vi.mock('node:child_process', () => ({
  spawn: processMocks.spawn,
}))

import { CodexAppServerRuntime } from './codex-runtime.js'

type InitializeOutcome = 'success' | 'failure'

describe('CodexAppServerRuntime lifecycle', () => {
  beforeEach(() => {
    processMocks.resolveExecutable.mockReset()
    processMocks.createLaunch.mockReset()
    processMocks.isTrustedSignature.mockReset()
    processMocks.spawn.mockReset()
    processMocks.resolveExecutable.mockResolvedValue('C:\\Program Files\\OpenAI\\Codex.exe')
    processMocks.createLaunch.mockResolvedValue({
      launcherPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      arguments: ['-NoProfile', '-EncodedCommand', 'test'],
      approvalToken: 'test-launch-approval',
    })
    processMocks.isTrustedSignature.mockReturnValue(true)
  })

  it('collapses concurrent starts and never exposes a peer before initialization', async () => {
    const initialization = deferred<InitializeOutcome>()
    const child = new FakeCodexChild(initialization.promise)
    processMocks.spawn.mockReturnValue(asChildProcess(child))
    const runtime = new CodexAppServerRuntime({ requestTimeoutMs: 2_000 })

    const first = runtime.start()
    await vi.waitFor(() => expect(child.initializeRequests).toBe(1))
    const second = runtime.start()
    const third = runtime.start()

    await expect(settlementWithinTurn(second)).resolves.toBe('pending')
    initialization.resolve('success')
    const [firstPeer, secondPeer, thirdPeer] = await Promise.all([first, second, third])

    expect(secondPeer).toBe(firstPeer)
    expect(thirdPeer).toBe(firstPeer)
    expect(processMocks.resolveExecutable).toHaveBeenCalledTimes(1)
    expect(processMocks.createLaunch).toHaveBeenCalledTimes(1)
    expect(processMocks.spawn).toHaveBeenCalledTimes(1)
    expect(child.initializedNotifications).toBe(1)

    await runtime.stop()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('cancels a start still awaiting executable verification without spawning a process', async () => {
    const executable = deferred<string>()
    processMocks.resolveExecutable.mockReturnValue(executable.promise)
    const runtime = new CodexAppServerRuntime()

    const starting = runtime.start()
    const firstStop = runtime.stop()
    const secondStop = runtime.stop()
    executable.resolve('C:\\Program Files\\OpenAI\\Codex.exe')

    await expect(starting).rejects.toMatchObject({
      code: 'OFFLINE',
      message: 'Codex App Server 启动已取消',
    })
    await Promise.all([firstStop, secondStop])
    expect(processMocks.spawn).not.toHaveBeenCalled()
  })

  it('fails closed before approval when the locked launch attestation is not trusted', async () => {
    const initialization = deferred<InitializeOutcome>()
    const child = new FakeCodexChild(initialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(child))
    processMocks.isTrustedSignature.mockReturnValue(false)
    const runtime = new CodexAppServerRuntime({ requestTimeoutMs: 2_000 })

    await expect(runtime.start()).rejects.toMatchObject({
      code: 'PROTOCOL_INCOMPATIBLE',
      message: 'Codex 启动时的发布者复验失败，已拒绝运行',
    })
    expect(child.initializeRequests).toBe(0)
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('stops exactly one child during initialization and can start cleanly afterward', async () => {
    const firstInitialization = deferred<InitializeOutcome>()
    const firstChild = new FakeCodexChild(firstInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(firstChild))
    const runtime = new CodexAppServerRuntime({ requestTimeoutMs: 2_000 })

    const starting = runtime.start()
    await vi.waitFor(() => expect(firstChild.initializeRequests).toBe(1))
    const stopping = runtime.stop()

    await expect(starting).rejects.toMatchObject({ code: 'OFFLINE' })
    await stopping
    expect(firstChild.kill).toHaveBeenCalledTimes(1)

    const secondInitialization = deferred<InitializeOutcome>()
    const secondChild = new FakeCodexChild(secondInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(secondChild))
    const restarted = runtime.start()
    await vi.waitFor(() => expect(secondChild.initializeRequests).toBe(1))
    secondInitialization.resolve('success')

    await expect(restarted).resolves.toBeDefined()
    expect(processMocks.spawn).toHaveBeenCalledTimes(2)
    await runtime.stop()
    expect(secondChild.kill).toHaveBeenCalledTimes(1)
  })

  it('cleans up a failed initialization and permits a later retry', async () => {
    const failedInitialization = deferred<InitializeOutcome>()
    const failedChild = new FakeCodexChild(failedInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(failedChild))
    const runtime = new CodexAppServerRuntime({ requestTimeoutMs: 2_000 })

    const firstStart = runtime.start()
    await vi.waitFor(() => expect(failedChild.initializeRequests).toBe(1))
    failedInitialization.resolve('failure')
    await expect(firstStart).rejects.toMatchObject({ code: 'PROTOCOL_INCOMPATIBLE' })
    expect(failedChild.kill).toHaveBeenCalledTimes(1)

    const successfulInitialization = deferred<InitializeOutcome>()
    const successfulChild = new FakeCodexChild(successfulInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(successfulChild))
    const retry = runtime.start()
    await vi.waitFor(() => expect(successfulChild.initializeRequests).toBe(1))
    successfulInitialization.resolve('success')

    await expect(retry).resolves.toBeDefined()
    expect(processMocks.resolveExecutable).toHaveBeenCalledTimes(2)
    expect(processMocks.spawn).toHaveBeenCalledTimes(2)
    await runtime.stop()
  })

  it('reaps an outcome-unknown process before allowing a fresh App Server', async () => {
    const firstInitialization = deferred<InitializeOutcome>()
    const firstChild = new FakeCodexChild(firstInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(firstChild))
    const runtime = new CodexAppServerRuntime({ requestTimeoutMs: 250, shutdownTimeoutMs: 100 })

    const starting = runtime.start()
    void starting.catch(() => undefined)
    await vi.waitFor(() => expect(firstChild.initializeRequests).toBe(1))
    firstInitialization.resolve('success')
    const firstPeer = await starting

    await expect(firstPeer.request('turn/start', { threadId: 'thread-1' })).rejects.toMatchObject({
      code: 'OUTCOME_UNKNOWN',
    })
    await vi.waitFor(() => expect(firstChild.kill).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(firstChild.exitCode).toBe(0))

    const secondInitialization = deferred<InitializeOutcome>()
    const secondChild = new FakeCodexChild(secondInitialization.promise)
    processMocks.spawn.mockReturnValueOnce(asChildProcess(secondChild))
    const restarted = runtime.start()
    await vi.waitFor(() => expect(secondChild.initializeRequests).toBe(1))
    secondInitialization.resolve('success')

    await expect(restarted).resolves.toBeDefined()
    expect(processMocks.spawn).toHaveBeenCalledTimes(2)
    await runtime.stop()
  })

  it('keeps a stubborn child sticky and blocks duplicate starts until it really exits', async () => {
    const initialization = deferred<InitializeOutcome>()
    const child = new FakeCodexChild(initialization.promise, { exitOnKill: false })
    processMocks.spawn.mockReturnValueOnce(asChildProcess(child))
    const runtime = new CodexAppServerRuntime({
      requestTimeoutMs: 2_000,
      shutdownTimeoutMs: 20,
    })

    const starting = runtime.start()
    await vi.waitFor(() => expect(child.initializeRequests).toBe(1))
    initialization.resolve('success')
    await starting

    await expect(runtime.stop()).rejects.toMatchObject({
      code: 'OFFLINE',
      message: 'Codex App Server 进程仍在运行；已保留句柄并阻止重复启动',
    })
    await expect(runtime.start()).rejects.toMatchObject({
      code: 'OFFLINE',
      message: 'Codex 进程树未能确认清理；本次应用已禁止再次启动，请重启 BossHunter',
    })
    expect(processMocks.spawn).toHaveBeenCalledTimes(1)

    child.forceExit()
    await vi.waitFor(() => expect(child.exitCode).toBe(0))
    await runtime.stop()
    await expect(runtime.start()).rejects.toMatchObject({ code: 'OFFLINE' })
  })
})

class FakeCodexChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  exitCode: number | null = null
  initializeRequests = 0
  initializedNotifications = 0
  private launcherApproved = false
  private proxyApproved = false
  readonly kill = vi.fn(() => {
    if (this.exitCode !== null) return false
    if (this.options.exitOnKill) this.forceExit()
    return true
  })

  constructor(
    initialization: Promise<InitializeOutcome>,
    private readonly options: { exitOnKill: boolean } = { exitOnKill: true },
  ) {
    super()
    let buffered = ''
    this.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split(/\r?\n/u)
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        if (!this.launcherApproved) {
          if (line !== 'test-launch-approval') {
            this.stderr.write('unexpected launcher approval')
            this.forceExit(70)
            continue
          }
          this.launcherApproved = true
          this.stdout.write(
            `${JSON.stringify({ Protocol: 'bosshunter.trusted-launch.v1', Ready: true })}\n`,
          )
          continue
        }
        if (!this.proxyApproved) {
          if (line !== 'test-launch-approval:proxy') {
            this.stderr.write('unexpected proxy approval')
            this.forceExit(70)
            continue
          }
          this.proxyApproved = true
          this.stdout.write(
            `${JSON.stringify({
              Protocol: 'bosshunter.trusted-launch.v1',
              ProxyReady: true,
            })}\n`,
          )
          continue
        }
        const message = JSON.parse(line) as Record<string, unknown>
        if (message['method'] === 'initialize') {
          this.initializeRequests += 1
          const id = message['id']
          void initialization.then((outcome) => {
            if (this.exitCode !== null) return
            this.stdout.write(
              `${JSON.stringify(
                outcome === 'success'
                  ? {
                      jsonrpc: '2.0',
                      id,
                      result: {
                        userAgent: 'codex-test',
                        codexHome: 'C:\\CodexTest',
                        platformFamily: 'windows',
                        platformOs: 'windows',
                      },
                    }
                  : {
                      jsonrpc: '2.0',
                      id,
                      error: { code: -32_000, message: 'incompatible test server' },
                    },
              )}\n`,
            )
          })
        }
        if (message['method'] === 'initialized') this.initializedNotifications += 1
      }
    })
    setImmediate(() => {
      this.emit('spawn')
      this.stdout.write(
        `${JSON.stringify({
          Protocol: 'bosshunter.trusted-launch.v1',
          Status: 'Valid',
          Subject:
            'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US',
          RootSha256: '5367F20C7ADE0E2BCA790915056D086B720C33C1FA2A2661ACF787E3292E1270',
        })}\n`,
      )
    })
  }

  forceExit(code = 0): void {
    if (this.exitCode !== null) return
    this.exitCode = code
    queueMicrotask(() => {
      this.stdout.end()
      this.stderr.end()
      this.emit('exit', code, null)
    })
  }
}

function asChildProcess(child: FakeCodexChild): ChildProcessWithoutNullStreams {
  return child as unknown as ChildProcessWithoutNullStreams
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

async function settlementWithinTurn(promise: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    promise.then(() => 'settled' as const),
    new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
  ])
}
