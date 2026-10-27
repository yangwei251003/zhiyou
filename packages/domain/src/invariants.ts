import { createHash, timingSafeEqual } from 'node:crypto'

import type { DomainResult } from './errors.js'
import { failure, success } from './errors.js'
import {
  ActionAuthorizationSchema,
  type ActionAuthorization,
  type EvidenceFact,
  type EvidenceRevision,
  type ExternalAction,
  type ExternalActionTarget,
  type ResumeClaim,
} from './models.js'

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function canonicalAttachmentHashes(hashes: readonly string[]): string[] {
  return hashes.map((hash) => hash.toLowerCase()).sort()
}

function canonicalTarget(target: ExternalActionTarget): Record<string, string | null> {
  return {
    platform: target.platform,
    accountId: target.accountId,
    jobSnapshotId: target.jobSnapshotId,
    recipientId: target.recipientId ?? null,
  }
}

export function authorizationBindingSha256(input: {
  workspaceId: string
  externalActionId: string
  target: ExternalActionTarget
  bodySha256: string
  attachmentSha256s: readonly string[]
  nonce: string
}): string {
  return sha256Text(
    JSON.stringify({
      workspaceId: input.workspaceId,
      externalActionId: input.externalActionId,
      target: canonicalTarget(input.target),
      bodySha256: input.bodySha256.toLowerCase(),
      attachmentSha256s: canonicalAttachmentHashes(input.attachmentSha256s),
      nonce: input.nonce,
    }),
  )
}

export function createActionAuthorization(
  action: ExternalAction,
  input: {
    id: string
    nonce: string
    authorizedAt: string
    expiresAt: string
  },
): DomainResult<ActionAuthorization> {
  if (action.status !== 'awaiting_review') {
    return failure(
      'AUTHORIZATION_INVALID',
      'Only an action awaiting explicit review can be authorized',
      { actionId: action.id, status: action.status },
    )
  }

  if (Date.parse(input.expiresAt) <= Date.parse(input.authorizedAt)) {
    return failure('AUTHORIZATION_INVALID', 'Authorization expiry must be after authorization time')
  }

  const candidate = {
    id: input.id,
    workspaceId: action.workspaceId,
    externalActionId: action.id,
    target: action.target,
    bodySha256: action.bodySha256.toLowerCase(),
    attachmentSha256s: canonicalAttachmentHashes(action.attachmentSha256s),
    bindingSha256: authorizationBindingSha256({
      workspaceId: action.workspaceId,
      externalActionId: action.id,
      target: action.target,
      bodySha256: action.bodySha256,
      attachmentSha256s: action.attachmentSha256s,
      nonce: input.nonce,
    }),
    nonce: input.nonce,
    authorizedBy: 'user' as const,
    authorizedAt: input.authorizedAt,
    expiresAt: input.expiresAt,
  }
  const parsed = ActionAuthorizationSchema.safeParse(candidate)
  if (!parsed.success) {
    return failure('VALIDATION_FAILED', 'Authorization data is invalid', {
      issues: parsed.error.issues.map((issue) => issue.message).join('; '),
    })
  }
  return success(parsed.data)
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function validateActionAuthorization(
  action: ExternalAction,
  authorization: ActionAuthorization,
  now: string,
): DomainResult<ActionAuthorization> {
  if (authorization.consumedAt !== undefined) {
    return failure('AUTHORIZATION_CONSUMED', 'This one-time authorization has already been used', {
      authorizationId: authorization.id,
    })
  }
  if (
    action.workspaceId !== authorization.workspaceId ||
    action.id !== authorization.externalActionId
  ) {
    return failure('AUTHORIZATION_INVALID', 'The authorization belongs to another action', {
      actionId: action.id,
      authorizationId: authorization.id,
    })
  }
  if (Date.parse(now) >= Date.parse(authorization.expiresAt)) {
    return failure('AUTHORIZATION_EXPIRED', 'This authorization has expired', {
      authorizationId: authorization.id,
    })
  }
  if (action.status !== 'authorized' || action.authorizationId !== authorization.id) {
    return failure('AUTHORIZATION_INVALID', 'The action is not bound to this authorization', {
      actionId: action.id,
      authorizationId: authorization.id,
    })
  }
  const expected = authorizationBindingSha256({
    workspaceId: action.workspaceId,
    externalActionId: action.id,
    target: action.target,
    bodySha256: action.bodySha256,
    attachmentSha256s: action.attachmentSha256s,
    nonce: authorization.nonce,
  })
  if (!constantTimeHexEqual(expected, authorization.bindingSha256)) {
    return failure(
      'AUTHORIZATION_INVALID',
      'The target, message body, or attachments changed after authorization',
      { actionId: action.id, authorizationId: authorization.id },
    )
  }
  return success(authorization)
}

export function consumeActionAuthorization(
  authorization: ActionAuthorization,
  consumedAt: string,
): DomainResult<ActionAuthorization> {
  if (authorization.consumedAt !== undefined) {
    return failure('AUTHORIZATION_CONSUMED', 'This one-time authorization has already been used')
  }
  if (Date.parse(consumedAt) < Date.parse(authorization.authorizedAt)) {
    return failure('AUTHORIZATION_INVALID', 'Consumption cannot predate authorization')
  }
  return success({ ...authorization, consumedAt })
}

export function canAutomaticallyRetryExternalAction(action: ExternalAction): boolean {
  if (action.status === 'outcome_unknown') return false
  return action.status === 'failed'
}

export function assertResumeClaimSupported(
  claim: ResumeClaim,
  fact: EvidenceFact,
  revision: EvidenceRevision,
): DomainResult<ResumeClaim> {
  if (
    claim.workspaceId !== fact.workspaceId ||
    claim.workspaceId !== revision.workspaceId ||
    claim.factId !== fact.id ||
    claim.evidenceRevisionId !== revision.id ||
    revision.factId !== fact.id
  ) {
    return failure('UNSUPPORTED_CLAIM', 'Resume claim evidence references do not agree', {
      claimId: claim.id,
    })
  }
  if (
    fact.status !== 'verified' ||
    revision.status !== 'verified' ||
    fact.currentRevisionId !== revision.id
  ) {
    return failure(
      'FACTS_UNVERIFIED',
      'Resume claims require the current verified evidence revision',
      {
        claimId: claim.id,
        factId: fact.id,
        revisionId: revision.id,
      },
    )
  }
  if (!fact.permissions.resumeAllowed) {
    return failure('UNSUPPORTED_CLAIM', 'This fact is not allowed to appear in a resume', {
      claimId: claim.id,
      factId: fact.id,
    })
  }
  return success(claim)
}

export function validateResumeClaims(
  claims: readonly ResumeClaim[],
  factsById: ReadonlyMap<string, EvidenceFact>,
  revisionsById: ReadonlyMap<string, EvidenceRevision>,
): DomainResult<readonly ResumeClaim[]> {
  for (const claim of claims) {
    const fact = factsById.get(claim.factId)
    const revision = revisionsById.get(claim.evidenceRevisionId)
    if (fact === undefined || revision === undefined) {
      return failure('UNSUPPORTED_CLAIM', 'Resume claim has missing evidence', {
        claimId: claim.id,
      })
    }
    const result = assertResumeClaimSupported(claim, fact, revision)
    if (!result.ok) return result
  }
  return success(claims)
}
