import { randomUUID } from 'node:crypto'

import {
  AiProviderError,
  type AiContextItem,
  type AiOperation,
  type AiProvider,
} from '@bosshunter/ai'
import {
  ConnectorError,
  SupervisedActionRunner,
  authorizeAction as authorizeConnectorAction,
  prepareAction as prepareConnectorAction,
  preparedActionSchema,
  type ActionAuthorization as ConnectorAuthorization,
  type ActionOutcome,
  type PlatformAdapter,
  type PlatformId,
  type PreparedAction,
} from '@bosshunter/connectors'
import {
  assertResumeClaimSupported,
  canAutomaticallyRetryExternalAction,
  consumeActionAuthorization,
  createActionAuthorization,
  sha256Text,
  transitionExternalActionStatus,
  validateActionAuthorization,
  type ActionAuthorization as DomainAuthorization,
  type AiRun,
  type ConsentRecord,
  type DocumentFragment,
  type DomainEntityKind,
  type DomainEntityMap,
  type EvidenceFact,
  type EvidenceRevision,
  type ExternalAction,
  type FactProposal,
  type JobRequirement,
  type JobSnapshot,
  type LearningAction,
  type MatchReport,
  type PersonProfile,
  type ResumeClaim as DomainResumeClaim,
  type ResumeDraftArtifact,
  type ResumeProject,
  type ResumeVersion,
  type SourceDocument,
  type Workspace,
} from '@bosshunter/domain'
import {
  HtmlResumeExporter,
  TextResumeExporter,
  assertEditable,
  evidenceSnapshotSchema,
  resumeDocumentSchema,
  validateResume,
  type EvidenceSnapshot,
  type ResumeDocument,
  type ResumeValidationResult,
} from '@bosshunter/resume'
import type { SingleWriterStorage } from '@bosshunter/storage'
import { z, type ZodType } from 'zod'

import { ApplicationError, toApplicationError } from './errors.js'
import {
  AcceptFactProposalInputSchema,
  AnalyzeEvidenceGapInputSchema,
  AttestResumeClaimInputSchema,
  AuthorizeExternalActionInputSchema,
  BuildResumeDraftInputSchema,
  CreateJobAnalysisInputSchema,
  DecomposeAndCreateJobAnalysisInputSchema,
  ExecuteExternalActionInputSchema,
  ExplicitAiConsentSchema,
  FactProposalDraftSchema,
  InitializeWorkspaceInputSchema,
  ImportParsedDocumentInputSchema,
  InterviewQuestionOutputSchema,
  JobRequirementDraftSchema,
  LoadWorkspaceInputSchema,
  NextInterviewQuestionInputSchema,
  PrepareExternalActionInputSchema,
  ProposeFactsForDocumentInputSchema,
  ProposeFactsFromImportInputSchema,
  ReconcileExternalActionInputSchema,
  TailoredResumeClaimDraftSchema,
  TailorResumeClaimsInputSchema,
  ValidateAndExportResumeInputSchema,
  type ExplicitAiConsent,
  type FactProposalDraft,
} from './schemas.js'

export interface CareerApplicationDependencies {
  readonly storage: SingleWriterStorage
  readonly aiProvider: AiProvider
  readonly connectors?: readonly PlatformAdapter[]
  readonly clock?: () => Date
  readonly idFactory?: (scope: string) => string
}

export interface WorkspaceContext {
  readonly workspace: Workspace
  readonly profile: PersonProfile | null
  readonly counts: {
    readonly sourceDocuments: number
    readonly pendingFactProposals: number
    readonly verifiedFacts: number
    readonly jobs: number
    readonly resumes: number
    readonly externalActions: number
  }
}

export interface AcceptedFact {
  readonly proposal: FactProposal
  readonly fact: EvidenceFact
  readonly revision: EvidenceRevision
}

export interface ImportedDocument {
  readonly document: SourceDocument
  readonly fragments: readonly DocumentFragment[]
}

export interface InterviewTurn {
  readonly question: string
  readonly rationale: string
  readonly targetFactIds: readonly string[]
  readonly proposals: readonly FactProposal[]
}

export interface JobAnalysis {
  readonly snapshot: JobSnapshot
  readonly requirements: readonly JobRequirement[]
}

export interface EvidenceGapAnalysis {
  readonly report: MatchReport
  readonly learningActions: readonly LearningAction[]
}

export interface ResumeDraft {
  readonly project: ResumeProject
  readonly version: ResumeVersion
  readonly claims: readonly DomainResumeClaim[]
  readonly artifact: ResumeDraftArtifact
  readonly document: ResumeDocument
  readonly validation: ResumeValidationResult
}

export interface AttestedResumeClaim {
  readonly version: ResumeVersion
  readonly document: ResumeDocument
  readonly validation: ResumeValidationResult
}

export interface TailoredResumeClaim {
  readonly revisionId: string
  readonly text: string
  readonly requirementIds: readonly string[]
  readonly rationale: string
}

export interface ResumeExport {
  readonly document: ResumeDocument
  readonly bytes: Uint8Array
  readonly mediaType: 'text/plain; charset=utf-8' | 'text/html; charset=utf-8'
  readonly filename: string
}

export interface PreparedExternalAction {
  readonly preparedAction: PreparedAction
  readonly domainAction: ExternalAction
}

export interface AuthorizedExternalAction extends PreparedExternalAction {
  readonly authorization: ConnectorAuthorization
  readonly domainAuthorization: DomainAuthorization
}

export interface ExecutedExternalAction {
  readonly outcome: ActionOutcome
  readonly authorization: ConnectorAuthorization
  readonly domainAction: ExternalAction
  readonly automaticallyRetried: false
}

const proposalDraftListSchema = z.array(FactProposalDraftSchema).min(1).max(100)
const jobRequirementDraftListSchema = z.array(JobRequirementDraftSchema).min(1).max(500)
const tailoredResumeClaimListSchema = z.array(TailoredResumeClaimDraftSchema).min(1).max(100)

function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch (error) {
    throw toApplicationError(error)
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every((item) => rightSet.has(item))
}

function applicationDetails(details: Readonly<Record<string, unknown>> | undefined): {
  details?: Readonly<Record<string, unknown>>
} {
  return details === undefined ? {} : { details }
}

function normalizeForMatch(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}+#.]+/gu, '')
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    )
  }
  return value
}

function safeFileBase(value: string): string {
  return [...value.replace(/[<>:"/\\|?*]/g, '_')]
    .map((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && codePoint < 32 ? '_' : character
    })
    .join('')
    .slice(0, 120)
}

function meaningfulTokens(value: string): readonly string[] {
  return (
    value
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}+#.]{2,}/gu)
      ?.filter(
        (token) => !['with', 'and', 'the', '以及', '能够', '负责', '相关'].includes(token),
      ) ?? []
  )
}

function requirementMatches(requirement: JobRequirement, revision: EvidenceRevision): boolean {
  const normalizedClaim = normalizeForMatch(revision.claim)
  const normalizedNeedle = normalizeForMatch(requirement.normalizedKey ?? requirement.text)
  if (normalizedNeedle.length >= 2 && normalizedClaim.includes(normalizedNeedle)) return true
  return meaningfulTokens(requirement.normalizedKey ?? requirement.text).some((token) =>
    normalizedClaim.includes(normalizeForMatch(token)),
  )
}

const evidenceNumberPattern = /(?<![\p{L}\p{N}])(?:\d+(?:[.,]\d+)?%?|\d+\+)(?![\p{L}\p{N}])/gu
const evidenceDatePattern = /(?:19|20)\d{2}(?:[./\-年](?:0?[1-9]|1[0-2])月?)?/gu
function valuesInVerifiedClaim(claim: string, pattern: RegExp): string[] {
  return [...new Set([...claim.matchAll(pattern)].map((match) => match[0]))]
}

function verifiedStructuredData(claim: string): EvidenceRevision['structuredData'] {
  return {
    allowedEntities: [],
    allowedNumbers: valuesInVerifiedClaim(claim, evidenceNumberPattern),
    allowedDates: valuesInVerifiedClaim(claim, evidenceDatePattern),
    allowedSkills: [],
  }
}

function evidenceSnapshot(revision: EvidenceRevision): EvidenceSnapshot {
  return evidenceSnapshotSchema.parse({
    revisionId: revision.id,
    factId: revision.factId,
    status: 'verified',
    statement: revision.claim,
    allowedEntities: [],
    allowedNumbers: valuesInVerifiedClaim(revision.claim, evidenceNumberPattern),
    allowedDates: valuesInVerifiedClaim(revision.claim, evidenceDatePattern),
    allowedSkills: [],
  })
}

function externalTransition(from: ExternalAction['status'], to: ExternalAction['status']): void {
  const result = transitionExternalActionStatus(from, to)
  if (!result.ok) {
    throw new ApplicationError(
      'CONFLICT',
      result.error.message,
      applicationDetails(result.error.details),
    )
  }
}

export class CareerApplication {
  readonly #storage: SingleWriterStorage
  readonly #aiProvider: AiProvider
  readonly #connectors = new Map<PlatformId, PlatformAdapter>()
  readonly #clock: () => Date
  readonly #idFactory: (scope: string) => string

  constructor(dependencies: CareerApplicationDependencies) {
    this.#storage = dependencies.storage
    this.#aiProvider = dependencies.aiProvider
    this.#clock = dependencies.clock ?? (() => new Date())
    this.#idFactory = dependencies.idFactory ?? (() => randomUUID())
    for (const connector of dependencies.connectors ?? [])
      this.#connectors.set(connector.id, connector)
  }

  initializeWorkspace(inputValue: unknown): WorkspaceContext {
    return this.#sync(() => {
      const input = parseInput(InitializeWorkspaceInputSchema, inputValue)
      const workspaceId = input.workspaceId ?? this.#idFactory('workspace')
      const profileId = input.profileId ?? this.#idFactory('profile')
      if (this.#storage.get('workspace', workspaceId) !== undefined) {
        throw new ApplicationError('CONFLICT', `Workspace ${workspaceId} already exists`)
      }
      const timestamp = this.#now()
      const workspace: Workspace = {
        id: workspaceId,
        name: input.name,
        locale: input.locale,
        schemaVersion: this.#storage.schemaVersion,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const profile: PersonProfile = {
        id: profileId,
        workspaceId,
        displayName: input.displayName,
        targetRoles: input.targetRoles,
        languages: input.languages,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(input.preferredName === undefined ? {} : { preferredName: input.preferredName }),
        ...(input.email === undefined ? {} : { email: input.email }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.location === undefined ? {} : { location: input.location }),
      }
      this.#storage.transaction(() => {
        this.#storage.put('workspace', workspace)
        this.#storage.put('person_profile', profile)
      })
      return this.#workspaceContext(workspace, profile)
    })
  }

  loadWorkspace(inputValue: unknown): WorkspaceContext {
    return this.#sync(() => {
      const input = parseInput(LoadWorkspaceInputSchema, inputValue)
      const workspace = this.#require('workspace', input.workspaceId)
      const profile = this.#storage.list('person_profile', workspace.id)[0] ?? null
      return this.#workspaceContext(workspace, profile)
    })
  }

  importParsedDocument(inputValue: unknown): ImportedDocument {
    return this.#sync(() => {
      const input = parseInput(ImportParsedDocumentInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      if (input.document.workspaceId !== input.workspaceId) this.#workspaceMismatch()
      if (!['review', 'completed'].includes(input.document.status)) {
        throw new ApplicationError(
          'CONFLICT',
          'Fact extraction requires a document that completed parsing',
        )
      }
      if (this.#storage.get('source_document', input.document.id) !== undefined) {
        throw new ApplicationError('CONFLICT', `Document ${input.document.id} is already imported`)
      }
      for (const fragment of input.fragments) {
        if (
          fragment.workspaceId !== input.workspaceId ||
          fragment.documentId !== input.document.id
        ) {
          this.#workspaceMismatch()
        }
      }
      this.#storage.transaction(() => {
        this.#storage.put('source_document', input.document)
        this.#storage.putMany('document_fragment', input.fragments)
      })
      return { document: input.document, fragments: input.fragments }
    })
  }

  async proposeFactsForDocument(inputValue: unknown): Promise<readonly FactProposal[]> {
    return this.#async(async () => {
      const input = parseInput(ProposeFactsForDocumentInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const document = this.#require('source_document', input.documentId)
      if (document.workspaceId !== input.workspaceId) this.#workspaceMismatch()
      const allFragments = this.#storage
        .list('document_fragment', input.workspaceId)
        .filter((fragment) => fragment.documentId === document.id)
      const selected = new Set(input.consent.dataItemIds)
      const fragments = allFragments.filter((fragment) => selected.has(fragment.id))
      if (fragments.length !== selected.size) {
        throw new ApplicationError(
          'CONSENT_REQUIRED',
          'Consent includes data that is not part of this import',
        )
      }
      const contexts: AiContextItem[] = fragments.map((fragment) => ({
        id: fragment.id,
        kind: 'source_excerpt',
        content: fragment.text,
        trusted: false,
        aiAllowed: true,
      }))
      const drafts = await this.#runAi(
        input.workspaceId,
        'extract_fact_proposals',
        'Extract only candidate career facts grounded in the supplied excerpts. Preserve uncertainty.',
        contexts,
        input.consent,
        proposalDraftListSchema,
      )
      const allowedFragments = new Set(fragments.map((fragment) => fragment.id))
      const existing = this.#storage.list('fact_proposal', input.workspaceId)
      const existingByFingerprint = new Map(
        existing.map((proposal) => [this.#proposalFingerprint(proposal), proposal]),
      )
      const newProposals: FactProposal[] = []
      const proposals = drafts.map((draft) => {
        if (draft.sources.length === 0) {
          throw new ApplicationError(
            'AI_OUTPUT_INVALID',
            'Imported-document proposals must cite at least one approved excerpt',
          )
        }
        for (const source of draft.sources) {
          if (
            source.documentId !== document.id ||
            (source.fragmentId !== undefined && !allowedFragments.has(source.fragmentId))
          ) {
            throw new ApplicationError(
              'AI_OUTPUT_INVALID',
              'AI proposal referenced data outside the approved import excerpts',
            )
          }
        }
        for (const factId of draft.conflictsWithFactIds) {
          const conflict = this.#storage.get('evidence_fact', factId)
          if (conflict === undefined || conflict.workspaceId !== input.workspaceId) {
            throw new ApplicationError(
              'AI_OUTPUT_INVALID',
              'AI proposal referenced an unknown conflicting fact',
            )
          }
        }
        const fingerprint = this.#proposalDraftFingerprint(draft)
        const prior = existingByFingerprint.get(fingerprint)
        if (prior !== undefined) return prior
        const proposal = this.#proposalFromDraft(input.workspaceId, draft)
        existingByFingerprint.set(fingerprint, proposal)
        newProposals.push(proposal)
        return proposal
      })
      if (newProposals.length > 0) this.#storage.putMany('fact_proposal', newProposals)
      return proposals
    })
  }

  async proposeFactsFromImport(inputValue: unknown): Promise<readonly FactProposal[]> {
    return this.#async(async () => {
      const input = parseInput(ProposeFactsFromImportInputSchema, inputValue)
      this.importParsedDocument({
        workspaceId: input.workspaceId,
        document: input.document,
        fragments: input.fragments,
      })
      return this.proposeFactsForDocument({
        workspaceId: input.workspaceId,
        documentId: input.document.id,
        consent: input.consent,
      })
    })
  }

  acceptFactProposal(inputValue: unknown): AcceptedFact {
    return this.#sync(() => {
      const input = parseInput(AcceptFactProposalInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const proposal = this.#require('fact_proposal', input.proposalId)
      if (proposal.workspaceId !== input.workspaceId) this.#workspaceMismatch()
      if (proposal.status !== 'pending') {
        throw new ApplicationError('CONFLICT', 'This proposal has already been reviewed')
      }
      const timestamp = this.#now()
      const factId = this.#idFactory('fact')
      const revisionId = this.#idFactory('revision')
      const confirmedClaim = input.claim ?? proposal.proposedClaim
      const revision: EvidenceRevision = {
        id: revisionId,
        workspaceId: input.workspaceId,
        factId,
        version: 1,
        claim: confirmedClaim,
        structuredData: verifiedStructuredData(confirmedClaim),
        status: 'verified',
        sources: proposal.sources,
        createdBy: 'user',
        createdAt: timestamp,
        verifiedAt: timestamp,
        verifiedBy: 'user',
      }
      const fact: EvidenceFact = {
        id: factId,
        workspaceId: input.workspaceId,
        category: proposal.category,
        title: proposal.title,
        status: 'verified',
        currentRevisionId: revisionId,
        sensitivity: input.sensitivity,
        permissions: input.permissions,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const reviewedProposal: FactProposal = {
        ...proposal,
        status: 'accepted',
        reviewedAt: timestamp,
      }
      this.#storage.transaction(() => {
        this.#storage.put('evidence_fact', fact)
        this.#storage.put('evidence_revision', revision)
        this.#storage.put('fact_proposal', reviewedProposal)
      })
      return { proposal: reviewedProposal, fact, revision }
    })
  }

  async nextInterviewQuestion(inputValue: unknown): Promise<InterviewTurn> {
    return this.#async(async () => {
      const input = parseInput(NextInterviewQuestionInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const facts = [...new Set(input.factIds)].map((factId) =>
        this.#require('evidence_fact', factId),
      )
      const revisions = facts.map((fact) => {
        if (
          fact.workspaceId !== input.workspaceId ||
          fact.status !== 'verified' ||
          fact.currentRevisionId === undefined
        ) {
          throw new ApplicationError('FACT_NOT_VERIFIED', 'Interview context fact is not verified')
        }
        if (!fact.permissions.aiAllowed) {
          throw new ApplicationError('AI_DATA_NOT_ALLOWED', `Fact ${fact.id} is not allowed for AI`)
        }
        const revision = this.#require('evidence_revision', fact.currentRevisionId)
        if (revision.status !== 'verified') {
          throw new ApplicationError(
            'FACT_NOT_VERIFIED',
            'Interview context revision is not verified',
          )
        }
        return revision
      })
      const contexts: AiContextItem[] = [
        ...revisions.map((revision) => ({
          id: revision.id,
          kind: 'verified_fact' as const,
          content: revision.claim,
          trusted: true,
          aiAllowed: true,
        })),
        ...input.conversationMessages.map((message) => ({
          id: message.id,
          kind: 'conversation_message' as const,
          content: `${message.role}: ${message.content}`,
          trusted: false,
          aiAllowed: message.aiAllowed,
        })),
      ]
      const output = await this.#runAi(
        input.workspaceId,
        'next_interview_question',
        'Ask one high-value Socratic question that closes a concrete evidence gap.',
        contexts,
        input.consent,
        InterviewQuestionOutputSchema,
      )
      if (output.targetFactIds.some((factId) => !input.factIds.includes(factId))) {
        throw new ApplicationError(
          'AI_OUTPUT_INVALID',
          'AI referenced a fact outside this interview',
        )
      }
      const existing = this.#storage.list('fact_proposal', input.workspaceId)
      const byFingerprint = new Map(
        existing.map((proposal) => [this.#proposalFingerprint(proposal), proposal]),
      )
      const newProposals: FactProposal[] = []
      const proposals = output.factProposals.map((draft) => {
        for (const source of draft.sources) {
          const document = this.#storage.get('source_document', source.documentId)
          if (document === undefined || document.workspaceId !== input.workspaceId) {
            throw new ApplicationError(
              'AI_OUTPUT_INVALID',
              'Interview proposal referenced an unknown source document',
            )
          }
          if (source.fragmentId !== undefined) {
            const fragment = this.#storage.get('document_fragment', source.fragmentId)
            if (
              fragment === undefined ||
              fragment.workspaceId !== input.workspaceId ||
              fragment.documentId !== document.id
            ) {
              throw new ApplicationError(
                'AI_OUTPUT_INVALID',
                'Interview proposal referenced an unknown document excerpt',
              )
            }
          }
        }
        for (const factId of draft.conflictsWithFactIds) {
          const conflict = this.#storage.get('evidence_fact', factId)
          if (conflict === undefined || conflict.workspaceId !== input.workspaceId) {
            throw new ApplicationError(
              'AI_OUTPUT_INVALID',
              'Interview proposal referenced an unknown conflicting fact',
            )
          }
        }
        const fingerprint = this.#proposalDraftFingerprint(draft)
        const prior = byFingerprint.get(fingerprint)
        if (prior !== undefined) return prior
        const proposal = this.#proposalFromDraft(input.workspaceId, draft)
        byFingerprint.set(fingerprint, proposal)
        newProposals.push(proposal)
        return proposal
      })
      if (newProposals.length > 0) this.#storage.putMany('fact_proposal', newProposals)
      return {
        question: output.question,
        rationale: output.rationale,
        targetFactIds: output.targetFactIds,
        proposals,
      }
    })
  }

  createJobAnalysis(inputValue: unknown): JobAnalysis {
    return this.#sync(() => {
      const input = parseInput(CreateJobAnalysisInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const timestamp = this.#now()
      const jobSnapshotId = this.#idFactory('job')
      const snapshot: JobSnapshot = {
        id: jobSnapshotId,
        workspaceId: input.workspaceId,
        source: input.source,
        companyName: input.companyName,
        title: input.title,
        description: input.description,
        descriptionSha256: sha256Text(input.description),
        capturedAt: timestamp,
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.salaryText === undefined ? {} : { salaryText: input.salaryText }),
      }
      const requirements: JobRequirement[] = input.requirements.map((requirement) => ({
        id: this.#idFactory('requirement'),
        workspaceId: input.workspaceId,
        jobSnapshotId,
        category: requirement.category,
        text: requirement.text,
        priority: requirement.priority,
        ...(requirement.normalizedKey === undefined
          ? {}
          : { normalizedKey: requirement.normalizedKey }),
        ...(requirement.sourceStart === undefined ? {} : { sourceStart: requirement.sourceStart }),
        ...(requirement.sourceEnd === undefined ? {} : { sourceEnd: requirement.sourceEnd }),
      }))
      this.#storage.transaction(() => {
        this.#storage.put('job_snapshot', snapshot)
        this.#storage.putMany('job_requirement', requirements)
      })
      return { snapshot, requirements }
    })
  }

  async decomposeAndCreateJobAnalysis(inputValue: unknown): Promise<JobAnalysis> {
    return this.#async(async () => {
      const input = parseInput(DecomposeAndCreateJobAnalysisInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const requirements = await this.#runAi(
        input.workspaceId,
        'decompose_job',
        'Decompose this untrusted job description into explicit requirements. Source offsets must point into the supplied text.',
        [
          {
            id: input.contextItemId,
            kind: 'job_requirement',
            content: input.description,
            trusted: false,
            aiAllowed: true,
          },
        ],
        input.consent,
        jobRequirementDraftListSchema,
      )
      for (const requirement of requirements) {
        const hasStart = requirement.sourceStart !== undefined
        const hasEnd = requirement.sourceEnd !== undefined
        if (hasStart !== hasEnd) {
          throw new ApplicationError(
            'AI_OUTPUT_INVALID',
            'Job requirement must include both source offsets or neither',
          )
        }
        if (
          requirement.sourceStart !== undefined &&
          requirement.sourceEnd !== undefined &&
          (requirement.sourceStart >= requirement.sourceEnd ||
            requirement.sourceEnd > input.description.length)
        ) {
          throw new ApplicationError(
            'AI_OUTPUT_INVALID',
            'Job requirement source offsets are outside the supplied description',
          )
        }
      }
      return this.createJobAnalysis({
        workspaceId: input.workspaceId,
        source: input.source,
        companyName: input.companyName,
        title: input.title,
        description: input.description,
        requirements,
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.location === undefined ? {} : { location: input.location }),
        ...(input.salaryText === undefined ? {} : { salaryText: input.salaryText }),
      })
    })
  }

  analyzeEvidenceGap(inputValue: unknown): EvidenceGapAnalysis {
    return this.#sync(() => {
      const input = parseInput(AnalyzeEvidenceGapInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const profile = this.#require('person_profile', input.profileId)
      const job = this.#require('job_snapshot', input.jobSnapshotId)
      if (profile.workspaceId !== input.workspaceId || job.workspaceId !== input.workspaceId) {
        this.#workspaceMismatch()
      }
      const requirements = this.#storage
        .list('job_requirement', input.workspaceId)
        .filter((requirement) => requirement.jobSnapshotId === job.id)
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            (left.sourceStart ?? Number.MAX_SAFE_INTEGER) -
              (right.sourceStart ?? Number.MAX_SAFE_INTEGER) ||
            left.id.localeCompare(right.id),
        )
      if (requirements.length === 0) {
        throw new ApplicationError('NOT_FOUND', 'This job has no analyzed requirements')
      }
      const facts = this.#storage
        .list('evidence_fact', input.workspaceId)
        .filter((fact) => fact.status === 'verified' && fact.currentRevisionId !== undefined)
      const revisions = facts
        .map((fact) => this.#storage.get('evidence_revision', fact.currentRevisionId ?? ''))
        .filter(
          (revision): revision is EvidenceRevision =>
            revision !== undefined && revision.status === 'verified',
        )
      const assessments = requirements.map((requirement) => {
        const matched = revisions.filter((revision) => requirementMatches(requirement, revision))
        const isRisk = requirement.category === 'risk'
        const verdict =
          matched.length > 0
            ? ('supported' as const)
            : isRisk
              ? ('unknown' as const)
              : requirement.category === 'must_have'
                ? ('gap' as const)
                : ('unknown' as const)
        return {
          requirementId: requirement.id,
          verdict,
          revisionIds: matched.map((revision) => revision.id),
          explanation:
            matched.length > 0
              ? `找到 ${matched.length} 条已核验事实作为依据。`
              : isRisk
                ? '这是岗位风险或限制项，需要用户人工确认。'
                : '当前职业档案中没有找到足够的已核验证据。',
        }
      })
      const scorable = requirements.filter((requirement) => requirement.category !== 'risk')
      const scorableIds = new Set(scorable.map((requirement) => requirement.id))
      const supported = assessments.filter(
        (assessment) =>
          scorableIds.has(assessment.requirementId) && assessment.verdict === 'supported',
      ).length
      const evidenceCoverage = scorable.length === 0 ? 0 : (supported / scorable.length) * 100
      const sourced = revisions.filter((revision) => revision.sources.length > 0).length
      const factCompleteness = revisions.length === 0 ? 0 : (sourced / revisions.length) * 100
      const timestamp = this.#now()
      const report: MatchReport = {
        id: this.#idFactory('match-report'),
        workspaceId: input.workspaceId,
        jobSnapshotId: job.id,
        profileId: profile.id,
        assessments,
        evidenceCoverage,
        factCompleteness,
        expressionClarity: 0,
        recruiterScanQuality: 0,
        textParseCompatibility: 0,
        riskFlags: [
          ...requirements
            .filter((requirement) => requirement.category === 'risk')
            .map((requirement) => requirement.text),
          '表达清晰度、快速阅读质量和文本解析兼容性将在简历成稿后评估。',
        ],
        generatedAt: timestamp,
      }
      const learningActions: LearningAction[] = assessments
        .filter((assessment) => assessment.verdict === 'gap' || assessment.verdict === 'unknown')
        .filter((assessment) => {
          const requirement = requirements.find((item) => item.id === assessment.requirementId)
          return requirement?.category !== 'risk'
        })
        .map((assessment) => {
          const requirement = requirements.find((item) => item.id === assessment.requirementId)
          if (requirement === undefined) {
            throw new ApplicationError('INTERNAL', 'Requirement disappeared during gap analysis')
          }
          return {
            id: this.#idFactory('learning-action'),
            workspaceId: input.workspaceId,
            matchReportId: report.id,
            requirementId: requirement.id,
            gapType: 'evidence' as const,
            title: `补充证据：${requirement.text}`.slice(0, 240),
            outcome: '获得一条可以由本人核验、能够具体说明能力的职业事实。',
            evidenceToProduce:
              `完成一次可验证的实践，并记录本人行动与结果：${requirement.text}`.slice(0, 1_000),
            status: 'planned' as const,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
        })
      this.#storage.transaction(() => {
        this.#storage.put('match_report', report)
        this.#storage.putMany('learning_action', learningActions)
      })
      return { report, learningActions }
    })
  }

  async tailorResumeClaims(inputValue: unknown): Promise<readonly TailoredResumeClaim[]> {
    return this.#async(async () => {
      const input = parseInput(TailorResumeClaimsInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const job = this.#require('job_snapshot', input.jobSnapshotId)
      if (job.workspaceId !== input.workspaceId) this.#workspaceMismatch()
      const requirements = this.#storage
        .list('job_requirement', input.workspaceId)
        .filter((requirement) => requirement.jobSnapshotId === job.id)
      const requirementIds = new Set(requirements.map((requirement) => requirement.id))
      const facts = [...new Set(input.factIds)].map((factId) =>
        this.#require('evidence_fact', factId),
      )
      const revisions = facts.map((fact) => {
        if (
          fact.workspaceId !== input.workspaceId ||
          fact.status !== 'verified' ||
          fact.currentRevisionId === undefined
        ) {
          throw new ApplicationError('FACT_NOT_VERIFIED', 'Resume fact is not verified')
        }
        if (!fact.permissions.aiAllowed) {
          throw new ApplicationError('AI_DATA_NOT_ALLOWED', `Fact ${fact.id} disallows AI use`)
        }
        if (!fact.permissions.resumeAllowed) {
          throw new ApplicationError(
            'FACT_NOT_VERIFIED',
            `Fact ${fact.id} is not allowed in resumes`,
          )
        }
        const revision = this.#require('evidence_revision', fact.currentRevisionId)
        if (revision.status !== 'verified') {
          throw new ApplicationError('FACT_NOT_VERIFIED', 'Resume revision is not verified')
        }
        return revision
      })
      const suggestions = await this.#runAi(
        input.workspaceId,
        'rewrite_resume_claims',
        'Select the strongest supplied facts for this job and rewrite each selected fact as one concise resume claim. Preserve the fact exactly: never add an employer, role, skill, date, number, scope, result, or proficiency. Reference only supplied revision and requirement IDs. Return fewer claims when a fact is irrelevant.',
        [
          {
            id: job.id,
            kind: 'job_requirement',
            content: job.description,
            trusted: false,
            aiAllowed: true,
          },
          ...revisions.map((revision) => ({
            id: revision.id,
            kind: 'verified_fact' as const,
            content: revision.claim,
            trusted: true,
            aiAllowed: true,
          })),
        ],
        input.consent,
        tailoredResumeClaimListSchema,
      )
      const allowedRevisionIds = new Set(revisions.map((revision) => revision.id))
      const seenRevisionIds = new Set<string>()
      for (const suggestion of suggestions) {
        if (
          !allowedRevisionIds.has(suggestion.revisionId) ||
          seenRevisionIds.has(suggestion.revisionId) ||
          suggestion.requirementIds.some((requirementId) => !requirementIds.has(requirementId))
        ) {
          throw new ApplicationError(
            'AI_OUTPUT_INVALID',
            'AI resume suggestion referenced data outside the approved job and facts',
          )
        }
        seenRevisionIds.add(suggestion.revisionId)
      }
      const snapshots = new Map(
        revisions.map((revision) => [revision.id, evidenceSnapshot(revision)]),
      )
      const validationDocument = resumeDocumentSchema.parse({
        id: this.#idFactory('resume-ai-validation'),
        version: 1,
        language: 'zh-CN',
        template: 'ats_single_column',
        targetJobSnapshotId: job.id,
        candidateName: '候选人',
        contact: { links: [] },
        sections: [
          {
            id: this.#idFactory('resume-ai-validation-section'),
            kind: 'other',
            title: 'AI 建议校验',
            claims: suggestions.map((suggestion) => ({
              id: this.#idFactory('resume-ai-validation-claim'),
              text: suggestion.text,
              evidenceRevisionIds: [suggestion.revisionId],
              requirementIds: suggestion.requirementIds,
            })),
          },
        ],
        approvedAt: null,
        createdAt: this.#now(),
      })
      const validation = validateResume(validationDocument, snapshots)
      const unreviewableIssues = validation.issues.filter(
        (issue) => issue.blocking && issue.code !== 'USER_REVIEW_REQUIRED',
      )
      if (unreviewableIssues.length > 0) {
        throw new ApplicationError('AI_OUTPUT_INVALID', 'AI resume claims failed evidence checks', {
          details: {
            issues: unreviewableIssues.map((issue) => issue.message),
          },
        })
      }
      return suggestions
    })
  }

  buildResumeDraft(inputValue: unknown): ResumeDraft {
    return this.#sync(() => {
      const input = parseInput(BuildResumeDraftInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const profile = this.#require('person_profile', input.profileId)
      const job = this.#require('job_snapshot', input.jobSnapshotId)
      if (profile.workspaceId !== input.workspaceId || job.workspaceId !== input.workspaceId) {
        this.#workspaceMismatch()
      }
      const timestamp = this.#now()
      const projectId = this.#idFactory('resume-project')
      const versionId = this.#idFactory('resume-version')
      const snapshots = new Map<string, EvidenceSnapshot>()
      const domainClaims: DomainResumeClaim[] = []
      const sectionMap = new Map<
        string,
        {
          id: string
          kind: ResumeDocument['sections'][number]['kind']
          title: string
          claims: ResumeDocument['sections'][number]['claims']
        }
      >()

      input.claims.forEach((claimInput, ordinal) => {
        const revision = this.#require('evidence_revision', claimInput.revisionId)
        const fact = this.#require('evidence_fact', revision.factId)
        const claimId = this.#idFactory('resume-claim')
        const domainClaim: DomainResumeClaim = {
          id: claimId,
          workspaceId: input.workspaceId,
          resumeVersionId: versionId,
          section: claimInput.sectionKind,
          ordinal,
          text: claimInput.text,
          factId: fact.id,
          evidenceRevisionId: revision.id,
          createdAt: timestamp,
        }
        const support = assertResumeClaimSupported(domainClaim, fact, revision)
        if (!support.ok) {
          throw new ApplicationError(
            'FACT_NOT_VERIFIED',
            support.error.message,
            applicationDetails(support.error.details),
          )
        }
        domainClaims.push(domainClaim)
        snapshots.set(revision.id, evidenceSnapshot(revision))
        const sectionKey = `${claimInput.sectionKind}:${claimInput.sectionTitle}`
        const section = sectionMap.get(sectionKey) ?? {
          id: this.#idFactory('resume-section'),
          kind: claimInput.sectionKind,
          title: claimInput.sectionTitle,
          claims: [],
        }
        section.claims.push({
          id: claimId,
          text: claimInput.text,
          evidenceRevisionIds: [revision.id],
          requirementIds: claimInput.requirementIds,
          userAttestation: null,
        })
        sectionMap.set(sectionKey, section)
      })

      const document = resumeDocumentSchema.parse({
        id: versionId,
        version: 1,
        language: input.locale,
        template: input.template,
        targetJobSnapshotId: job.id,
        candidateName: profile.preferredName ?? profile.displayName,
        contact: {
          ...(profile.email === undefined ? {} : { email: profile.email }),
          ...(profile.phone === undefined ? {} : { phone: profile.phone }),
          ...(profile.location === undefined ? {} : { location: profile.location }),
          links: input.links,
        },
        sections: [...sectionMap.values()],
        approvedAt: null,
        createdAt: timestamp,
      })
      const validation = validateResume(document, snapshots)
      const project: ResumeProject = {
        id: projectId,
        workspaceId: input.workspaceId,
        jobSnapshotId: job.id,
        profileId: profile.id,
        name: input.name,
        locale: input.locale,
        template: input.template,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      const version: ResumeVersion = {
        id: versionId,
        workspaceId: input.workspaceId,
        resumeProjectId: project.id,
        version: 1,
        status: 'draft',
        claimIds: domainClaims.map((claim) => claim.id),
        contentSha256: this.#resumeHash(document),
        validationErrors: validation.issues
          .filter((issue) => issue.blocking)
          .map((issue) => issue.message),
        createdBy: 'user',
        createdAt: timestamp,
      }
      const artifact: ResumeDraftArtifact = {
        id: versionId,
        workspaceId: input.workspaceId,
        resumeVersionId: versionId,
        jobSnapshotId: job.id,
        name: input.name,
        documentJson: JSON.stringify(document),
        contentSha256: version.contentSha256,
        tailoringRationales: input.tailoringRationales,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.#storage.transaction(() => {
        this.#storage.put('resume_project', project)
        this.#storage.put('resume_version', version)
        this.#storage.putMany('resume_claim', domainClaims)
        this.#storage.put('resume_draft_artifact', artifact)
      })
      return { project, version, claims: domainClaims, artifact, document, validation }
    })
  }

  attestResumeClaim(inputValue: unknown): AttestedResumeClaim {
    return this.#sync(() => {
      const input = parseInput(AttestResumeClaimInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const version = this.#require('resume_version', input.resumeVersionId)
      if (version.workspaceId !== input.workspaceId || input.document.id !== version.id) {
        this.#workspaceMismatch()
      }
      if (version.status === 'exported') {
        throw new ApplicationError('CONFLICT', 'An exported resume version is immutable')
      }
      if (input.document.approvedAt !== null) {
        throw new ApplicationError('RESUME_MUTATED', 'Only an unapproved draft may be reviewed')
      }
      assertEditable(input.document)
      if (this.#resumeHash(input.document) !== version.contentSha256) {
        throw new ApplicationError(
          'RESUME_MUTATED',
          'Resume content changed after the draft was stored',
        )
      }
      const artifact = this.#require('resume_draft_artifact', version.id)
      if (
        artifact.workspaceId !== input.workspaceId ||
        artifact.resumeVersionId !== version.id ||
        artifact.contentSha256 !== version.contentSha256
      ) {
        throw new ApplicationError('RESUME_MUTATED', 'Resume artifact does not match its version')
      }
      const matches = input.document.sections
        .flatMap((section) => section.claims)
        .filter((claim) => claim.id === input.claimId)
      const claim = matches[0]
      if (matches.length !== 1 || claim === undefined) {
        throw new ApplicationError('NOT_FOUND', 'Resume claim was not found exactly once')
      }
      if (input.confirmedText !== claim.text) {
        throw new ApplicationError(
          'RESUME_MUTATED',
          'Confirmation text must exactly match the current resume claim',
        )
      }

      const storedClaims = this.#storage
        .list('resume_claim', input.workspaceId)
        .filter((storedClaim) => storedClaim.resumeVersionId === version.id)
      const storedClaim = storedClaims.find((candidate) => candidate.id === claim.id)
      if (storedClaim === undefined) {
        throw new ApplicationError('RESUME_MUTATED', 'Stored resume claim is missing')
      }
      const snapshots = new Map<string, EvidenceSnapshot>()
      for (const candidate of storedClaims) {
        const fact = this.#require('evidence_fact', candidate.factId)
        const revision = this.#require('evidence_revision', candidate.evidenceRevisionId)
        const support = assertResumeClaimSupported(candidate, fact, revision)
        if (!support.ok) {
          throw new ApplicationError(
            'FACT_NOT_VERIFIED',
            support.error.message,
            applicationDetails(support.error.details),
          )
        }
        snapshots.set(revision.id, evidenceSnapshot(revision))
      }
      const source = snapshots.get(storedClaim.evidenceRevisionId)
      if (source === undefined || !claim.evidenceRevisionIds.includes(source.revisionId)) {
        throw new ApplicationError('RESUME_MUTATED', 'Resume claim evidence binding changed')
      }
      if (source.statement === claim.text) {
        throw new ApplicationError('CONFLICT', 'The original verified fact needs no attestation')
      }

      const confirmedAt = this.#now()
      const document = resumeDocumentSchema.parse({
        ...input.document,
        sections: input.document.sections.map((section) => ({
          ...section,
          claims: section.claims.map((candidate) =>
            candidate.id === claim.id
              ? {
                  ...candidate,
                  userAttestation: { confirmedText: candidate.text, confirmedAt },
                }
              : candidate,
          ),
        })),
      })
      const validation = validateResume(document, snapshots)
      const updatedVersion: ResumeVersion = {
        ...version,
        contentSha256: this.#resumeHash(document),
        validationErrors: validation.issues
          .filter((issue) => issue.blocking)
          .map((issue) => issue.message),
      }
      this.#storage.transaction(() => {
        this.#storage.put('resume_version', updatedVersion)
        this.#storage.put('resume_draft_artifact', {
          ...artifact,
          documentJson: JSON.stringify(document),
          contentSha256: updatedVersion.contentSha256,
          updatedAt: confirmedAt,
        })
      })
      return { version: updatedVersion, document, validation }
    })
  }

  async validateAndExportResume(inputValue: unknown): Promise<ResumeExport> {
    return this.#async(async () => {
      const input = parseInput(ValidateAndExportResumeInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const version = this.#require('resume_version', input.resumeVersionId)
      if (version.workspaceId !== input.workspaceId || input.document.id !== version.id) {
        this.#workspaceMismatch()
      }
      if (version.status === 'exported') {
        throw new ApplicationError('CONFLICT', 'This immutable resume version was already exported')
      }
      if (input.document.approvedAt !== null) {
        throw new ApplicationError(
          'RESUME_MUTATED',
          'Only an unapproved draft may enter validation',
        )
      }
      assertEditable(input.document)
      if (this.#resumeHash(input.document) !== version.contentSha256) {
        throw new ApplicationError(
          'RESUME_MUTATED',
          'Resume content changed after the draft was stored',
        )
      }
      const artifact = this.#require('resume_draft_artifact', version.id)
      let storedDocument: ResumeDocument
      try {
        storedDocument = resumeDocumentSchema.parse(JSON.parse(artifact.documentJson) as unknown)
      } catch (error) {
        throw new ApplicationError('RESUME_MUTATED', 'Stored resume artifact is invalid', {
          cause: error,
        })
      }
      if (
        artifact.workspaceId !== input.workspaceId ||
        artifact.resumeVersionId !== version.id ||
        artifact.contentSha256 !== version.contentSha256 ||
        this.#resumeHash(storedDocument) !== version.contentSha256
      ) {
        throw new ApplicationError('RESUME_MUTATED', 'Stored resume artifact changed unexpectedly')
      }
      const storedClaims = this.#storage
        .list('resume_claim', input.workspaceId)
        .filter((claim) => claim.resumeVersionId === version.id)
      if (
        !sameStringSet(
          storedClaims.map((claim) => claim.id),
          version.claimIds,
        )
      ) {
        throw new ApplicationError(
          'RESUME_MUTATED',
          'Stored resume claims no longer match this version',
        )
      }
      const snapshots = new Map<string, EvidenceSnapshot>()
      for (const claim of storedClaims) {
        const fact = this.#require('evidence_fact', claim.factId)
        const revision = this.#require('evidence_revision', claim.evidenceRevisionId)
        const support = assertResumeClaimSupported(claim, fact, revision)
        if (!support.ok) {
          throw new ApplicationError(
            'FACT_NOT_VERIFIED',
            support.error.message,
            applicationDetails(support.error.details),
          )
        }
        snapshots.set(revision.id, evidenceSnapshot(revision))
      }
      const validation = validateResume(input.document, snapshots)
      if (!validation.valid) {
        throw new ApplicationError('RESUME_INVALID', 'Resume validation found blocking issues', {
          details: { issues: validation.issues },
        })
      }
      const approvedAt = this.#now()
      const approvedDocument = resumeDocumentSchema.parse({ ...input.document, approvedAt })
      const exporter = input.format === 'html' ? new HtmlResumeExporter() : new TextResumeExporter()
      const bytes = await exporter.export(approvedDocument)
      const project = this.#require('resume_project', version.resumeProjectId)
      const exportedVersion: ResumeVersion = {
        ...version,
        status: 'exported',
        validationErrors: [],
        validatedAt: approvedAt,
      }
      const activeProject: ResumeProject = {
        ...project,
        activeVersionId: version.id,
        updatedAt: approvedAt,
      }
      if (input.commit) {
        this.#storage.transaction(() => {
          this.#storage.put('resume_version', exportedVersion)
          this.#storage.put('resume_project', activeProject)
        })
      }
      const safeName = safeFileBase(project.name)
      return {
        document: approvedDocument,
        bytes,
        mediaType:
          input.format === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
        filename: `${safeName}.${input.format === 'html' ? 'html' : 'txt'}`,
      }
    })
  }

  prepareExternalAction(inputValue: unknown): PreparedExternalAction {
    return this.#sync(() => {
      const input = parseInput(PrepareExternalActionInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const job = this.#require('job_snapshot', input.jobSnapshotId)
      if (job.workspaceId !== input.workspaceId) this.#workspaceMismatch()
      if (
        job.source !== input.target.platform ||
        job.externalId !== input.target.platformJobId ||
        job.companyName !== input.target.company ||
        job.title !== input.target.title
      ) {
        throw new ApplicationError(
          'CONFLICT',
          'Prepared action does not match the immutable job snapshot',
        )
      }
      const preparedAction = preparedActionSchema.parse(
        prepareConnectorAction({
          kind: input.kind,
          target: input.target,
          recipientId: input.recipientId,
          body: input.body,
          attachmentPath: input.attachmentPath,
          attachmentHash: input.attachmentHash,
        }),
      )
      const timestamp = this.#now()
      const attachmentSha256s =
        preparedAction.attachmentHash === null ? [] : [preparedAction.attachmentHash]
      const idempotencyKey = sha256Text(
        JSON.stringify({
          workspaceId: input.workspaceId,
          kind: preparedAction.kind,
          platform: preparedAction.target.platform,
          accountId: preparedAction.target.accountId,
          platformJobId: preparedAction.target.platformJobId,
          recipientId: preparedAction.recipientId,
          bodyHash: preparedAction.bodyHash,
          attachmentSha256s,
        }),
      )
      const duplicate = this.#storage
        .list('external_action', input.workspaceId)
        .find(
          (action) =>
            action.idempotencyKey === idempotencyKey &&
            !['failed', 'needs_user'].includes(action.status),
        )
      if (duplicate !== undefined) {
        throw new ApplicationError('DUPLICATE_ACTION', `Action ${duplicate.id} already exists`)
      }
      externalTransition('draft', 'awaiting_review')
      const domainAction: ExternalAction = {
        id: preparedAction.actionId,
        workspaceId: input.workspaceId,
        type: preparedAction.kind,
        target: {
          platform: preparedAction.target.platform,
          accountId: preparedAction.target.accountId,
          jobSnapshotId: input.jobSnapshotId,
          ...(preparedAction.recipientId === null
            ? {}
            : { recipientId: preparedAction.recipientId }),
        },
        bodySha256: preparedAction.bodyHash,
        attachmentSha256s,
        idempotencyKey,
        status: 'awaiting_review',
        attemptCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.#storage.put('external_action', domainAction)
      return { preparedAction, domainAction }
    })
  }

  authorizeExternalAction(inputValue: unknown): AuthorizedExternalAction {
    return this.#sync(() => {
      const input = parseInput(AuthorizeExternalActionInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const domainAction = this.#require('external_action', input.preparedAction.actionId)
      this.#assertPreparedMatchesDomain(input.workspaceId, input.preparedAction, domainAction)
      if (domainAction.status !== 'awaiting_review') {
        throw new ApplicationError('CONFLICT', 'Action is not waiting for user review')
      }
      const authorization = authorizeConnectorAction(input.preparedAction, {
        now: this.#clock(),
        ...(input.validForMs === undefined ? {} : { validForMs: input.validForMs }),
      })
      const domainResult = createActionAuthorization(domainAction, {
        id: authorization.authorizationId,
        nonce: authorization.nonce,
        authorizedAt: authorization.authorizedAt,
        expiresAt: authorization.expiresAt,
      })
      if (!domainResult.ok) {
        throw new ApplicationError(
          'AUTHORIZATION_INVALID',
          domainResult.error.message,
          applicationDetails(domainResult.error.details),
        )
      }
      externalTransition(domainAction.status, 'authorized')
      const authorizedAction: ExternalAction = {
        ...domainAction,
        status: 'authorized',
        authorizationId: domainResult.value.id,
        updatedAt: this.#now(),
      }
      this.#storage.transaction(() => {
        this.#storage.put('action_authorization', domainResult.value)
        this.#storage.put('external_action', authorizedAction)
      })
      return {
        preparedAction: input.preparedAction,
        domainAction: authorizedAction,
        authorization,
        domainAuthorization: domainResult.value,
      }
    })
  }

  async executeExternalAction(inputValue: unknown): Promise<ExecutedExternalAction> {
    return this.#async(async () => {
      const input = parseInput(ExecuteExternalActionInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const domainAction = this.#require('external_action', input.preparedAction.actionId)
      this.#assertPreparedMatchesDomain(input.workspaceId, input.preparedAction, domainAction)
      if (domainAction.status === 'outcome_unknown') {
        throw new ApplicationError(
          'ACTION_OUTCOME_UNKNOWN',
          'Unknown actions must be reconciled, never retried',
        )
      }
      if (['executing', 'succeeded', 'failed'].includes(domainAction.status)) {
        throw new ApplicationError(
          'DUPLICATE_ACTION',
          'This exact action cannot execute more than once',
        )
      }
      if (domainAction.status !== 'authorized' || domainAction.authorizationId === undefined) {
        throw new ApplicationError('AUTHORIZATION_INVALID', 'Action is not authorized')
      }
      const domainAuthorization = this.#require(
        'action_authorization',
        domainAction.authorizationId,
      )
      const authorizationCheck = validateActionAuthorization(
        domainAction,
        domainAuthorization,
        this.#now(),
      )
      if (!authorizationCheck.ok) {
        const code =
          authorizationCheck.error.code === 'AUTHORIZATION_CONSUMED'
            ? 'DUPLICATE_ACTION'
            : 'AUTHORIZATION_INVALID'
        throw new ApplicationError(
          code,
          authorizationCheck.error.message,
          applicationDetails(authorizationCheck.error.details),
        )
      }
      this.#assertConnectorAuthorizationMatchesDomain(input.authorization, domainAuthorization)
      const adapter = this.#adapter(input.preparedAction.target.platform)
      const runner = new SupervisedActionRunner(adapter, this.#clock)
      externalTransition(domainAction.status, 'executing')
      const executing: ExternalAction = {
        ...domainAction,
        status: 'executing',
        updatedAt: this.#now(),
      }
      this.#storage.put('external_action', executing)

      try {
        const result = await runner.execute(input.preparedAction, input.authorization)
        const consumed = consumeActionAuthorization(domainAuthorization, this.#now())
        if (!consumed.ok) {
          throw new ApplicationError('DUPLICATE_ACTION', consumed.error.message)
        }
        const completed = this.#actionAfterOutcome(executing, result.outcome)
        this.#storage.transaction(() => {
          this.#storage.put('action_authorization', consumed.value)
          this.#storage.put('external_action', completed)
        })
        return {
          outcome: result.outcome,
          authorization: result.authorization,
          domainAction: completed,
          automaticallyRetried: false,
        }
      } catch (error) {
        if (error instanceof ApplicationError) throw error
        if (error instanceof ConnectorError) {
          externalTransition(executing.status, 'needs_user')
          const needsUser: ExternalAction = {
            ...executing,
            status: 'needs_user',
            lastError: error.message,
            updatedAt: this.#now(),
          }
          this.#storage.put('external_action', needsUser)
          throw error
        }
        const consumed = consumeActionAuthorization(domainAuthorization, this.#now())
        if (!consumed.ok) throw new ApplicationError('DUPLICATE_ACTION', consumed.error.message)
        const outcome: ActionOutcome = {
          status: 'outcome_unknown',
          message: 'The platform call ended without a verifiable receipt',
          reconcileAfter: new Date(this.#clock().getTime() + 60_000).toISOString(),
        }
        const unknown = this.#actionAfterOutcome(executing, outcome)
        this.#storage.transaction(() => {
          this.#storage.put('action_authorization', consumed.value)
          this.#storage.put('external_action', unknown)
        })
        return {
          outcome,
          authorization: { ...input.authorization, consumedAt: this.#now() },
          domainAction: unknown,
          automaticallyRetried: false,
        }
      }
    })
  }

  async reconcileExternalAction(inputValue: unknown): Promise<ExecutedExternalAction> {
    return this.#async(async () => {
      const input = parseInput(ReconcileExternalActionInputSchema, inputValue)
      this.#requireWorkspace(input.workspaceId)
      const action = this.#require('external_action', input.preparedAction.actionId)
      this.#assertPreparedMatchesDomain(input.workspaceId, input.preparedAction, action)
      if (action.status !== 'outcome_unknown') {
        throw new ApplicationError('CONFLICT', 'Only an unknown outcome can be reconciled')
      }
      if (canAutomaticallyRetryExternalAction(action)) {
        throw new ApplicationError('INTERNAL', 'Unknown action was incorrectly marked retryable')
      }
      const authorization = this.#require('action_authorization', action.authorizationId ?? '')
      const connectorAuthorization: ConnectorAuthorization = {
        authorizationId: authorization.id,
        actionId: authorization.externalActionId,
        accountId: authorization.target.accountId,
        platformJobId: input.preparedAction.target.platformJobId,
        recipientId: authorization.target.recipientId ?? null,
        bodyHash: authorization.bodySha256,
        attachmentHash: authorization.attachmentSha256s[0] ?? null,
        nonce: authorization.nonce,
        authorizedAt: authorization.authorizedAt,
        expiresAt: authorization.expiresAt,
        consumedAt: authorization.consumedAt ?? this.#now(),
      }
      const runner = new SupervisedActionRunner(this.#adapter(input.preparedAction.target.platform))
      const outcome = await runner.reconcileUnknown(input.preparedAction)
      const reconciled = this.#actionAfterOutcome(action, outcome, false)
      this.#storage.put('external_action', reconciled)
      return {
        outcome,
        authorization: connectorAuthorization,
        domainAction: reconciled,
        automaticallyRetried: false,
      }
    })
  }

  #workspaceContext(workspace: Workspace, profile: PersonProfile | null): WorkspaceContext {
    const workspaceId = workspace.id
    return {
      workspace,
      profile,
      counts: {
        sourceDocuments: this.#storage.count('source_document', workspaceId),
        pendingFactProposals: this.#storage
          .list('fact_proposal', workspaceId)
          .filter((proposal) => proposal.status === 'pending').length,
        verifiedFacts: this.#storage
          .list('evidence_fact', workspaceId)
          .filter((fact) => fact.status === 'verified').length,
        jobs: this.#storage.count('job_snapshot', workspaceId),
        resumes: this.#storage.count('resume_version', workspaceId),
        externalActions: this.#storage.count('external_action', workspaceId),
      },
    }
  }

  #proposalDraftFingerprint(draft: FactProposalDraft): string {
    return sha256Text(
      JSON.stringify(
        stableValue({
          category: draft.category,
          title: draft.title,
          proposedClaim: draft.proposedClaim,
          proposedStructuredData: draft.proposedStructuredData,
          sources: [...draft.sources].sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
          conflictsWithFactIds: [...draft.conflictsWithFactIds].sort(),
        }),
      ),
    )
  }

  #proposalFingerprint(proposal: FactProposal): string {
    return this.#proposalDraftFingerprint({
      category: proposal.category,
      title: proposal.title,
      proposedClaim: proposal.proposedClaim,
      proposedStructuredData: proposal.proposedStructuredData,
      sources: proposal.sources,
      confidence: proposal.confidence,
      conflictsWithFactIds: proposal.conflictsWithFactIds,
      ...(proposal.rationale === undefined ? {} : { rationale: proposal.rationale }),
    })
  }

  #proposalFromDraft(workspaceId: string, draft: FactProposalDraft): FactProposal {
    return {
      id: this.#idFactory('proposal'),
      workspaceId,
      category: draft.category,
      title: draft.title,
      proposedClaim: draft.proposedClaim,
      proposedStructuredData: draft.proposedStructuredData,
      sources: draft.sources,
      confidence: draft.confidence,
      conflictsWithFactIds: draft.conflictsWithFactIds,
      status: 'pending',
      createdAt: this.#now(),
      ...(draft.rationale === undefined ? {} : { rationale: draft.rationale }),
    }
  }

  async #runAi<T>(
    workspaceId: string,
    operation: AiOperation,
    instructions: string,
    context: readonly AiContextItem[],
    consentValue: ExplicitAiConsent,
    outputSchema: ZodType<T>,
  ): Promise<T> {
    const consent = parseInput(ExplicitAiConsentSchema, consentValue)
    if (!consent.confirmed) {
      throw new ApplicationError('CONSENT_REQUIRED', 'AI processing was not explicitly approved')
    }
    if (context.some((item) => !item.aiAllowed)) {
      throw new ApplicationError(
        'AI_DATA_NOT_ALLOWED',
        'At least one context item disallows AI use',
      )
    }
    if (
      !sameStringSet(
        context.map((item) => item.id),
        consent.dataItemIds,
      )
    ) {
      throw new ApplicationError(
        'CONSENT_REQUIRED',
        'Approved data items do not exactly match the AI context',
      )
    }
    const timestamp = this.#now()
    const consentRecord: ConsentRecord = {
      id: this.#idFactory('consent'),
      workspaceId,
      purpose: 'ai_processing',
      provider: this.#aiProvider.id,
      dataItemIds: consent.dataItemIds,
      disclosureSha256: sha256Text(
        JSON.stringify({ operation, dataItemIds: [...consent.dataItemIds].sort() }),
      ),
      granted: true,
      grantedAt: timestamp,
    }
    const aiRun: AiRun = {
      id: this.#idFactory('ai-run'),
      workspaceId,
      provider: this.#aiProvider.id,
      operation,
      status: 'running',
      inputSha256: sha256Text(
        JSON.stringify({
          operation,
          instructions,
          context: context.map((item) => ({ id: item.id, content: item.content })),
        }),
      ),
      consentRecordId: consentRecord.id,
      startedAt: timestamp,
      createdAt: timestamp,
    }
    this.#storage.transaction(() => {
      this.#storage.put('consent_record', consentRecord)
      this.#storage.put('ai_run', aiRun)
    })
    try {
      const result = await this.#aiProvider.run({
        operation,
        instructions,
        context,
        outputSchema,
      })
      const completed: AiRun = {
        ...aiRun,
        status: 'succeeded',
        requestId: result.requestId,
        outputSha256: sha256Text(JSON.stringify(result.value)),
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        ...(result.model === null ? {} : { model: result.model }),
      }
      this.#storage.put('ai_run', completed)
      return result.value
    } catch (error) {
      const failed: AiRun = {
        ...aiRun,
        status: 'failed',
        errorCode: error instanceof AiProviderError ? error.code : 'INTERNAL',
        completedAt: this.#now(),
      }
      this.#storage.put('ai_run', failed)
      throw error
    }
  }

  #resumeHash(document: ResumeDocument): string {
    return sha256Text(JSON.stringify({ ...document, approvedAt: null }))
  }

  #assertPreparedMatchesDomain(
    workspaceId: string,
    prepared: PreparedAction,
    domainAction: ExternalAction,
  ): void {
    const unchanged =
      domainAction.workspaceId === workspaceId &&
      domainAction.id === prepared.actionId &&
      domainAction.type === prepared.kind &&
      domainAction.target.platform === prepared.target.platform &&
      domainAction.target.accountId === prepared.target.accountId &&
      (domainAction.target.recipientId ?? null) === prepared.recipientId &&
      domainAction.bodySha256 === prepared.bodyHash &&
      sameStringSet(
        domainAction.attachmentSha256s,
        prepared.attachmentHash === null ? [] : [prepared.attachmentHash],
      )
    if (!unchanged) {
      throw new ApplicationError(
        'AUTHORIZATION_INVALID',
        'Prepared action changed after it was stored',
      )
    }
    const job = this.#require('job_snapshot', domainAction.target.jobSnapshotId)
    if (
      job.externalId !== prepared.target.platformJobId ||
      job.companyName !== prepared.target.company ||
      job.title !== prepared.target.title
    ) {
      throw new ApplicationError('AUTHORIZATION_INVALID', 'Job identity changed after preparation')
    }
  }

  #assertConnectorAuthorizationMatchesDomain(
    connector: ConnectorAuthorization,
    domain: DomainAuthorization,
  ): void {
    const matches =
      connector.authorizationId === domain.id &&
      connector.actionId === domain.externalActionId &&
      connector.accountId === domain.target.accountId &&
      connector.recipientId === (domain.target.recipientId ?? null) &&
      connector.bodyHash === domain.bodySha256 &&
      connector.attachmentHash === (domain.attachmentSha256s[0] ?? null) &&
      connector.nonce === domain.nonce &&
      connector.authorizedAt === domain.authorizedAt &&
      connector.expiresAt === domain.expiresAt &&
      connector.consumedAt === null
    if (!matches) {
      throw new ApplicationError(
        'AUTHORIZATION_INVALID',
        'Execution authorization does not match the user-approved authorization',
      )
    }
  }

  #actionAfterOutcome(
    action: ExternalAction,
    outcome: ActionOutcome,
    incrementAttempt = true,
  ): ExternalAction {
    externalTransition(action.status, outcome.status)
    const errorMessage =
      outcome.status === 'failed'
        ? outcome.message
        : outcome.status === 'outcome_unknown'
          ? outcome.message
          : outcome.status === 'needs_user'
            ? outcome.reason
            : undefined
    const updated: ExternalAction = {
      ...action,
      status: outcome.status,
      attemptCount: action.attemptCount + (incrementAttempt ? 1 : 0),
      updatedAt: this.#now(),
      ...(errorMessage === undefined ? {} : { lastError: errorMessage }),
    }
    if (errorMessage === undefined) delete updated.lastError
    return updated
  }

  #adapter(platform: PlatformId): PlatformAdapter {
    const adapter = this.#connectors.get(platform)
    if (adapter === undefined) {
      throw new ApplicationError('CONNECTOR_UNAVAILABLE', `No connector for ${platform}`)
    }
    return adapter
  }

  #requireWorkspace(workspaceId: string): Workspace {
    return this.#require('workspace', workspaceId)
  }

  #require<K extends DomainEntityKind>(kind: K, id: string): DomainEntityMap[K] {
    const value = this.#storage.get(kind, id)
    if (value === undefined) throw new ApplicationError('NOT_FOUND', `${kind} ${id} was not found`)
    return value
  }

  #workspaceMismatch(): never {
    throw new ApplicationError('WORKSPACE_MISMATCH', 'Entity belongs to another workspace')
  }

  #now(): string {
    return this.#clock().toISOString()
  }

  #sync<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      throw toApplicationError(error)
    }
  }

  async #async<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw toApplicationError(error)
    }
  }
}
