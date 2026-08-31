import { z } from 'zod'

export const platformIdSchema = z.enum(['boss', 'zhilian', 'job51', 'liepin'])
export type PlatformId = z.infer<typeof platformIdSchema>

export interface PlatformCapabilities {
  collect: boolean
  inspectJob: boolean
  apply: boolean
  readInbox: boolean
  sendGreeting: boolean
  sendResume: boolean
  sendReply: boolean
}

export const PLATFORM_CAPABILITIES: Readonly<Record<PlatformId, PlatformCapabilities>> = {
  boss: {
    collect: true,
    inspectJob: true,
    apply: true,
    readInbox: true,
    sendGreeting: true,
    sendResume: true,
    sendReply: true,
  },
  zhilian: {
    collect: true,
    inspectJob: true,
    apply: false,
    readInbox: false,
    sendGreeting: false,
    sendResume: false,
    sendReply: false,
  },
  job51: {
    collect: true,
    inspectJob: true,
    apply: false,
    readInbox: false,
    sendGreeting: false,
    sendResume: false,
    sendReply: false,
  },
  liepin: {
    collect: true,
    inspectJob: true,
    apply: false,
    readInbox: false,
    sendGreeting: false,
    sendResume: false,
    sendReply: false,
  },
}

export const jobIdentitySchema = z.object({
  platform: platformIdSchema,
  accountId: z.string().min(1),
  platformJobId: z.string().min(1),
  canonicalUrl: z.string().url(),
  company: z.string().min(1),
  title: z.string().min(1),
})

export type JobIdentity = z.infer<typeof jobIdentitySchema>

export const externalActionKindSchema = z.enum([
  'apply',
  'send_greeting',
  'send_resume',
  'send_reply',
])
export type ExternalActionKind = z.infer<typeof externalActionKindSchema>

export const preparedActionSchema = z.object({
  actionId: z.string().uuid(),
  kind: externalActionKindSchema,
  target: jobIdentitySchema,
  recipientId: z.string().min(1).nullable(),
  body: z.string(),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  attachmentPath: z.string().nullable(),
  attachmentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  preparedAt: z.string().datetime(),
})

export type PreparedAction = z.infer<typeof preparedActionSchema>

export const actionAuthorizationSchema = z.object({
  authorizationId: z.string().uuid(),
  actionId: z.string().uuid(),
  accountId: z.string().min(1),
  platformJobId: z.string().min(1),
  recipientId: z.string().min(1).nullable(),
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  attachmentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  nonce: z.string().min(24),
  authorizedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  consumedAt: z.string().datetime().nullable(),
})

export type ActionAuthorization = z.infer<typeof actionAuthorizationSchema>

export type ActionOutcome =
  | {
      status: 'succeeded'
      receiptId: string
      observedAt: string
      evidence: Record<string, string>
    }
  | { status: 'failed'; code: string; message: string; retryable: boolean }
  | { status: 'outcome_unknown'; message: string; reconcileAfter: string }
  | { status: 'needs_user'; reason: 'captcha' | 'login' | 'risk' | 'platform_changed' }

export interface CollectionQuery {
  keywords: readonly string[]
  cityCodes: readonly string[]
  limit: number
  cursor: string | null
}

export interface CollectedJob {
  identity: JobIdentity
  salaryText: string | null
  description: string
  collectedAt: string
}

export interface CollectionPage {
  jobs: CollectedJob[]
  nextCursor: string | null
}

export interface PlatformHealth {
  status: 'ready' | 'login_required' | 'captcha' | 'risk' | 'platform_changed' | 'offline'
  accountId: string | null
  message: string
}

export interface PlatformAdapter {
  readonly id: PlatformId
  readonly capabilities: PlatformCapabilities
  health(): Promise<PlatformHealth>
  collect(query: CollectionQuery): Promise<CollectionPage>
  inspect(identity: JobIdentity): Promise<CollectedJob>
  execute(action: PreparedAction, authorization: ActionAuthorization): Promise<ActionOutcome>
  reconcile(action: PreparedAction): Promise<ActionOutcome>
}

export class ConnectorError extends Error {
  constructor(
    readonly code:
      | 'AUTH_REQUIRED'
      | 'PLATFORM_CHANGED'
      | 'CAPTCHA_REQUIRED'
      | 'SESSION_EXPIRED'
      | 'ACTION_OUTCOME_UNKNOWN'
      | 'DUPLICATE_ACTION'
      | 'IDENTITY_MISMATCH'
      | 'CAPABILITY_UNAVAILABLE'
      | 'AUTHORIZATION_INVALID',
    message: string,
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}
