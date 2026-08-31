import { z } from 'zod'

export const evidenceSnapshotSchema = z.object({
  revisionId: z.string().min(1),
  factId: z.string().min(1),
  status: z.literal('verified'),
  statement: z.string().min(1),
  allowedEntities: z.array(z.string()).default([]),
  allowedNumbers: z.array(z.string()).default([]),
  allowedDates: z.array(z.string()).default([]),
  allowedSkills: z.array(z.string()).default([]),
})

export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>

export const resumeClaimAttestationSchema = z
  .object({
    confirmedText: z.string().min(1).max(4_000),
    confirmedAt: z.string().datetime(),
  })
  .strict()

export const resumeClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  evidenceRevisionIds: z.array(z.string().min(1)).min(1),
  requirementIds: z.array(z.string().min(1)).default([]),
  userAttestation: resumeClaimAttestationSchema.nullable().default(null),
})

export const resumeSectionSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['summary', 'education', 'experience', 'project', 'skill', 'award', 'other']),
  title: z.string().min(1),
  claims: z.array(resumeClaimSchema),
})

export const resumeTemplateSchema = z.enum(['ats_single_column', 'professional', 'campus_project'])

export const resumeDocumentSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  language: z.enum(['zh-CN', 'en-US']),
  template: resumeTemplateSchema.default('ats_single_column'),
  targetJobSnapshotId: z.string().min(1),
  candidateName: z.string().min(1),
  contact: z.object({
    email: z.string().email().optional(),
    phone: z.string().min(5).optional(),
    location: z.string().optional(),
    links: z.array(z.string().url()).default([]),
  }),
  sections: z.array(resumeSectionSchema),
  approvedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

export type ResumeClaim = z.infer<typeof resumeClaimSchema>
export type ResumeTemplate = z.infer<typeof resumeTemplateSchema>
export type ResumeDocument = z.infer<typeof resumeDocumentSchema>

export interface JobRequirementInput {
  id: string
  label: string
  kind: 'must' | 'preferred' | 'responsibility' | 'soft_skill'
  keywords: readonly string[]
}

export interface RequirementCoverage {
  requirementId: string
  matchedClaimIds: string[]
  status: 'covered' | 'partial' | 'unknown'
}
