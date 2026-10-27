import { z } from 'zod'

import type { CodexRpcTransport } from './codex-rpc.js'
import type { AiProviderStatus } from './types.js'

const accountSchema = z.object({
  account: z
    .object({
      type: z.string(),
      email: z.string().email().optional(),
      planType: z.string().nullable().optional(),
    })
    .nullable(),
  requiresOpenaiAuth: z.boolean(),
})

const loginResultSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chatgpt'), loginId: z.string(), authUrl: z.string().url() }),
  z.object({
    type: z.literal('chatgptDeviceCode'),
    loginId: z.string(),
    verificationUrl: z.string().url(),
    userCode: z.string(),
  }),
])

const rateWindowSchema = z.object({
  usedPercent: z.number().min(0),
  windowDurationMins: z.number().positive(),
  resetsAt: z.number().int(),
})

const rateLimitSchema = z.object({
  rateLimits: z
    .object({
      limitId: z.string(),
      primary: rateWindowSchema.nullable(),
      secondary: rateWindowSchema.nullable().optional(),
      rateLimitReachedType: z.string().nullable().optional(),
      planType: z.string().nullable().optional(),
    })
    .nullable(),
  rateLimitsByLimitId: z.record(z.string(), z.unknown()).optional(),
})

export type CodexLoginResult = z.infer<typeof loginResultSchema>
export type CodexRateLimits = z.infer<typeof rateLimitSchema>

export class CodexAccountClient {
  constructor(private readonly rpc: CodexRpcTransport) {}

  async read(refreshToken = false): Promise<z.infer<typeof accountSchema>> {
    return accountSchema.parse(
      await this.rpc.request('account/read', {
        refreshToken,
      }),
    )
  }

  async startBrowserLogin(): Promise<CodexLoginResult> {
    return loginResultSchema.parse(
      await this.rpc.request('account/login/start', {
        type: 'chatgpt',
        useHostedLoginSuccessPage: true,
        appBrand: 'codex',
      }),
    )
  }

  async startDeviceCodeLogin(): Promise<CodexLoginResult> {
    return loginResultSchema.parse(
      await this.rpc.request('account/login/start', { type: 'chatgptDeviceCode' }),
    )
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.rpc.request('account/login/cancel', { loginId })
  }

  async logout(): Promise<void> {
    await this.rpc.request('account/logout')
  }

  async readRateLimits(): Promise<CodexRateLimits> {
    return rateLimitSchema.parse(await this.rpc.request('account/rateLimits/read'))
  }

  async status(): Promise<AiProviderStatus> {
    const account = await this.read(false)
    if (!account.account) {
      return {
        availability: account.requiresOpenaiAuth ? 'auth_required' : 'offline',
        authMode: null,
        planType: null,
        message: account.requiresOpenaiAuth ? '需要登录 Codex' : 'Codex 尚未配置',
        retryAt: null,
      }
    }
    return {
      availability: 'ready',
      authMode: account.account.type === 'apiKey' ? 'api_key' : 'chatgpt',
      planType: account.account.planType ?? null,
      message: 'Codex 已连接',
      retryAt: null,
    }
  }
}
