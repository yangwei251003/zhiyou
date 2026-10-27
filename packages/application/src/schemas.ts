import {
  actionAuthorizationSchema as connectorAuthorizationSchema,
  externalActionKindSchema,
  jobIdentitySchema,
  preparedActionSchema,
} from '@bosshunter/connectors'
import {
  DocumentFragmentSchema,
  EntityIdSchema,
  EvidenceFactCategorySchema,
  JsonValueSchema,
  LocaleSchema,
  PermissionSetSchema,
  SourceDocumentSchema,
  SourceLocatorSchema,
} from '@bosshunter/domain'
import { DEFAULT_INGEST_LIMITS } from '@bosshunter/ingest'
import { resumeDocumentSchema } from '@bosshunter/resume'
import { z } from 'zod'

export const ExplicitAiConsentSchema = z
  .object({
    confirmed: z.boolean(),
    dataItemIds: z.array(EntityIdSchema).min(1),
  })
  .strict()
export type ExplicitAiConsent = z.infer<typeof ExplicitAiConsentSchema>

export const InitializeWorkspaceInputSchema = z
  .object({
    workspaceId: EntityIdSchema.optional(),
    profileId: EntityIdSchema.optional(),
    name: z.string().trim().min(1).max(120),
    locale: LocaleSchema,
    displayName: z.string().trim().min(1).max(120),
    preferredName: z.string().trim().min(1).max(120).optional(),
    email: z.string().email().max(320).optional(),
    phone: z.string().trim().min(5).max(64).optional(),
    location: z.string().trim().min(1).max(240).optional(),
    targetRoles: z.array(z.string().trim().min(1).max(160)).max(20),
    languages: z.array(z.string().trim().min(1).max(80)).max(20),
  })
  .strict()
export type InitializeWorkspaceInput = z.infer<typeof InitializeWorkspaceInputSchema>

export const LoadWorkspaceInputSchema = z.object({ workspaceId: EntityIdSchema }).strict()
export type LoadWorkspaceInput = z.infer<typeof LoadWorkspaceInputSchema>

const ParsedDocumentFragmentsSchema = z
  .array(DocumentFragmentSchema)
  .min(1)
  .max(DEFAULT_INGEST_LIMITS.maxFragments)
  .superRefine((fragments, context) => {
    const extractedCharacters = fragments.reduce(
      (total, fragment) => total + fragment.text.length,
      0,
    )
    if (extractedCharacters > DEFAULT_INGEST_LIMITS.maxExtractedCharacters) {
      context.addIssue({
        code: 'custom',
        message: 'Extracted document text exceeds the safe character limit',
      })
    }
  })

export const FactProposalDraftSchema = z
  .object({
    category: EvidenceFactCategorySchema,
    title: z.string().trim().min(1).max(240),
    proposedClaim: z.string().trim().min(1).max(4_000),
    proposedStructuredData: z.record(z.string(), JsonValueSchema),
    sources: z.array(SourceLocatorSchema).max(50),
    confidence: z.number().finite().min(0).max(1),
    conflictsWithFactIds: z.array(EntityIdSchema).max(50),
    rationale: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict()
export type FactProposalDraft = z.infer<typeof FactProposalDraftSchema>

export const ImportParsedDocumentInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    document: SourceDocumentSchema,
    fragments: ParsedDocumentFragmentsSchema,
  })
  .strict()
export type ImportParsedDocumentInput = z.infer<typeof ImportParsedDocumentInputSchema>

export const ProposeFactsForDocumentInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    documentId: EntityIdSchema,
    consent: ExplicitAiConsentSchema,
  })
  .strict()
export type ProposeFactsForDocumentInput = z.infer<typeof ProposeFactsForDocumentInputSchema>

export const ProposeFactsFromImportInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    document: SourceDocumentSchema,
    fragments: ParsedDocumentFragmentsSchema,
    consent: ExplicitAiConsentSchema,
  })
  .strict()
export type ProposeFactsFromImportInput = z.infer<typeof ProposeFactsFromImportInputSchema>

export const AcceptFactProposalInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    proposalId: EntityIdSchema,
    permissions: PermissionSetSchema,
    sensitivity: z.enum(['standard', 'sensitive', 'highly_sensitive']),
    claim: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
export type AcceptFactProposalInput = z.infer<typeof AcceptFactProposalInputSchema>

export const NextInterviewQuestionInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    factIds: z.array(EntityIdSchema).max(100),
    conversationMessages: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(12_000),
            aiAllowed: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    consent: ExplicitAiConsentSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.factIds.length === 0 && value.conversationMessages.length === 0) {
      context.addIssue({ code: 'custom', message: 'Interview context cannot be empty' })
    }
  })
export type NextInterviewQuestionInput = z.infer<typeof NextInterviewQuestionInputSchema>

export const InterviewQuestionOutputSchema = z
  .object({
    question: z.string().trim().min(1).max(2_000),
    rationale: z.string().trim().min(1).max(2_000),
    targetFactIds: z.array(EntityIdSchema).max(100),
    factProposals: z.array(FactProposalDraftSchema).max(20),
  })
  .strict()
export type InterviewQuestionOutput = z.infer<typeof InterviewQuestionOutputSchema>

export const JobRequirementDraftSchema = z
  .object({
    category: z.enum([
      'must_have',
      'nice_to_have',
      'responsibility',
      'soft_skill',
      'industry_term',
      'risk',
    ]),
    text: z.string().trim().min(1).max(2_000),
    normalizedKey: z.string().trim().min(1).max(240).optional(),
    priority: z.number().int().min(1).max(5),
    sourceStart: z.number().int().nonnegative().optional(),
    sourceEnd: z.number().int().positive().optional(),
  })
  .strict()

export const CreateJobAnalysisInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    source: z.enum(['manual', 'boss', 'zhilian', 'job51', 'liepin', 'other']),
    externalId: z.string().trim().min(1).max(240).optional(),
    sourceUrl: z.string().url().max(2_000).optional(),
    companyName: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(240),
    location: z.string().trim().min(1).max(240).optional(),
    salaryText: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().min(1).max(50_000),
    requirements: z.array(JobRequirementDraftSchema).min(1).max(500),
  })
  .strict()
export type CreateJobAnalysisInput = z.infer<typeof CreateJobAnalysisInputSchema>

export const DecomposeAndCreateJobAnalysisInputSchema = CreateJobAnalysisInputSchema.omit({
  requirements: true,
})
  .extend({
    contextItemId: EntityIdSchema,
    consent: ExplicitAiConsentSchema,
  })
  .strict()
export type DecomposeAndCreateJobAnalysisInput = z.infer<
  typeof DecomposeAndCreateJobAnalysisInputSchema
>

export const AnalyzeEvidenceGapInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    profileId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
  })
  .strict()
export type AnalyzeEvidenceGapInput = z.infer<typeof AnalyzeEvidenceGapInputSchema>

export const TailoredResumeClaimDraftSchema = z
  .object({
    revisionId: EntityIdSchema,
    text: z.string().trim().min(1).max(4_000),
    requirementIds: z.array(EntityIdSchema).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict()

export const TailorResumeClaimsInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    factIds: z.array(EntityIdSchema).min(1).max(100),
    consent: ExplicitAiConsentSchema,
  })
  .strict()
export type TailorResumeClaimsInput = z.infer<typeof TailorResumeClaimsInputSchema>

export const ResumeClaimDraftInputSchema = z
  .object({
    sectionKind: z.enum([
      'summary',
      'education',
      'experience',
      'project',
      'skill',
      'award',
      'other',
    ]),
    sectionTitle: z.string().trim().min(1).max(160),
    text: z.string().trim().min(1).max(4_000),
    revisionId: EntityIdSchema,
    requirementIds: z.array(EntityIdSchema).max(100),
  })
  .strict()

export const BuildResumeDraftInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    profileId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    name: z.string().trim().min(1).max(240),
    locale: LocaleSchema,
    template: z.enum(['ats_single_column', 'professional', 'campus_project']),
    links: z.array(z.string().url()).max(20),
    claims: z.array(ResumeClaimDraftInputSchema).min(1).max(500),
    tailoringRationales: z
      .record(EntityIdSchema, z.string().trim().min(1).max(2_000))
      .refine((value) => Object.keys(value).length <= 500, 'Too many tailoring rationales')
      .default({}),
  })
  .strict()
export type BuildResumeDraftInput = z.infer<typeof BuildResumeDraftInputSchema>

export const AttestResumeClaimInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    resumeVersionId: EntityIdSchema,
    claimId: EntityIdSchema,
    confirmedText: z.string().min(1).max(4_000),
    document: resumeDocumentSchema,
  })
  .strict()
export type AttestResumeClaimInput = z.infer<typeof AttestResumeClaimInputSchema>

export const ValidateAndExportResumeInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    resumeVersionId: EntityIdSchema,
    document: resumeDocumentSchema,
    format: z.enum(['text', 'html']),
    commit: z.boolean().default(true),
  })
  .strict()
export type ValidateAndExportResumeInput = z.infer<typeof ValidateAndExportResumeInputSchema>

export const PrepareExternalActionInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    jobSnapshotId: EntityIdSchema,
    kind: externalActionKindSchema,
    target: jobIdentitySchema,
    recipientId: z.string().trim().min(1).nullable(),
    body: z.string().max(20_000),
    attachmentPath: z.string().min(1).max(2_000).nullable(),
    attachmentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict()
export type PrepareExternalActionInput = z.infer<typeof PrepareExternalActionInputSchema>

export const AuthorizeExternalActionInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    preparedAction: preparedActionSchema,
    validForMs: z
      .number()
      .int()
      .min(10_000)
      .max(15 * 60_000)
      .optional(),
  })
  .strict()
export type AuthorizeExternalActionInput = z.infer<typeof AuthorizeExternalActionInputSchema>

export const ExecuteExternalActionInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    preparedAction: preparedActionSchema,
    authorization: connectorAuthorizationSchema,
  })
  .strict()
export type ExecuteExternalActionInput = z.infer<typeof ExecuteExternalActionInputSchema>

export const ReconcileExternalActionInputSchema = z
  .object({
    workspaceId: EntityIdSchema,
    preparedAction: preparedActionSchema,
  })
  .strict()
export type ReconcileExternalActionInput = z.infer<typeof ReconcileExternalActionInputSchema>
