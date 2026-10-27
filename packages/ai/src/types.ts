import type { ZodType } from 'zod'

export type AiOperation =
  | 'extract_fact_proposals'
  | 'next_interview_question'
  | 'decompose_job'
  | 'match_evidence'
  | 'rewrite_resume_claims'
  | 'draft_recruiter_reply'
  | 'create_learning_plan'

export type AiAvailability =
  | 'not_installed'
  | 'startup'
  | 'auth_required'
  | 'ready'
  | 'rate_limited'
  | 'incompatible'
  | 'offline'
  | 'crashed'

export interface AiProviderStatus {
  availability: AiAvailability
  authMode: 'chatgpt' | 'api_key' | null
  planType: string | null
  message: string
  retryAt: number | null
}

export interface AiContextItem {
  id: string
  kind: 'verified_fact' | 'source_excerpt' | 'job_requirement' | 'conversation_message'
  content: string
  trusted: boolean
  aiAllowed: boolean
}

export interface AiRequest<T> {
  operation: AiOperation
  instructions: string
  context: readonly AiContextItem[]
  outputSchema: ZodType<T>
  signal?: AbortSignal
}

export interface AiRunResult<T> {
  value: T
  provider: string
  model: string | null
  requestId: string
  startedAt: string
  completedAt: string
}

export interface AiProvider {
  readonly id: string
  getStatus(): Promise<AiProviderStatus>
  run<T>(request: AiRequest<T>): Promise<AiRunResult<T>>
}

export class AiProviderError extends Error {
  constructor(
    readonly code:
      | 'AUTH_REQUIRED'
      | 'RATE_LIMITED'
      | 'QUOTA_EXHAUSTED'
      | 'PAYLOAD_TOO_LARGE'
      | 'OUTCOME_UNKNOWN'
      | 'PROTOCOL_INCOMPATIBLE'
      | 'OUTPUT_INVALID'
      | 'TOOL_REQUEST_REJECTED'
      | 'CANCELLED'
      | 'OFFLINE'
      | 'INTERNAL',
    message: string,
    readonly retryAt: number | null = null,
  ) {
    super(message)
    this.name = 'AiProviderError'
  }
}
