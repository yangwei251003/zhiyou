import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { CodexAccountClient } from './codex-account.js'
import {
  createTrustedCodexLaunchCommand,
  isTrustedOpenAiSignature,
  resolveTrustedCodexExecutable,
} from './codex-executable.js'
import { JsonLinesRpcPeer } from './codex-rpc.js'
import { AiProviderError } from './types.js'

export interface CodexAppServerOptions {
  executablePath?: string
  clientVersion?: string
  requestTimeoutMs?: number
  shutdownTimeoutMs?: number
}

interface InitializeResponse {
  userAgent: string
  codexHome: string
  platformFamily: string
  platformOs: string
}

export class CodexAppServerRuntime {
  private child: ChildProcessWithoutNullStreams | null = null
  private peer: JsonLinesRpcPeer | null = null
  private startPromise: Promise<JsonLinesRpcPeer> | null = null
  private stopPromise: Promise<void> | null = null
  private readonly processStops = new WeakMap<ChildProcessWithoutNullStreams, Promise<void>>()
  private lifecycleVersion = 0
  private poisoned = false
  private diagnostics = ''

  constructor(private readonly options: CodexAppServerOptions = {}) {}

  async start(): Promise<JsonLinesRpcPeer> {
    if (this.startPromise !== null) return this.startPromise
    if (this.stopPromise !== null) {
      await this.stopPromise
      return this.start()
    }
    if (this.poisoned) {
      throw new AiProviderError(
        'OFFLINE',
        'Codex 进程树未能确认清理；本次应用已禁止再次启动，请重启 BossHunter',
      )
    }
    if (this.peer !== null) {
      if (!this.peer.isClosed()) return this.peer
      if (this.child !== null) {
        throw new AiProviderError('OFFLINE', 'Codex 连接正在安全清理，已阻止重复启动')
      }
      this.peer = null
    }
    if (this.child !== null) {
      throw new AiProviderError('OFFLINE', '上一 Codex App Server 仍在清理，已阻止重复启动')
    }

    const lifecycleVersion = this.lifecycleVersion
    const startPromise = this.startOnce(lifecycleVersion)
    this.startPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null
    }
  }

  private async startOnce(lifecycleVersion: number): Promise<JsonLinesRpcPeer> {
    const executable = await resolveTrustedCodexExecutable({
      platform: process.platform,
      ...(this.options.executablePath === undefined
        ? {}
        : { explicitPath: this.options.executablePath }),
    })
    this.ensureLifecycle(lifecycleVersion)
    const launch = await createTrustedCodexLaunchCommand(executable)
    this.ensureLifecycle(lifecycleVersion)
    let child: ChildProcessWithoutNullStreams | null = null
    let peer: JsonLinesRpcPeer | null = null
    try {
      child = spawn(launch.launcherPath, launch.arguments, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.diagnostics = `${this.diagnostics}${chunk}`.slice(-8_192)
      })

      await waitForSpawn(child)
      this.ensureLifecycle(lifecycleVersion)
      await approveTrustedLauncher(
        child,
        launch.approvalToken,
        this.options.requestTimeoutMs ?? 45_000,
      )
      this.ensureLifecycle(lifecycleVersion)

      const launchedChild = child
      const createdPeer = new JsonLinesRpcPeer(
        child.stdout,
        child.stdin,
        this.options.requestTimeoutMs ?? 45_000,
        () => {
          void this.stopProcess(launchedChild, createdPeer).catch(() => {
            this.poisoned = true
          })
        },
      )
      peer = createdPeer
      this.peer = peer
      this.attachProcessLifecycle(child, peer)

      await peer.request<InitializeResponse>('initialize', {
        clientInfo: {
          name: 'bosshunter-next',
          title: 'BossHunter Next',
          version: this.options.clientVersion ?? '0.1.0-alpha.1',
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      })
      this.ensureLifecycle(lifecycleVersion)
      await peer.notify('initialized')
      return peer
    } catch (cause) {
      if (child !== null) await this.stopProcess(child, peer)
      if (cause instanceof AiProviderError) throw cause
      throw new AiProviderError(
        child === null ? 'OFFLINE' : 'PROTOCOL_INCOMPATIBLE',
        child === null ? '无法启动经发布者验证的 Codex App Server' : 'Codex App Server 初始化失败',
      )
    }
  }

  async account(): Promise<CodexAccountClient> {
    return new CodexAccountClient(await this.start())
  }

  getDiagnostics(): string {
    return this.diagnostics
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise

    const stopPromise = this.stopOnce()
    this.stopPromise = stopPromise
    try {
      await stopPromise
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null
    }
  }

  private async stopOnce(): Promise<void> {
    this.lifecycleVersion += 1
    const pendingStart = this.startPromise
    const child = this.child
    const peer = this.peer
    if (child !== null) await this.stopProcess(child, peer)
    else {
      peer?.close()
      if (this.peer === peer) this.peer = null
    }
    if (pendingStart !== null) await pendingStart.catch(() => undefined)
  }

  private ensureLifecycle(lifecycleVersion: number): void {
    if (this.lifecycleVersion !== lifecycleVersion) {
      throw new AiProviderError('OFFLINE', 'Codex App Server 启动已取消')
    }
  }

  private attachProcessLifecycle(
    child: ChildProcessWithoutNullStreams,
    peer: JsonLinesRpcPeer,
  ): void {
    child.on('error', () => {
      peer.close(new AiProviderError('OFFLINE', '经发布者验证的 Codex App Server 运行失败'))
      void this.stopProcess(child, peer).catch(() => {
        this.poisoned = true
      })
    })
    child.once('exit', () => {
      peer.close(new AiProviderError('OFFLINE', 'Codex App Server 已退出'))
      if (this.peer === peer) this.peer = null
      if (this.child === child) this.child = null
    })
  }

  private async stopProcess(
    child: ChildProcessWithoutNullStreams,
    peer: JsonLinesRpcPeer | null,
  ): Promise<void> {
    const existing = this.processStops.get(child)
    if (existing !== undefined) return existing

    const stopPromise = this.stopProcessOnce(child, peer)
    this.processStops.set(child, stopPromise)
    try {
      await stopPromise
    } finally {
      if (this.processStops.get(child) === stopPromise) this.processStops.delete(child)
    }
  }

  private async stopProcessOnce(
    child: ChildProcessWithoutNullStreams,
    peer: JsonLinesRpcPeer | null,
  ): Promise<void> {
    peer?.close()
    if (this.peer === peer) this.peer = null
    if (child.exitCode !== null) {
      if (this.child === child) this.child = null
      return
    }

    child.stdin.end()
    child.kill()
    const exited = await waitForExit(child, this.options.shutdownTimeoutMs ?? 5_000)
    if (!exited && child.exitCode === null) {
      this.poisoned = true
      throw new AiProviderError(
        'OFFLINE',
        'Codex App Server 进程仍在运行；已保留句柄并阻止重复启动',
      )
    }
    if (this.child === child) this.child = null
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      child.off('error', onError)
      resolve()
    }
    const onError = (): void => {
      child.off('spawn', onSpawn)
      reject(new AiProviderError('OFFLINE', '无法启动经发布者验证的 Codex App Server'))
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}

function approveTrustedLauncher(
  child: ChildProcessWithoutNullStreams,
  approvalToken: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY })
    let phase: 'attestation' | 'ready' | 'proxy' = 'attestation'
    let settled = false
    const timer = setTimeout(() => {
      fail(new AiProviderError('OFFLINE', 'Codex 可信启动代理响应超时'))
    }, timeoutMs)

    const cleanup = (): void => {
      clearTimeout(timer)
      lines.removeAllListeners()
      lines.close()
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const fail = (error: AiProviderError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onError = (): void => {
      fail(new AiProviderError('OFFLINE', 'Codex 可信启动代理运行失败'))
    }
    const onExit = (): void => {
      fail(new AiProviderError('OFFLINE', 'Codex 可信启动代理提前退出'))
    }

    lines.on('line', (line) => {
      if (settled) return
      const message = parseLauncherMessage(line)
      if (phase === 'attestation') {
        if (
          message === null ||
          message.protocol !== 'bosshunter.trusted-launch.v1' ||
          typeof message.status !== 'string' ||
          (typeof message.subject !== 'string' && message.subject !== null) ||
          (typeof message.rootSha256 !== 'string' && message.rootSha256 !== null) ||
          !isTrustedOpenAiSignature({
            status: message.status,
            signerSubject: message.subject,
            chainRootSha256: message.rootSha256,
          })
        ) {
          fail(
            new AiProviderError(
              'PROTOCOL_INCOMPATIBLE',
              'Codex 启动时的发布者复验失败，已拒绝运行',
            ),
          )
          return
        }
        phase = 'ready'
        child.stdin.write(`${approvalToken}\n`)
        return
      }
      if (phase === 'ready') {
        if (
          message === null ||
          message.protocol !== 'bosshunter.trusted-launch.v1' ||
          message.ready !== true
        ) {
          fail(new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex 可信启动代理协议不兼容'))
          return
        }
        phase = 'proxy'
        child.stdin.write(`${approvalToken}:proxy\n`)
        return
      }
      if (
        message === null ||
        message.protocol !== 'bosshunter.trusted-launch.v1' ||
        message.proxyReady !== true
      ) {
        fail(new AiProviderError('PROTOCOL_INCOMPATIBLE', 'Codex 可信启动代理未确认流切换'))
        return
      }
      settled = true
      cleanup()
      resolve()
    })
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

interface LauncherMessage {
  protocol?: unknown
  status?: unknown
  subject?: unknown
  rootSha256?: unknown
  ready?: unknown
  proxyReady?: unknown
}

function parseLauncherMessage(line: string): LauncherMessage | null {
  if (line.length === 0 || line.length > 8_192) return null
  try {
    const value = JSON.parse(line) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    return {
      protocol: record['Protocol'],
      status: record['Status'],
      subject: record['Subject'],
      rootSha256: record['RootSha256'],
      ready: record['Ready'],
      proxyReady: record['ProxyReady'],
    }
  } catch {
    return null
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(true)
      return
    }
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs)
    child.once('exit', onExit)
    if (child.exitCode !== null) finish(true)
  })
}
