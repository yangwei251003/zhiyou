import { z } from 'zod'

import {
  ActorSchema,
  EntityIdSchema,
  JsonValueSchema,
  LocaleSchema,
  PermissionSetSchema,
  Sha256Schema,
  SourceLocatorSchema,
  TimestampSchema,
} from './common.js'

const nonEmptyText = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.string().trim().min(1).max(max).optional()
const percentage = z.number().finite().min(0).max(100)

export const WorkspaceSchema = z
  .object({
    id: EntityIdSchema,
    name: nonEmptyText(120),
    locale: LocaleSchema,
    schemaVersion: z.number().int().positive(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type Workspace = z.infer<typeof WorkspaceSchema>

export const PersonProfileSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    displayName: nonEmptyText(120),
    preferredName: optionalText(120),
    headline: optionalText(240),
    summary: optionalText(4_000),
    email: z.string().email().max(320).optional(),
    phone: optionalText(64),
    location: optionalText(240),
    targetRoles: z.array(nonEmptyText(160)).max(20),
    languages: z.array(nonEmptyText(80)).max(20),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type PersonProfile = z.infer<typeof PersonProfileSchema>

export const DocumentStatusSchema = z.enum([
  'queued',
  'parsing',
  'needs_ocr',
  'review',
  'completed',
  'failed',
])
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>

export const SourceDocumentSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    kind: z.enum([
      'resume',
      'transcript',
      'certificate',
      'portfolio',
      'reference',
      'identity',
      'other',
    ]),
    originalName: nonEmptyText(255),
    mimeType: nonEmptyText(160),
    byteSize: z.number().int().nonnegative(),
    sha256: Sha256Schema,
    encryptedStorageKey: nonEmptyText(512),
    status: DocumentStatusSchema,
    pageCount: z.number().int().positive().optional(),
    requiresOcr: z.boolean(),
    failureReason: optionalText(1_000),
    importedAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type SourceDocument = z.infer<typeof SourceDocumentSchema>

export const DocumentFragmentSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    documentId: EntityIdSchema,
    ordinal: z.number().int().nonnegative(),
    page: z.number().int().positive().optional(),
    section: optionalText(240),
    text: nonEmptyText(20_000),
    sha256: Sha256Schema,
    createdAt: TimestampSchema,
  })
  .strict()
export type DocumentFragment = z.infer<typeof DocumentFragmentSchema>

export const FactStatusSchema = z.enum([
  'proposed',
  'verified',
  'disputed',
  'superseded',
  'deleted',
])
export type FactStatus = z.infer<typeof FactStatusSchema>

export const EvidenceFactCategorySchema = z.enum([
  'experience',
  'project',
  'education',
  'skill',
  'award',
  'certification',
  'metric',
  'preference',
  'constraint',
  'language',
  'volunteer',
  'research',
  'publication',
])

export const EvidenceFactSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    category: EvidenceFactCategorySchema,
    title: nonEmptyText(240),
    status: FactStatusSchema,
    currentRevisionId: EntityIdSchema.optional(),
    sensitivity: z.enum(['standard', 'sensitive', 'highly_sensitive']),
    permissions: PermissionSetSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type EvidenceFact = z.infer<typeof EvidenceFactSchema>

export const EvidenceRevisionStatusSchema = z.enum([
  'proposed',
  'verified',
  'disputed',
  'superseded',
])

export const EvidenceRevisionSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    factId: EntityIdSchema,
    version: z.number().int().positive(),
    claim: nonEmptyText(4_000),
    structuredData: z.record(z.string(), JsonValueSchema),
    status: EvidenceRevisionStatusSchema,
    sources: z.array(SourceLocatorSchema).max(50),
    createdBy: ActorSchema,
    createdAt: TimestampSchema,
    verifiedAt: TimestampSchema.optional(),
    verifiedBy: z.enum(['user', 'trusted_import']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === 'verified' &&
      (value.verifiedAt === undefined || value.verifiedBy === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Verified evidence revisions require verifiedAt and verifiedBy',
      })
    }
    if (
      value.status !== 'verified' &&
      (value.verifiedAt !== undefined || value.verifiedBy !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only verified evidence revisions may carry verification metadata',
      })
    }
  })
export type EvidenceRevision = z.infer<typeof EvidenceRevisionSchema>

export const FactProposalSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    category: EvidenceFactCategorySchema,
    title: nonEmptyText(240),
    proposedClaim: nonEmptyText(4_000),
    proposedStructuredData: z.record(z.string(), JsonValueSchema),
    sources: z.array(SourceLocatorSchema).max(50),
    confidence: z.number().finite().min(0).max(1),
    conflictsWithFactIds: z.array(EntityIdSchema).max(50),
    status: z.enum(['pending', 'accepted', 'rejected']),
    rationale: optionalText(2_000),
    createdAt: TimestampSchema,
    reviewedAt: TimestampSchema.optional(),
  })
  .strict()
export type FactProposal = z.infer<typeof FactProposalSchema>

export const SkillEvidenceSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    factId: EntityIdSchema,
    revisionId: EntityIdSchema,
    skillName: nonEmptyText(160),
    canonicalName: nonEmptyText(160),
    proficiency: z.enum(['awareness', 'working', 'proficient', 'advanced', 'expert']),
    lastUsedAt: TimestampSchema.optional(),
    evidenceStrength: z.enum(['weak', 'moderate', 'strong']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type SkillEvidence = z.infer<typeof SkillEvidenceSchema>

export const CareerPreferenceSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    targetRoles: z.array(nonEmptyText(160)).max(20),
    targetIndustries: z.array(nonEmptyText(160)).max(20),
    locations: z.array(nonEmptyText(160)).max(30),
    workModes: z.array(z.enum(['onsite', 'hybrid', 'remote'])).max(3),
    employmentTypes: z.array(z.enum(['internship', 'full_time', 'part_time', 'contract'])).max(4),
    salaryMinimum: z.number().finite().nonnegative().optional(),
    salaryCurrency: z.string().length(3).optional(),
    dealBreakers: z.array(nonEmptyText(500)).max(50),
    notes: optionalText(4_000),
    updatedAt: TimestampSchema,
  })
  .strict()
export type CareerPreference = z.infer<typeof CareerPreferenceSchema>

export const InterviewSessionSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    profileId: EntityIdSchema,
    status: z.enum(['not_started', 'in_progress', 'paused', 'completed', 'abandoned']),
    focus: z.enum(['onboarding', 'experience', 'project', 'skills', 'career_target', 'gap_review']),
    messageCount: z.number().int().nonnegative(),
    unresolvedQuestions: z.array(nonEmptyText(1_000)).max(100),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    updatedAt: TimestampSchema,
  })
  .strict()
export type InterviewSession = z.infer<typeof InterviewSessionSchema>

export const JobSnapshotSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    source: z.enum(['manual', 'boss', 'zhilian', 'job51', 'liepin', 'other']),
    externalId: optionalText(240),
    sourceUrl: z.string().url().max(2_000).optional(),
    companyName: nonEmptyText(240),
    title: nonEmptyText(240),
    location: optionalText(240),
    salaryText: optionalText(160),
    description: nonEmptyText(50_000),
    descriptionSha256: Sha256Schema,
    capturedAt: TimestampSchema,
    closedAt: TimestampSchema.optional(),
  })
  .strict()
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>

export const JobRequirementSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    category: z.enum([
      'must_have',
      'nice_to_have',
      'responsibility',
      'soft_skill',
      'industry_term',
      'risk',
    ]),
    text: nonEmptyText(2_000),
    normalizedKey: optionalText(240),
    priority: z.number().int().min(1).max(5),
    sourceStart: z.number().int().nonnegative().optional(),
    sourceEnd: z.number().int().positive().optional(),
  })
  .strict()
export type JobRequirement = z.infer<typeof JobRequirementSchema>

export const RequirementAssessmentSchema = z
  .object({
    requirementId: EntityIdSchema,
    verdict: z.enum(['supported', 'partial', 'unknown', 'gap']),
    revisionIds: z.array(EntityIdSchema).max(50),
    explanation: nonEmptyText(2_000),
  })
  .strict()

export const MatchReportSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    profileId: EntityIdSchema,
    assessments: z.array(RequirementAssessmentSchema),
    evidenceCoverage: percentage,
    factCompleteness: percentage,
    expressionClarity: percentage,
    recruiterScanQuality: percentage,
    textParseCompatibility: percentage,
    riskFlags: z.array(nonEmptyText(1_000)).max(100),
    generatedAt: TimestampSchema,
  })
  .strict()
export type MatchReport = z.infer<typeof MatchReportSchema>

export const LearningActionSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    matchReportId: EntityIdSchema,
    requirementId: EntityIdSchema,
    gapType: z.enum(['expression', 'evidence', 'adjacent_capability', 'true_skill']),
    title: nonEmptyText(240),
    outcome: nonEmptyText(1_000),
    evidenceToProduce: nonEmptyText(1_000),
    estimatedHours: z.number().finite().positive().max(10_000).optional(),
    status: z.enum(['planned', 'in_progress', 'completed', 'dismissed']),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type LearningAction = z.infer<typeof LearningActionSchema>

export const ResumeProjectSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    profileId: EntityIdSchema,
    name: nonEmptyText(240),
    locale: LocaleSchema,
    template: z.enum(['ats_single_column', 'professional', 'campus_project']),
    activeVersionId: EntityIdSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type ResumeProject = z.infer<typeof ResumeProjectSchema>

export const ResumeVersionSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    resumeProjectId: EntityIdSchema,
    version: z.number().int().positive(),
    status: z.enum(['draft', 'validated', 'exported', 'superseded']),
    parentVersionId: EntityIdSchema.optional(),
    claimIds: z.array(EntityIdSchema),
    contentSha256: Sha256Schema,
    validationErrors: z.array(nonEmptyText(1_000)).max(200),
    createdBy: ActorSchema,
    createdAt: TimestampSchema,
    validatedAt: TimestampSchema.optional(),
  })
  .strict()
export type ResumeVersion = z.infer<typeof ResumeVersionSchema>

export const ResumeClaimSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    resumeVersionId: EntityIdSchema,
    section: z.enum(['summary', 'experience', 'project', 'education', 'skill', 'award', 'other']),
    ordinal: z.number().int().nonnegative(),
    text: nonEmptyText(4_000),
    factId: EntityIdSchema,
    evidenceRevisionId: EntityIdSchema,
    createdAt: TimestampSchema,
  })
  .strict()
export type ResumeClaim = z.infer<typeof ResumeClaimSchema>

/**
 * The complete renderable draft is a first-class encrypted domain record.
 *
 * Keeping this artifact beside ResumeProject/ResumeVersion/ResumeClaim lets the
 * application commit all parts of a draft in one SQLite transaction. The
 * document remains JSON here so the resume package owns its detailed schema;
 * application and desktop boundaries parse it with resumeDocumentSchema.
 */
export const ResumeDraftArtifactSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    resumeVersionId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    name: nonEmptyText(240),
    documentJson: nonEmptyText(4_000_000),
    contentSha256: Sha256Schema,
    tailoringRationales: z.record(EntityIdSchema, nonEmptyText(2_000)),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== value.resumeVersionId) {
      context.addIssue({
        code: 'custom',
        message: 'Resume draft artifact identity must equal its resume version identity',
      })
    }
    if (Object.keys(value.tailoringRationales).length > 500) {
      context.addIssue({
        code: 'custom',
        message: 'Resume draft artifact has too many tailoring rationales',
      })
    }
  })
export type ResumeDraftArtifact = z.infer<typeof ResumeDraftArtifactSchema>

export const ApplicationStatusSchema = z.enum([
  'discovered',
  'analyzed',
  'shortlisted',
  'tailored',
  'ready_to_apply',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
])
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>

export const ApplicationSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    resumeVersionId: EntityIdSchema.optional(),
    status: ApplicationStatusSchema,
    sourceAccountId: EntityIdSchema.optional(),
    appliedAt: TimestampSchema.optional(),
    nextActionAt: TimestampSchema.optional(),
    notes: optionalText(4_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type Application = z.infer<typeof ApplicationSchema>

export const ExternalActionStatusSchema = z.enum([
  'draft',
  'awaiting_review',
  'authorized',
  'executing',
  'succeeded',
  'failed',
  'outcome_unknown',
  'needs_user',
])
export type ExternalActionStatus = z.infer<typeof ExternalActionStatusSchema>

export const ExternalActionTargetSchema = z
  .object({
    platform: z.enum(['boss', 'zhilian', 'job51', 'liepin', 'other']),
    accountId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    recipientId: EntityIdSchema.optional(),
  })
  .strict()
export type ExternalActionTarget = z.infer<typeof ExternalActionTargetSchema>

export const ExternalActionSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    type: z.enum(['apply', 'send_greeting', 'send_resume', 'send_reply']),
    target: ExternalActionTargetSchema,
    bodySha256: Sha256Schema,
    attachmentSha256s: z.array(Sha256Schema).max(20),
    idempotencyKey: nonEmptyText(240),
    status: ExternalActionStatusSchema,
    authorizationId: EntityIdSchema.optional(),
    attemptCount: z.number().int().nonnegative(),
    lastError: optionalText(2_000),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
export type ExternalAction = z.infer<typeof ExternalActionSchema>

export const ActionAuthorizationSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    externalActionId: EntityIdSchema,
    target: ExternalActionTargetSchema,
    bodySha256: Sha256Schema,
    attachmentSha256s: z.array(Sha256Schema).max(20),
    bindingSha256: Sha256Schema,
    nonce: nonEmptyText(240),
    authorizedBy: z.literal('user'),
    authorizedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    consumedAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.authorizedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'expiresAt must be later than authorizedAt',
      })
    }
    if (
      value.consumedAt !== undefined &&
      Date.parse(value.consumedAt) < Date.parse(value.authorizedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'consumedAt cannot predate authorizedAt',
      })
    }
  })
export type ActionAuthorization = z.infer<typeof ActionAuthorizationSchema>

export const AiConnectionStateSchema = z.enum([
  'not_installed',
  'startup',
  'auth_required',
  'ready',
  'rate_limited',
  'incompatible',
  'offline',
  'crashed',
])
export type AiConnectionState = z.infer<typeof AiConnectionStateSchema>

export const AiRunSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    provider: nonEmptyText(160),
    operation: z.enum([
      'extract_fact_proposals',
      'next_interview_question',
      'decompose_job',
      'match_evidence',
      'rewrite_resume_claims',
      'draft_recruiter_reply',
      'create_learning_plan',
    ]),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    model: optionalText(160),
    requestId: optionalText(240),
    inputSha256: Sha256Schema,
    outputSha256: Sha256Schema.optional(),
    consentRecordId: EntityIdSchema,
    errorCode: optionalText(160),
    startedAt: TimestampSchema.optional(),
    completedAt: TimestampSchema.optional(),
    createdAt: TimestampSchema,
  })
  .strict()
export type AiRun = z.infer<typeof AiRunSchema>

export const ConsentRecordSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    purpose: z.enum(['ai_processing', 'platform_action', 'export', 'backup']),
    provider: optionalText(160),
    dataItemIds: z.array(EntityIdSchema),
    disclosureSha256: Sha256Schema,
    granted: z.boolean(),
    grantedAt: TimestampSchema,
    revokedAt: TimestampSchema.optional(),
  })
  .strict()
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>

export const AuditEventSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    actor: ActorSchema,
    action: nonEmptyText(240),
    entityType: optionalText(160),
    entityId: EntityIdSchema.optional(),
    outcome: z.enum(['success', 'denied', 'failed', 'unknown']),
    metadata: z.record(z.string(), JsonValueSchema),
    occurredAt: TimestampSchema,
  })
  .strict()
export type AuditEvent = z.infer<typeof AuditEventSchema>

export const BackupManifestSchema = z
  .object({
    id: EntityIdSchema,
    workspaceId: EntityIdSchema,
    formatVersion: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    appVersion: nonEmptyText(80),
    encrypted: z.literal(true),
    cipher: z.literal('AES-256-GCM'),
    archiveSha256: Sha256Schema,
    recordCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .strict()
export type BackupManifest = z.infer<typeof BackupManifestSchema>

export const DomainEntitySchemaMap = {
  workspace: WorkspaceSchema,
  person_profile: PersonProfileSchema,
  source_document: SourceDocumentSchema,
  document_fragment: DocumentFragmentSchema,
  evidence_fact: EvidenceFactSchema,
  evidence_revision: EvidenceRevisionSchema,
  fact_proposal: FactProposalSchema,
  skill_evidence: SkillEvidenceSchema,
  career_preference: CareerPreferenceSchema,
  interview_session: InterviewSessionSchema,
  job_snapshot: JobSnapshotSchema,
  job_requirement: JobRequirementSchema,
  match_report: MatchReportSchema,
  learning_action: LearningActionSchema,
  resume_project: ResumeProjectSchema,
  resume_version: ResumeVersionSchema,
  resume_claim: ResumeClaimSchema,
  resume_draft_artifact: ResumeDraftArtifactSchema,
  application: ApplicationSchema,
  external_action: ExternalActionSchema,
  action_authorization: ActionAuthorizationSchema,
  ai_run: AiRunSchema,
  consent_record: ConsentRecordSchema,
  audit_event: AuditEventSchema,
  backup_manifest: BackupManifestSchema,
} as const

export type DomainEntityMap = {
  workspace: Workspace
  person_profile: PersonProfile
  source_document: SourceDocument
  document_fragment: DocumentFragment
  evidence_fact: EvidenceFact
  evidence_revision: EvidenceRevision
  fact_proposal: FactProposal
  skill_evidence: SkillEvidence
  career_preference: CareerPreference
  interview_session: InterviewSession
  job_snapshot: JobSnapshot
  job_requirement: JobRequirement
  match_report: MatchReport
  learning_action: LearningAction
  resume_project: ResumeProject
  resume_version: ResumeVersion
  resume_claim: ResumeClaim
  resume_draft_artifact: ResumeDraftArtifact
  application: Application
  external_action: ExternalAction
  action_authorization: ActionAuthorization
  ai_run: AiRun
  consent_record: ConsentRecord
  audit_event: AuditEvent
  backup_manifest: BackupManifest
}

export const DomainEntityKindSchema = z.enum(
  Object.keys(DomainEntitySchemaMap) as [keyof DomainEntityMap, ...(keyof DomainEntityMap)[]],
)
export type DomainEntityKind = z.infer<typeof DomainEntityKindSchema>
