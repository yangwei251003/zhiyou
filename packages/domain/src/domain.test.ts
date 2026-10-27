import { describe, expect, it } from 'vitest'

import {
  ActionAuthorizationSchema,
  DomainEntitySchemaMap,
  EvidenceRevisionSchema,
  assertResumeClaimSupported,
  canAutomaticallyRetryExternalAction,
  createActionAuthorization,
  sha256Text,
  transitionAiConnectionState,
  transitionApplicationStatus,
  transitionDocumentStatus,
  transitionExternalActionStatus,
  transitionFactStatus,
  validateActionAuthorization,
  type EvidenceFact,
  type EvidenceRevision,
  type ExternalAction,
  type ResumeClaim,
} from './index.js'

const now = '2026-08-31T00:00:00.000Z'
const later = '2026-08-31T00:10:00.000Z'
const hash = sha256Text('fixture')

function pendingAction(): ExternalAction {
  return {
    id: 'action-1',
    workspaceId: 'workspace-1',
    type: 'send_reply',
    target: {
      platform: 'boss',
      accountId: 'account-1',
      jobSnapshotId: 'job-1',
      recipientId: 'recipient-1',
    },
    bodySha256: sha256Text('hello'),
    attachmentSha256s: [sha256Text('resume')],
    idempotencyKey: 'once-1',
    status: 'awaiting_review',
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

describe('strict domain schemas', () => {
  it('publishes every planned domain entity schema', () => {
    expect(Object.keys(DomainEntitySchemaMap)).toHaveLength(25)
    expect(
      DomainEntitySchemaMap.workspace.parse({
        id: 'workspace-1',
        name: 'My career vault',
        locale: 'zh-CN',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      }),
    ).toMatchObject({ id: 'workspace-1' })
  })

  it('rejects unknown fields and incomplete verification metadata', () => {
    expect(() =>
      DomainEntitySchemaMap.workspace.parse({
        id: 'workspace-1',
        name: 'Vault',
        locale: 'zh-CN',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        ignored: true,
      }),
    ).toThrow()
    expect(
      EvidenceRevisionSchema.safeParse({
        id: 'revision-1',
        workspaceId: 'workspace-1',
        factId: 'fact-1',
        version: 1,
        claim: 'Built a student project.',
        structuredData: {},
        status: 'verified',
        sources: [],
        createdBy: 'user',
        createdAt: now,
      }).success,
    ).toBe(false)
  })
})

describe('state machines', () => {
  it('accepts intended progress and rejects unsafe skips', () => {
    expect(transitionDocumentStatus('queued', 'parsing')).toEqual({ ok: true, value: 'parsing' })
    expect(transitionFactStatus('proposed', 'verified').ok).toBe(true)
    expect(transitionApplicationStatus('ready_to_apply', 'applied').ok).toBe(true)
    expect(transitionAiConnectionState('startup', 'ready').ok).toBe(true)

    const skipped = transitionApplicationStatus('discovered', 'applied')
    expect(skipped.ok).toBe(false)
    if (!skipped.ok) expect(skipped.error.code).toBe('INVALID_TRANSITION')
  })

  it('never permits an unknown external outcome to execute again', () => {
    const transition = transitionExternalActionStatus('outcome_unknown', 'executing')
    expect(transition.ok).toBe(false)
    expect(
      canAutomaticallyRetryExternalAction({
        ...pendingAction(),
        status: 'outcome_unknown',
      }),
    ).toBe(false)
  })
})

describe('evidence-bound resume claims', () => {
  const revision: EvidenceRevision = {
    id: 'revision-1',
    workspaceId: 'workspace-1',
    factId: 'fact-1',
    version: 1,
    claim: 'Reduced processing time by 30%.',
    structuredData: { percentage: 30 },
    status: 'verified',
    sources: [],
    createdBy: 'user',
    createdAt: now,
    verifiedAt: now,
    verifiedBy: 'user',
  }
  const fact: EvidenceFact = {
    id: 'fact-1',
    workspaceId: 'workspace-1',
    category: 'metric',
    title: 'Processing improvement',
    status: 'verified',
    currentRevisionId: revision.id,
    sensitivity: 'standard',
    permissions: { aiAllowed: true, resumeAllowed: true, shareAllowed: false },
    createdAt: now,
    updatedAt: now,
  }
  const claim: ResumeClaim = {
    id: 'claim-1',
    workspaceId: 'workspace-1',
    resumeVersionId: 'resume-version-1',
    section: 'experience',
    ordinal: 0,
    text: 'Improved the workflow and reduced processing time by 30%.',
    factId: fact.id,
    evidenceRevisionId: revision.id,
    createdAt: now,
  }

  it('accepts only the current verified revision with resume permission', () => {
    expect(assertResumeClaimSupported(claim, fact, revision).ok).toBe(true)

    const unverifiedRevision: EvidenceRevision = {
      id: revision.id,
      workspaceId: revision.workspaceId,
      factId: revision.factId,
      version: revision.version,
      claim: revision.claim,
      structuredData: revision.structuredData,
      sources: revision.sources,
      createdBy: revision.createdBy,
      createdAt: revision.createdAt,
      status: 'proposed',
    }
    const unverified = assertResumeClaimSupported(claim, fact, unverifiedRevision)
    expect(unverified.ok).toBe(false)
    if (!unverified.ok) expect(unverified.error.code).toBe('FACTS_UNVERIFIED')

    const disallowed = assertResumeClaimSupported(
      claim,
      { ...fact, permissions: { ...fact.permissions, resumeAllowed: false } },
      revision,
    )
    expect(disallowed.ok).toBe(false)
    if (!disallowed.ok) expect(disallowed.error.code).toBe('UNSUPPORTED_CLAIM')
  })
})

describe('one-time external-action authorization', () => {
  it('binds the exact target, body, attachments, and nonce', () => {
    const action = pendingAction()
    const created = createActionAuthorization(action, {
      id: 'authorization-1',
      nonce: 'nonce-1',
      authorizedAt: now,
      expiresAt: later,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(ActionAuthorizationSchema.parse(created.value).bindingSha256).toMatch(/^[a-f0-9]{64}$/)

    const authorizedAction: ExternalAction = {
      ...action,
      status: 'authorized',
      authorizationId: created.value.id,
    }
    expect(validateActionAuthorization(authorizedAction, created.value, now).ok).toBe(true)

    const changedBody = validateActionAuthorization(
      { ...authorizedAction, bodySha256: sha256Text('changed') },
      created.value,
      now,
    )
    expect(changedBody.ok).toBe(false)
    if (!changedBody.ok) expect(changedBody.error.code).toBe('AUTHORIZATION_INVALID')

    const changedRecipient = validateActionAuthorization(
      {
        ...authorizedAction,
        target: { ...authorizedAction.target, recipientId: 'different-recipient' },
      },
      created.value,
      now,
    )
    expect(changedRecipient.ok).toBe(false)

    const changedAttachments = validateActionAuthorization(
      {
        ...authorizedAction,
        attachmentSha256s: [...authorizedAction.attachmentSha256s, sha256Text('portfolio')],
      },
      created.value,
      now,
    )
    expect(changedAttachments.ok).toBe(false)

    const changedWorkspace = validateActionAuthorization(
      { ...authorizedAction, workspaceId: 'another-workspace' },
      created.value,
      now,
    )
    expect(changedWorkspace.ok).toBe(false)
  })

  it('rejects expired and consumed authorizations', () => {
    const action = pendingAction()
    const created = createActionAuthorization(action, {
      id: 'authorization-1',
      nonce: 'nonce-1',
      authorizedAt: now,
      expiresAt: later,
    })
    if (!created.ok) throw new Error('fixture authorization failed')
    const authorizedAction = {
      ...action,
      status: 'authorized' as const,
      authorizationId: created.value.id,
    }

    const expired = validateActionAuthorization(
      authorizedAction,
      created.value,
      '2026-08-31T00:11:00.000Z',
    )
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.error.code).toBe('AUTHORIZATION_EXPIRED')

    const consumed = validateActionAuthorization(
      authorizedAction,
      { ...created.value, consumedAt: '2026-08-31T00:01:00.000Z' },
      '2026-08-31T00:02:00.000Z',
    )
    expect(consumed.ok).toBe(false)
    if (!consumed.ok) expect(consumed.error.code).toBe('AUTHORIZATION_CONSUMED')
  })

  it('keeps fixture digests stable', () => {
    expect(hash).toHaveLength(64)
  })
})
