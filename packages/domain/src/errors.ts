import { z } from 'zod'

import { JsonValueSchema, type JsonValue } from './common.js'

export const DomainErrorCodeSchema = z.enum([
  'AUTH_REQUIRED',
  'RATE_LIMITED',
  'QUOTA_EXHAUSTED',
  'PROTOCOL_INCOMPATIBLE',
  'OCR_REQUIRED',
  'FACTS_UNVERIFIED',
  'UNSUPPORTED_CLAIM',
  'PLATFORM_CHANGED',
  'CAPTCHA_REQUIRED',
  'SESSION_EXPIRED',
  'ACTION_OUTCOME_UNKNOWN',
  'DUPLICATE_ACTION',
  'BACKUP_CORRUPT',
  'MIGRATION_FAILED',
  'INVALID_TRANSITION',
  'AUTHORIZATION_INVALID',
  'AUTHORIZATION_EXPIRED',
  'AUTHORIZATION_CONSUMED',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'ENCRYPTION_REQUIRED',
  'INTERNAL',
])

export type DomainErrorCode = z.infer<typeof DomainErrorCodeSchema>

export const DomainIssueSchema = z
  .object({
    code: DomainErrorCodeSchema,
    message: z.string().min(1),
    details: z.record(z.string(), JsonValueSchema).optional(),
  })
  .strict()

export type DomainIssue = z.infer<typeof DomainIssueSchema>

export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainIssue }

export function success<T>(value: T): DomainResult<T> {
  return { ok: true, value }
}

export function failure(
  code: DomainErrorCode,
  message: string,
  details?: Readonly<Record<string, JsonValue>>,
): DomainResult<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details: { ...details } }),
    },
  }
}

export class DomainInvariantError extends Error {
  readonly code: DomainErrorCode
  readonly details: Readonly<Record<string, JsonValue>> | undefined

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, JsonValue>>,
  ) {
    super(message)
    this.name = 'DomainInvariantError'
    this.code = code
    this.details = details
  }
}
