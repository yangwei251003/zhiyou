import type {
  AiConnectionState,
  ApplicationStatus,
  DocumentStatus,
  ExternalActionStatus,
  FactStatus,
} from './models.js'
import type { DomainResult } from './errors.js'
import { failure, success } from './errors.js'

type TransitionGraph<State extends string> = Readonly<Record<State, ReadonlySet<State>>>

function transition<State extends string>(
  machine: string,
  graph: TransitionGraph<State>,
  from: State,
  to: State,
): DomainResult<State> {
  if (from === to) return success(to)
  if (graph[from].has(to)) return success(to)
  return failure('INVALID_TRANSITION', `${machine} cannot transition from ${from} to ${to}`, {
    machine,
    from,
    to,
  })
}

const documentTransitions: TransitionGraph<DocumentStatus> = {
  queued: new Set(['parsing']),
  parsing: new Set(['needs_ocr', 'review', 'failed']),
  needs_ocr: new Set(['parsing', 'failed']),
  review: new Set(['completed', 'failed']),
  completed: new Set(),
  failed: new Set(['queued']),
}

const factTransitions: TransitionGraph<FactStatus> = {
  proposed: new Set(['verified', 'disputed', 'deleted']),
  verified: new Set(['disputed', 'superseded', 'deleted']),
  disputed: new Set(['verified', 'superseded', 'deleted']),
  superseded: new Set(['deleted']),
  deleted: new Set(),
}

const externalActionTransitions: TransitionGraph<ExternalActionStatus> = {
  draft: new Set(['awaiting_review']),
  awaiting_review: new Set(['draft', 'authorized', 'needs_user']),
  authorized: new Set(['executing', 'draft', 'needs_user']),
  executing: new Set(['succeeded', 'failed', 'outcome_unknown', 'needs_user']),
  succeeded: new Set(),
  failed: new Set(['awaiting_review', 'needs_user']),
  outcome_unknown: new Set(['needs_user', 'succeeded', 'failed']),
  needs_user: new Set(['draft', 'awaiting_review', 'succeeded', 'failed', 'outcome_unknown']),
}

const applicationTransitions: TransitionGraph<ApplicationStatus> = {
  discovered: new Set(['analyzed', 'withdrawn']),
  analyzed: new Set(['shortlisted', 'rejected', 'withdrawn']),
  shortlisted: new Set(['tailored', 'rejected', 'withdrawn']),
  tailored: new Set(['shortlisted', 'ready_to_apply', 'withdrawn']),
  ready_to_apply: new Set(['tailored', 'applied', 'withdrawn']),
  applied: new Set(['interviewing', 'rejected', 'withdrawn']),
  interviewing: new Set(['offer', 'rejected', 'withdrawn']),
  offer: new Set(['withdrawn']),
  rejected: new Set(),
  withdrawn: new Set(),
}

const aiTransitions: TransitionGraph<AiConnectionState> = {
  not_installed: new Set(['startup']),
  startup: new Set(['auth_required', 'ready', 'incompatible', 'offline', 'crashed']),
  auth_required: new Set(['startup', 'ready', 'offline', 'incompatible']),
  ready: new Set(['auth_required', 'rate_limited', 'incompatible', 'offline', 'crashed']),
  rate_limited: new Set(['ready', 'auth_required', 'offline', 'crashed']),
  incompatible: new Set(['startup', 'not_installed']),
  offline: new Set(['startup', 'not_installed']),
  crashed: new Set(['startup', 'not_installed']),
}

export function transitionDocumentStatus(
  from: DocumentStatus,
  to: DocumentStatus,
): DomainResult<DocumentStatus> {
  return transition('document', documentTransitions, from, to)
}

export function transitionFactStatus(from: FactStatus, to: FactStatus): DomainResult<FactStatus> {
  return transition('fact', factTransitions, from, to)
}

export function transitionExternalActionStatus(
  from: ExternalActionStatus,
  to: ExternalActionStatus,
): DomainResult<ExternalActionStatus> {
  return transition('external_action', externalActionTransitions, from, to)
}

export function transitionApplicationStatus(
  from: ApplicationStatus,
  to: ApplicationStatus,
): DomainResult<ApplicationStatus> {
  return transition('application', applicationTransitions, from, to)
}

export function transitionAiConnectionState(
  from: AiConnectionState,
  to: AiConnectionState,
): DomainResult<AiConnectionState> {
  return transition('ai_connection', aiTransitions, from, to)
}
