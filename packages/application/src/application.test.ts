import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MockAiProvider } from '@bosshunter/ai'
import { MockPlatformAdapter, type ActionOutcome } from '@bosshunter/connectors'
import { sha256Text, type DocumentFragment, type SourceDocument } from '@bosshunter/domain'
import { resumeDocumentSchema } from '@bosshunter/resume'
import { Aes256GcmCodec, SingleWriterStorage, type StorageFaultEvent } from '@bosshunter/storage'
import { afterEach, describe, expect, it } from 'vitest'

import { ApplicationError, CareerApplication } from './index.js'

const now = new Date('2026-08-31T00:00:00.000Z')
const directories: string[] = []
const storages: SingleWriterStorage[] = []

interface Harness {
  readonly application: CareerApplication
  readonly storage: SingleWriterStorage
  readonly filename: string
  readonly connector: MockPlatformAdapter
  readonly aiCalls: string[]
}

function proposal(claim: string) {
  return {
    category: 'project' as const,
    title: 'Verified project result',
    proposedClaim: claim,
    proposedStructuredData: {
      allowedNumbers: ['30%'],
      allowedSkills: ['TypeScript'],
    },
    sources: [
      {
        documentId: 'document-1',
        fragmentId: 'fragment-1',
        quote: claim,
      },
    ],
    confidence: 0.82,
    conflictsWithFactIds: [],
    rationale: 'The excerpt contains a concrete project result.',
  }
}

function createHarness(
  options: {
    proposalClaim?: string
    responder?: (operation: string) => unknown
    outcome?: ActionOutcome
    storageFaultInjector?: (event: StorageFaultEvent) => void
  } = {},
): Harness {
  const directory = mkdtempSync(join(tmpdir(), 'bosshunter-application-test-'))
  directories.push(directory)
  const filename = join(directory, 'vault.sqlite3')
  const storage = SingleWriterStorage.open(filename, {
    codec: new Aes256GcmCodec(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    ...(options.storageFaultInjector === undefined
      ? {}
      : { faultInjector: options.storageFaultInjector }),
  })
  storages.push(storage)
  const aiCalls: string[] = []
  const claim =
    options.proposalClaim ?? 'Built a TypeScript service and improved throughput by 30%.'
  const ai = new MockAiProvider((operation) => {
    aiCalls.push(operation)
    if (options.responder !== undefined) return options.responder(operation)
    if (operation === 'extract_fact_proposals') return [proposal(claim)]
    if (operation === 'next_interview_question') {
      return {
        question: 'What did you personally change?',
        rationale: 'The action is not yet specific.',
        targetFactIds: [],
        factProposals: [
          {
            category: 'experience',
            title: 'Interview answer',
            proposedClaim: 'Coordinated a three-person student team.',
            proposedStructuredData: {},
            sources: [],
            confidence: 0.6,
            conflictsWithFactIds: [],
          },
        ],
      }
    }
    if (operation === 'decompose_job') {
      return [
        {
          category: 'must_have',
          text: 'TypeScript',
          normalizedKey: 'TypeScript',
          priority: 5,
          sourceStart: 0,
          sourceEnd: 10,
        },
      ]
    }
    throw new Error(`Unexpected AI operation ${operation}`)
  })
  const connector = new MockPlatformAdapter(
    'boss',
    { status: 'ready', accountId: 'account-1', message: 'Ready' },
    [],
    options.outcome,
  )
  let idCounter = 0
  const application = new CareerApplication({
    storage,
    aiProvider: ai,
    connectors: [connector],
    clock: () => new Date(now),
    idFactory: (scope) => `${scope}-${++idCounter}`,
  })
  application.initializeWorkspace({
    workspaceId: 'workspace-1',
    profileId: 'profile-1',
    name: 'Career vault',
    locale: 'zh-CN',
    displayName: '测试用户',
    email: 'candidate@example.com',
    targetRoles: ['Frontend engineer'],
    languages: ['Chinese', 'English'],
  })
  return { application, storage, filename, connector, aiCalls }
}

function importedDocument(): { document: SourceDocument; fragments: DocumentFragment[] } {
  const claim = 'Built a TypeScript service and improved throughput by 30%.'
  return {
    document: {
      id: 'document-1',
      workspaceId: 'workspace-1',
      kind: 'resume',
      originalName: 'resume.pdf',
      mimeType: 'application/pdf',
      byteSize: 2_048,
      sha256: sha256Text('source-file'),
      encryptedStorageKey: 'vault/document-1',
      status: 'completed',
      pageCount: 1,
      requiresOcr: false,
      importedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    fragments: [
      {
        id: 'fragment-1',
        workspaceId: 'workspace-1',
        documentId: 'document-1',
        ordinal: 0,
        page: 1,
        text: claim,
        sha256: sha256Text(claim),
        createdAt: now.toISOString(),
      },
    ],
  }
}

async function expectApplicationError(
  operation: () => unknown,
  code: ApplicationError['code'],
): Promise<void> {
  let caught: unknown
  try {
    await operation()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(ApplicationError)
  if (!(caught instanceof ApplicationError)) throw new Error('Expected ApplicationError')
  expect(caught.code).toBe(code)
  expect(caught.userMessage.length).toBeGreaterThan(0)
}

async function seedVerifiedFact(
  harness: Harness,
  permissions = { aiAllowed: true, resumeAllowed: true, shareAllowed: false },
) {
  const imported = importedDocument()
  harness.application.importParsedDocument({ workspaceId: 'workspace-1', ...imported })
  const proposals = await harness.application.proposeFactsForDocument({
    workspaceId: 'workspace-1',
    documentId: imported.document.id,
    consent: { confirmed: true, dataItemIds: ['fragment-1'] },
  })
  return harness.application.acceptFactProposal({
    workspaceId: 'workspace-1',
    proposalId: proposals[0]?.id,
    permissions,
    sensitivity: 'standard',
  })
}

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('workspace and evidence orchestration', () => {
  it('rejects aggregate fragment text above the shared ingestion budget', () => {
    const harness = createHarness()
    const imported = importedDocument()
    const text = 'x'.repeat(8_000)
    const fragments: DocumentFragment[] = Array.from({ length: 251 }, (_, ordinal) => ({
      id: `oversized-fragment-${ordinal}`,
      workspaceId: 'workspace-1',
      documentId: imported.document.id,
      ordinal,
      page: 1,
      text,
      sha256: sha256Text(text),
      createdAt: now.toISOString(),
    }))

    let rejection: unknown
    try {
      harness.application.importParsedDocument({
        workspaceId: 'workspace-1',
        document: imported.document,
        fragments,
      })
    } catch (error) {
      rejection = error
    }
    expect(rejection).toMatchObject({ code: 'INVALID_INPUT' })
    expect(harness.storage.list('source_document', 'workspace-1')).toHaveLength(0)
    expect(harness.storage.list('document_fragment', 'workspace-1')).toHaveLength(0)
  })

  it('stores an import locally before optional AI extraction and deduplicates retries', async () => {
    const harness = createHarness()
    const imported = importedDocument()
    harness.application.importParsedDocument({ workspaceId: 'workspace-1', ...imported })

    expect(harness.aiCalls).toEqual([])
    expect(harness.storage.get('source_document', 'document-1')).toEqual(imported.document)
    expect(harness.storage.count('evidence_fact', 'workspace-1')).toBe(0)

    const first = await harness.application.proposeFactsForDocument({
      workspaceId: 'workspace-1',
      documentId: 'document-1',
      consent: { confirmed: true, dataItemIds: ['fragment-1'] },
    })
    const repeated = await harness.application.proposeFactsForDocument({
      workspaceId: 'workspace-1',
      documentId: 'document-1',
      consent: { confirmed: true, dataItemIds: ['fragment-1'] },
    })
    expect(repeated[0]?.id).toBe(first[0]?.id)
    expect(harness.storage.count('fact_proposal', 'workspace-1')).toBe(1)
    expect(harness.storage.count('evidence_fact', 'workspace-1')).toBe(0)

    const accepted = harness.application.acceptFactProposal({
      workspaceId: 'workspace-1',
      proposalId: first[0]?.id,
      permissions: { aiAllowed: true, resumeAllowed: true, shareAllowed: false },
      sensitivity: 'standard',
    })
    expect(accepted.fact.status).toBe('verified')
    expect(accepted.revision.status).toBe('verified')
    expect(harness.application.loadWorkspace({ workspaceId: 'workspace-1' }).counts).toMatchObject({
      sourceDocuments: 1,
      pendingFactProposals: 0,
      verifiedFacts: 1,
    })
    await expectApplicationError(
      () =>
        harness.application.acceptFactProposal({
          workspaceId: 'workspace-1',
          proposalId: first[0]?.id,
          permissions: { aiAllowed: true, resumeAllowed: true, shareAllowed: false },
          sensitivity: 'standard',
        }),
      'CONFLICT',
    )
  })

  it('never promotes model-hidden structured allowlists into verified evidence', async () => {
    const harness = createHarness({
      responder: (operation) => {
        if (operation !== 'extract_fact_proposals') throw new Error('Unexpected operation')
        return [
          {
            ...proposal('Built a TypeScript service and improved throughput by 30%.'),
            proposedStructuredData: {
              allowedNumbers: ['999%'],
              allowedDates: ['2029'],
              allowedEntities: ['Google'],
              allowedSkills: ['Rust'],
              harmlessModelNote: 'untrusted metadata',
            },
          },
        ]
      },
    })
    const accepted = await seedVerifiedFact(harness)

    expect(accepted.revision.structuredData).toMatchObject({
      allowedNumbers: ['30%'],
      allowedDates: [],
      allowedEntities: [],
      allowedSkills: [],
    })
    expect(accepted.revision.structuredData).not.toMatchObject({ allowedNumbers: ['999%'] })
    expect(accepted.revision.structuredData).not.toHaveProperty('harmlessModelNote')
  })

  it('rejects a caller that tries to smuggle hidden structured fields through acceptance', async () => {
    const harness = createHarness()
    const imported = importedDocument()
    harness.application.importParsedDocument({ workspaceId: 'workspace-1', ...imported })
    const proposals = await harness.application.proposeFactsForDocument({
      workspaceId: 'workspace-1',
      documentId: imported.document.id,
      consent: { confirmed: true, dataItemIds: ['fragment-1'] },
    })

    await expectApplicationError(
      () =>
        harness.application.acceptFactProposal({
          workspaceId: 'workspace-1',
          proposalId: proposals[0]?.id,
          permissions: { aiAllowed: true, resumeAllowed: true, shareAllowed: false },
          sensitivity: 'standard',
          structuredData: { allowedSkills: ['Rust'] },
        }),
      'INVALID_INPUT',
    )
    expect(harness.storage.count('evidence_fact', 'workspace-1')).toBe(0)
    expect(harness.storage.get('fact_proposal', proposals[0]?.id ?? '')?.status).toBe('pending')
  })

  it('requires exact consent and keeps interview discoveries as pending proposals', async () => {
    const harness = createHarness()
    const imported = importedDocument()
    harness.application.importParsedDocument({ workspaceId: 'workspace-1', ...imported })
    await expectApplicationError(
      () =>
        harness.application.proposeFactsForDocument({
          workspaceId: 'workspace-1',
          documentId: 'document-1',
          consent: { confirmed: false, dataItemIds: ['fragment-1'] },
        }),
      'CONSENT_REQUIRED',
    )
    expect(harness.aiCalls).toEqual([])

    const turn = await harness.application.nextInterviewQuestion({
      workspaceId: 'workspace-1',
      factIds: [],
      conversationMessages: [
        { id: 'message-1', role: 'user', content: 'I led a student team.', aiAllowed: true },
      ],
      consent: { confirmed: true, dataItemIds: ['message-1'] },
    })
    expect(turn.question).toContain('personally')
    expect(turn.proposals).toHaveLength(1)
    expect(turn.proposals[0]?.status).toBe('pending')
    expect(harness.storage.count('evidence_fact', 'workspace-1')).toBe(0)
  })

  it('blocks verified facts whose aiAllowed permission is false', async () => {
    const harness = createHarness()
    const accepted = await seedVerifiedFact(harness, {
      aiAllowed: false,
      resumeAllowed: true,
      shareAllowed: false,
    })
    await expectApplicationError(
      () =>
        harness.application.nextInterviewQuestion({
          workspaceId: 'workspace-1',
          factIds: [accepted.fact.id],
          conversationMessages: [],
          consent: { confirmed: true, dataItemIds: [accepted.revision.id] },
        }),
      'AI_DATA_NOT_ALLOWED',
    )
  })
})

describe('job analysis and evidence gaps', () => {
  it('strictly decomposes an untrusted JD and rejects out-of-range citations', async () => {
    const harness = createHarness()
    const result = await harness.application.decomposeAndCreateJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      contextItemId: 'jd-context-1',
      consent: { confirmed: true, dataItemIds: ['jd-context-1'] },
    })
    expect(result.requirements[0]).toMatchObject({ text: 'TypeScript', sourceEnd: 10 })

    const invalid = createHarness({
      responder: (operation) => {
        if (operation !== 'decompose_job') throw new Error('Unexpected operation')
        return [
          {
            category: 'must_have',
            text: 'TypeScript',
            priority: 5,
            sourceStart: 0,
            sourceEnd: 999,
          },
        ]
      },
    })
    await expectApplicationError(
      () =>
        invalid.application.decomposeAndCreateJobAnalysis({
          workspaceId: 'workspace-1',
          source: 'manual',
          companyName: 'Example Co',
          title: 'Engineer',
          description: 'TypeScript required.',
          contextItemId: 'jd-context-2',
          consent: { confirmed: true, dataItemIds: ['jd-context-2'] },
        }),
      'AI_OUTPUT_INVALID',
    )
    expect(invalid.storage.count('job_snapshot', 'workspace-1')).toBe(0)
  })

  it('creates an explainable requirement-to-evidence matrix and learning actions', async () => {
    const harness = createHarness()
    await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Frontend engineer',
      description: 'TypeScript and Kubernetes are required.',
      requirements: [
        { category: 'must_have', text: 'TypeScript', normalizedKey: 'TypeScript', priority: 5 },
        { category: 'must_have', text: 'Kubernetes', normalizedKey: 'Kubernetes', priority: 4 },
      ],
    })
    const gap = harness.application.analyzeEvidenceGap({
      workspaceId: 'workspace-1',
      profileId: 'profile-1',
      jobSnapshotId: job.snapshot.id,
    })
    expect(gap.report.assessments.map((assessment) => assessment.verdict)).toEqual([
      'supported',
      'gap',
    ])
    expect(gap.learningActions).toHaveLength(1)
    expect(gap.learningActions[0]?.gapType).toBe('evidence')
  })
})

describe('evidence-bound resume export', () => {
  it('tailors claims only within approved facts and rejects invented metrics', async () => {
    let revisionId = ''
    let requirementId = ''
    const harness = createHarness({
      responder: (operation) => {
        if (operation === 'extract_fact_proposals') {
          return [proposal('Built a TypeScript service and improved throughput by 30%.')]
        }
        if (operation === 'rewrite_resume_claims') {
          return [
            {
              revisionId,
              text: 'Improved TypeScript service throughput by 30%.',
              requirementIds: [requirementId],
              rationale: 'Leads with the result relevant to the job.',
            },
          ]
        }
        throw new Error(`Unexpected operation ${operation}`)
      },
    })
    const accepted = await seedVerifiedFact(harness)
    revisionId = accepted.revision.id
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [
        { category: 'must_have', text: 'TypeScript', normalizedKey: 'TypeScript', priority: 5 },
      ],
    })
    requirementId = job.requirements[0]?.id ?? ''
    const tailored = await harness.application.tailorResumeClaims({
      workspaceId: 'workspace-1',
      jobSnapshotId: job.snapshot.id,
      factIds: [accepted.fact.id],
      consent: { confirmed: true, dataItemIds: [job.snapshot.id, accepted.revision.id] },
    })
    expect(tailored).toEqual([
      expect.objectContaining({
        revisionId: accepted.revision.id,
        text: 'Improved TypeScript service throughput by 30%.',
      }),
    ])

    const unsafe = createHarness({
      responder: (operation) => {
        if (operation === 'extract_fact_proposals') {
          return [proposal('Built a TypeScript service and improved throughput by 30%.')]
        }
        if (operation === 'rewrite_resume_claims') {
          return [
            {
              revisionId,
              text: 'Improved TypeScript service throughput by 99%.',
              requirementIds: [requirementId],
              rationale: 'Invented metric.',
            },
          ]
        }
        throw new Error(`Unexpected operation ${operation}`)
      },
    })
    const unsafeAccepted = await seedVerifiedFact(unsafe)
    revisionId = unsafeAccepted.revision.id
    const unsafeJob = unsafe.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })
    requirementId = unsafeJob.requirements[0]?.id ?? ''
    await expectApplicationError(
      () =>
        unsafe.application.tailorResumeClaims({
          workspaceId: 'workspace-1',
          jobSnapshotId: unsafeJob.snapshot.id,
          factIds: [unsafeAccepted.fact.id],
          consent: {
            confirmed: true,
            dataItemIds: [unsafeJob.snapshot.id, unsafeAccepted.revision.id],
          },
        }),
      'AI_OUTPUT_INVALID',
    )
  })

  it('exports ATS text and escaped HTML only after validation', async () => {
    const claim = 'Built <script>alert(1)</script> with TypeScript and improved throughput by 30%.'
    const harness = createHarness({ proposalClaim: claim })
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [
        { category: 'must_have', text: 'TypeScript', normalizedKey: 'TypeScript', priority: 5 },
      ],
    })
    const makeDraft = () =>
      harness.application.buildResumeDraft({
        workspaceId: 'workspace-1',
        profileId: 'profile-1',
        jobSnapshotId: job.snapshot.id,
        name: 'TypeScript resume',
        locale: 'zh-CN',
        template: 'ats_single_column',
        links: [],
        claims: [
          {
            sectionKind: 'project',
            sectionTitle: '项目经历',
            text: claim,
            revisionId: accepted.revision.id,
            requirementIds: [job.requirements[0]?.id],
          },
        ],
      })

    const textDraft = makeDraft()
    expect(textDraft.validation.valid).toBe(true)
    const textPreview = await harness.application.validateAndExportResume({
      workspaceId: 'workspace-1',
      resumeVersionId: textDraft.version.id,
      document: textDraft.document,
      format: 'text',
      commit: false,
    })
    expect(new TextDecoder().decode(textPreview.bytes)).toContain('TypeScript')
    expect(harness.storage.get('resume_version', textDraft.version.id)?.status).toBe('draft')
    const textExport = await harness.application.validateAndExportResume({
      workspaceId: 'workspace-1',
      resumeVersionId: textDraft.version.id,
      document: textDraft.document,
      format: 'text',
    })
    expect(new TextDecoder().decode(textExport.bytes)).toContain('TypeScript')

    const htmlDraft = makeDraft()
    const htmlExport = await harness.application.validateAndExportResume({
      workspaceId: 'workspace-1',
      resumeVersionId: htmlDraft.version.id,
      document: htmlDraft.document,
      format: 'html',
    })
    const html = new TextDecoder().decode(htmlExport.bytes)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('reopens a complete encrypted resume draft after the process storage handle closes', async () => {
    const harness = createHarness()
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })
    const draft = harness.application.buildResumeDraft({
      workspaceId: 'workspace-1',
      profileId: 'profile-1',
      jobSnapshotId: job.snapshot.id,
      name: 'Crash-safe resume',
      locale: 'zh-CN',
      template: 'ats_single_column',
      links: [],
      claims: [
        {
          sectionKind: 'project',
          sectionTitle: '项目经历',
          text: accepted.revision.claim,
          revisionId: accepted.revision.id,
          requirementIds: [],
        },
      ],
      tailoringRationales: { [accepted.revision.id]: 'Preserve the verified outcome.' },
    })

    expect(harness.storage.get('resume_draft_artifact', draft.version.id)).toMatchObject({
      resumeVersionId: draft.version.id,
      jobSnapshotId: job.snapshot.id,
      contentSha256: draft.version.contentSha256,
    })
    harness.storage.close()

    const reopened = SingleWriterStorage.open(harness.filename, {
      codec: new Aes256GcmCodec(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    })
    storages.push(reopened)
    const artifact = reopened.get('resume_draft_artifact', draft.version.id)
    expect(artifact).toBeDefined()
    expect(JSON.parse(artifact?.documentJson ?? '{}')).toMatchObject({
      id: draft.version.id,
      targetJobSnapshotId: job.snapshot.id,
    })
    expect(reopened.get('resume_project', draft.project.id)).toBeDefined()
    expect(reopened.get('resume_version', draft.version.id)).toBeDefined()
    expect(reopened.get('resume_claim', draft.claims[0]?.id ?? '')).toBeDefined()
  })

  it('rolls back every draft record when the final artifact write is fault-injected', async () => {
    const harness = createHarness({
      storageFaultInjector: (event) => {
        if (event.kind === 'resume_draft_artifact') throw new Error('simulated process boundary')
      },
    })
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })

    expect(() =>
      harness.application.buildResumeDraft({
        workspaceId: 'workspace-1',
        profileId: 'profile-1',
        jobSnapshotId: job.snapshot.id,
        name: 'Interrupted resume',
        locale: 'zh-CN',
        template: 'ats_single_column',
        links: [],
        claims: [
          {
            sectionKind: 'project',
            sectionTitle: '项目经历',
            text: accepted.revision.claim,
            revisionId: accepted.revision.id,
            requirementIds: [],
          },
        ],
      }),
    ).toThrow('simulated process boundary')
    expect(harness.storage.count('resume_project', 'workspace-1')).toBe(0)
    expect(harness.storage.count('resume_version', 'workspace-1')).toBe(0)
    expect(harness.storage.count('resume_claim', 'workspace-1')).toBe(0)
    expect(harness.storage.count('resume_draft_artifact', 'workspace-1')).toBe(0)

    harness.storage.close()
    const reopened = SingleWriterStorage.open(harness.filename, {
      codec: new Aes256GcmCodec(Uint8Array.from({ length: 32 }, (_, index) => index + 1)),
    })
    storages.push(reopened)
    expect(reopened.count('resume_project', 'workspace-1')).toBe(0)
    expect(reopened.count('resume_version', 'workspace-1')).toBe(0)
    expect(reopened.count('resume_claim', 'workspace-1')).toBe(0)
    expect(reopened.count('resume_draft_artifact', 'workspace-1')).toBe(0)
  })

  it('blocks a novel semantic fabrication until the user attests that exact claim text', async () => {
    const harness = createHarness()
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'Rust required.',
      requirements: [{ category: 'must_have', text: 'Rust', priority: 5 }],
    })
    const fabricated = '曾任谷歌高级工程师，精通 Rust 并主导全球商业化战略'
    const draft = harness.application.buildResumeDraft({
      workspaceId: 'workspace-1',
      profileId: 'profile-1',
      jobSnapshotId: job.snapshot.id,
      name: 'Review-required resume',
      locale: 'zh-CN',
      template: 'ats_single_column',
      links: [],
      claims: [
        {
          sectionKind: 'project',
          sectionTitle: '项目经历',
          text: fabricated,
          revisionId: accepted.revision.id,
          requirementIds: [job.requirements[0]?.id],
        },
      ],
    })

    expect(draft.validation.valid).toBe(false)
    expect(draft.validation.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'USER_REVIEW_REQUIRED' })]),
    )
    await expectApplicationError(
      () =>
        harness.application.validateAndExportResume({
          workspaceId: 'workspace-1',
          resumeVersionId: draft.version.id,
          document: draft.document,
          format: 'text',
        }),
      'RESUME_INVALID',
    )
    await expectApplicationError(
      () =>
        harness.application.attestResumeClaim({
          workspaceId: 'workspace-1',
          resumeVersionId: draft.version.id,
          claimId: draft.claims[0]?.id,
          confirmedText: `${fabricated}。`,
          document: draft.document,
        }),
      'RESUME_MUTATED',
    )

    const attested = harness.application.attestResumeClaim({
      workspaceId: 'workspace-1',
      resumeVersionId: draft.version.id,
      claimId: draft.claims[0]?.id,
      confirmedText: fabricated,
      document: draft.document,
    })
    expect(attested.validation.valid).toBe(true)
    expect(attested.document.sections[0]?.claims[0]?.userAttestation?.confirmedText).toBe(
      fabricated,
    )
    const storedVersion = harness.storage.get('resume_version', draft.version.id)
    const storedArtifact = harness.storage.get('resume_draft_artifact', draft.version.id)
    expect(storedArtifact?.contentSha256).toBe(storedVersion?.contentSha256)
    const storedDocument = resumeDocumentSchema.parse(
      JSON.parse(storedArtifact?.documentJson ?? '{}') as unknown,
    )
    expect(storedDocument.sections[0]?.claims[0]?.userAttestation?.confirmedText).toBe(fabricated)
    await expect(
      harness.application.validateAndExportResume({
        workspaceId: 'workspace-1',
        resumeVersionId: draft.version.id,
        document: attested.document,
        format: 'text',
      }),
    ).resolves.toMatchObject({ filename: 'Review-required resume.txt' })
  })

  it('rolls back both the version hash and artifact when attestation persistence fails', async () => {
    let failArtifactUpdate = false
    const harness = createHarness({
      storageFaultInjector: (event) => {
        if (event.kind === 'resume_draft_artifact' && failArtifactUpdate) {
          throw new Error('simulated attestation interruption')
        }
      },
    })
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'Communication required.',
      requirements: [{ category: 'soft_skill', text: 'Communication', priority: 5 }],
    })
    const rewritten = '向高管团队汇报全球商业化战略'
    const draft = harness.application.buildResumeDraft({
      workspaceId: 'workspace-1',
      profileId: 'profile-1',
      jobSnapshotId: job.snapshot.id,
      name: 'Interrupted review',
      locale: 'zh-CN',
      template: 'ats_single_column',
      links: [],
      claims: [
        {
          sectionKind: 'project',
          sectionTitle: '项目经历',
          text: rewritten,
          revisionId: accepted.revision.id,
          requirementIds: [],
        },
      ],
    })
    failArtifactUpdate = true

    expect(() =>
      harness.application.attestResumeClaim({
        workspaceId: 'workspace-1',
        resumeVersionId: draft.version.id,
        claimId: draft.claims[0]?.id,
        confirmedText: rewritten,
        document: draft.document,
      }),
    ).toThrow('simulated attestation interruption')

    expect(harness.storage.get('resume_version', draft.version.id)?.contentSha256).toBe(
      draft.version.contentSha256,
    )
    const artifact = harness.storage.get('resume_draft_artifact', draft.version.id)
    expect(artifact?.contentSha256).toBe(draft.version.contentSha256)
    const storedDocument = resumeDocumentSchema.parse(
      JSON.parse(artifact?.documentJson ?? '{}') as unknown,
    )
    expect(storedDocument.sections[0]?.claims[0]?.userAttestation).toBeNull()
  })

  it('refuses unsupported numbers at the export boundary', async () => {
    const harness = createHarness()
    const accepted = await seedVerifiedFact(harness)
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'manual',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })
    const draft = harness.application.buildResumeDraft({
      workspaceId: 'workspace-1',
      profileId: 'profile-1',
      jobSnapshotId: job.snapshot.id,
      name: 'Unsafe resume',
      locale: 'zh-CN',
      template: 'ats_single_column',
      links: [],
      claims: [
        {
          sectionKind: 'project',
          sectionTitle: '项目经历',
          text: 'Improved throughput by 99%.',
          revisionId: accepted.revision.id,
          requirementIds: [],
        },
      ],
    })
    expect(draft.validation.valid).toBe(false)
    await expectApplicationError(
      () =>
        harness.application.validateAndExportResume({
          workspaceId: 'workspace-1',
          resumeVersionId: draft.version.id,
          document: draft.document,
          format: 'text',
        }),
      'RESUME_INVALID',
    )
  })
})

describe('supervised exactly-once external actions', () => {
  it('requires prepare, exact authorization, and prevents a second execution', async () => {
    const harness = createHarness()
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'boss',
      externalId: 'boss-job-1',
      sourceUrl: 'https://www.zhipin.com/job_detail/boss-job-1.html',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })
    const prepared = harness.application.prepareExternalAction({
      workspaceId: 'workspace-1',
      jobSnapshotId: job.snapshot.id,
      kind: 'send_greeting',
      target: {
        platform: 'boss',
        accountId: 'account-1',
        platformJobId: 'boss-job-1',
        canonicalUrl: 'https://www.zhipin.com/job_detail/boss-job-1.html',
        company: 'Example Co',
        title: 'Engineer',
      },
      recipientId: 'recruiter-1',
      body: '您好，我对该岗位很感兴趣。',
      attachmentPath: null,
      attachmentHash: null,
    })
    const authorized = harness.application.authorizeExternalAction({
      workspaceId: 'workspace-1',
      preparedAction: prepared.preparedAction,
    })
    await expectApplicationError(
      () =>
        harness.application.executeExternalAction({
          workspaceId: 'workspace-1',
          preparedAction: prepared.preparedAction,
          authorization: {
            ...authorized.authorization,
            authorizationId: '00000000-0000-4000-8000-000000000000',
          },
        }),
      'AUTHORIZATION_INVALID',
    )
    expect(harness.connector.executed).toHaveLength(0)
    const completed = await harness.application.executeExternalAction({
      workspaceId: 'workspace-1',
      preparedAction: prepared.preparedAction,
      authorization: authorized.authorization,
    })
    expect(completed.outcome.status).toBe('succeeded')
    expect(completed.automaticallyRetried).toBe(false)
    expect(harness.connector.executed).toHaveLength(1)

    await expectApplicationError(
      () =>
        harness.application.executeExternalAction({
          workspaceId: 'workspace-1',
          preparedAction: prepared.preparedAction,
          authorization: authorized.authorization,
        }),
      'DUPLICATE_ACTION',
    )
    expect(harness.connector.executed).toHaveLength(1)
  })

  it('never retries outcome_unknown and only allows reconciliation', async () => {
    const harness = createHarness({
      outcome: {
        status: 'outcome_unknown',
        message: 'No receipt',
        reconcileAfter: '2026-08-31T00:01:00.000Z',
      },
    })
    const job = harness.application.createJobAnalysis({
      workspaceId: 'workspace-1',
      source: 'boss',
      externalId: 'boss-job-1',
      sourceUrl: 'https://www.zhipin.com/job_detail/boss-job-1.html',
      companyName: 'Example Co',
      title: 'Engineer',
      description: 'TypeScript required.',
      requirements: [{ category: 'must_have', text: 'TypeScript', priority: 5 }],
    })
    const prepared = harness.application.prepareExternalAction({
      workspaceId: 'workspace-1',
      jobSnapshotId: job.snapshot.id,
      kind: 'apply',
      target: {
        platform: 'boss',
        accountId: 'account-1',
        platformJobId: 'boss-job-1',
        canonicalUrl: 'https://www.zhipin.com/job_detail/boss-job-1.html',
        company: 'Example Co',
        title: 'Engineer',
      },
      recipientId: null,
      body: 'Apply',
      attachmentPath: null,
      attachmentHash: null,
    })
    const authorized = harness.application.authorizeExternalAction({
      workspaceId: 'workspace-1',
      preparedAction: prepared.preparedAction,
    })
    const unknown = await harness.application.executeExternalAction({
      workspaceId: 'workspace-1',
      preparedAction: prepared.preparedAction,
      authorization: authorized.authorization,
    })
    expect(unknown.outcome.status).toBe('outcome_unknown')
    await expectApplicationError(
      () =>
        harness.application.executeExternalAction({
          workspaceId: 'workspace-1',
          preparedAction: prepared.preparedAction,
          authorization: authorized.authorization,
        }),
      'ACTION_OUTCOME_UNKNOWN',
    )
    expect(harness.connector.executed).toHaveLength(1)

    harness.connector.setOutcome({
      status: 'succeeded',
      receiptId: 'reconciled-receipt',
      observedAt: now.toISOString(),
      evidence: { source: 'reconcile' },
    })
    const reconciled = await harness.application.reconcileExternalAction({
      workspaceId: 'workspace-1',
      preparedAction: prepared.preparedAction,
    })
    expect(reconciled.outcome.status).toBe('succeeded')
    expect(harness.connector.executed).toHaveLength(1)
  })
})
