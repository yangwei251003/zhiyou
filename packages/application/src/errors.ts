import { AiProviderError } from '@bosshunter/ai'
import { ConnectorError } from '@bosshunter/connectors'
import { DomainInvariantError } from '@bosshunter/domain'
import { StorageError } from '@bosshunter/storage'
import { ZodError } from 'zod'

export type ApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'WORKSPACE_MISMATCH'
  | 'CONSENT_REQUIRED'
  | 'AI_DATA_NOT_ALLOWED'
  | 'AI_PAYLOAD_TOO_LARGE'
  | 'AI_FAILED'
  | 'AI_OUTPUT_INVALID'
  | 'FACT_NOT_VERIFIED'
  | 'RESUME_INVALID'
  | 'RESUME_MUTATED'
  | 'CONNECTOR_UNAVAILABLE'
  | 'AUTHORIZATION_INVALID'
  | 'ACTION_OUTCOME_UNKNOWN'
  | 'DUPLICATE_ACTION'
  | 'STORAGE_FAILED'
  | 'INTERNAL'

const defaultUserMessages: Readonly<Record<ApplicationErrorCode, string>> = {
  INVALID_INPUT: '提交的信息不完整或格式不正确，请检查后重试。',
  NOT_FOUND: '没有找到需要的资料，它可能已被删除。',
  CONFLICT: '当前状态已经发生变化，请刷新后重试。',
  WORKSPACE_MISMATCH: '这些资料不属于当前职业档案。',
  CONSENT_REQUIRED: '需要你确认本次发送给 AI 的资料清单。',
  AI_DATA_NOT_ALLOWED: '所选资料中有内容未获准发送给 AI。',
  AI_PAYLOAD_TOO_LARGE: '本次资料超过安全上下文预算，请拆分文件或缩小选择范围后重试。',
  AI_FAILED: 'AI 暂时无法完成这一步，资料已经安全保留。',
  AI_OUTPUT_INVALID: 'AI 返回的结果未通过事实安全检查，请重新生成。',
  FACT_NOT_VERIFIED: '简历只能使用你已经核验过的事实。',
  RESUME_INVALID: '简历中仍有缺少依据的内容，请先处理标记项。',
  RESUME_MUTATED: '简历在核验后发生了变化，请重新核验。',
  CONNECTOR_UNAVAILABLE: '当前招聘平台暂时无法执行这个操作。',
  AUTHORIZATION_INVALID: '本次确认已经过期或内容发生变化，请重新确认。',
  ACTION_OUTCOME_UNKNOWN: '平台结果暂时无法确认，系统不会自动重试，请先对账。',
  DUPLICATE_ACTION: '这项操作已经执行或正在等待结果，不会重复发送。',
  STORAGE_FAILED: '本地职业档案暂时无法访问，请检查磁盘后重试。',
  INTERNAL: '发生了未预期的问题，未执行任何新的外部操作。',
}

export class ApplicationError extends Error {
  readonly userMessage: string

  constructor(
    readonly code: ApplicationErrorCode,
    message: string,
    options: {
      userMessage?: string
      details?: Readonly<Record<string, unknown>>
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApplicationError'
    this.userMessage = options.userMessage ?? defaultUserMessages[code]
    this.details = options.details
  }

  readonly details: Readonly<Record<string, unknown>> | undefined
}

export interface PresentedApplicationError {
  readonly code: ApplicationErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

export function toApplicationError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error
  if (error instanceof ZodError) {
    return new ApplicationError('INVALID_INPUT', 'Input validation failed', {
      details: { issues: error.issues.map((issue) => issue.message) },
      cause: error,
    })
  }
  if (error instanceof AiProviderError) {
    const code =
      error.code === 'OUTPUT_INVALID'
        ? 'AI_OUTPUT_INVALID'
        : error.code === 'PAYLOAD_TOO_LARGE'
          ? 'AI_PAYLOAD_TOO_LARGE'
          : 'AI_FAILED'
    return new ApplicationError(code, error.message, {
      details: { providerCode: error.code, retryAt: error.retryAt },
      cause: error,
    })
  }
  if (error instanceof ConnectorError) {
    const code: ApplicationErrorCode =
      error.code === 'ACTION_OUTCOME_UNKNOWN'
        ? 'ACTION_OUTCOME_UNKNOWN'
        : error.code === 'DUPLICATE_ACTION'
          ? 'DUPLICATE_ACTION'
          : error.code === 'AUTHORIZATION_INVALID'
            ? 'AUTHORIZATION_INVALID'
            : 'CONNECTOR_UNAVAILABLE'
    return new ApplicationError(code, error.message, {
      details: { connectorCode: error.code },
      cause: error,
    })
  }
  if (error instanceof StorageError) {
    return new ApplicationError('STORAGE_FAILED', error.message, {
      details: { storageCode: error.code },
      cause: error,
    })
  }
  if (error instanceof DomainInvariantError) {
    return new ApplicationError('CONFLICT', error.message, {
      details: { domainCode: error.code },
      cause: error,
    })
  }
  return new ApplicationError(
    'INTERNAL',
    error instanceof Error ? error.message : 'Unknown error',
    {
      cause: error,
    },
  )
}

export function presentApplicationError(error: unknown): PresentedApplicationError {
  const applicationError = toApplicationError(error)
  const retryable = new Set<ApplicationErrorCode>([
    'AI_FAILED',
    'CONNECTOR_UNAVAILABLE',
    'STORAGE_FAILED',
  ]).has(applicationError.code)
  return {
    code: applicationError.code,
    message: applicationError.userMessage,
    retryable,
    ...(applicationError.details === undefined ? {} : { details: applicationError.details }),
  }
}
