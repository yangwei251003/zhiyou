import type { EvidenceSnapshot, ResumeDocument } from './model.js'

export type ResumeValidationIssueCode =
  | 'EVIDENCE_MISSING'
  | 'UNSUPPORTED_NUMBER'
  | 'UNSUPPORTED_DATE'
  | 'UNSUPPORTED_ENTITY'
  | 'UNSUPPORTED_SKILL'
  | 'USER_REVIEW_REQUIRED'
  | 'EMPTY_SECTION'
  | 'APPROVED_VERSION_MUTATED'

export interface ResumeValidationIssue {
  code: ResumeValidationIssueCode
  claimId: string | null
  message: string
  blocking: boolean
}

export interface ResumeValidationResult {
  valid: boolean
  issues: ResumeValidationIssue[]
  referencedEvidenceCount: number
}

const numberPattern = /(?<![\p{L}\p{N}])(?:\d+(?:[.,]\d+)?%?|\d+\+)(?![\p{L}\p{N}])/gu
const datePattern = /(?:19|20)\d{2}(?:[./\-年](?:0?[1-9]|1[0-2])月?)?/gu

function valuesIn(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0])
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s,，。.;；:：()（）]/g, '')
}

export function validateResume(
  resume: ResumeDocument,
  evidence: ReadonlyMap<string, EvidenceSnapshot>,
): ResumeValidationResult {
  const issues: ResumeValidationIssue[] = []
  const referenced = new Set<string>()

  for (const section of resume.sections) {
    if (section.claims.length === 0) {
      issues.push({
        code: 'EMPTY_SECTION',
        claimId: null,
        message: `“${section.title}”没有可用内容`,
        blocking: false,
      })
    }
    for (const claim of section.claims) {
      const snapshots = claim.evidenceRevisionIds
        .map((id) => evidence.get(id))
        .filter((item): item is EvidenceSnapshot => item !== undefined)
      if (snapshots.length !== claim.evidenceRevisionIds.length || snapshots.length === 0) {
        issues.push({
          code: 'EVIDENCE_MISSING',
          claimId: claim.id,
          message: '该表述缺少已核验的事实版本',
          blocking: true,
        })
        continue
      }
      claim.evidenceRevisionIds.forEach((id) => referenced.add(id))
      const sourceText = snapshots.map((item) => item.statement).join('\n')
      const sourceNumbers = new Set(valuesIn(sourceText, numberPattern).map(normalize))
      const sourceDates = new Set(valuesIn(sourceText, datePattern).map(normalize))

      for (const value of valuesIn(claim.text, numberPattern)) {
        if (!sourceNumbers.has(normalize(value))) {
          issues.push({
            code: 'UNSUPPORTED_NUMBER',
            claimId: claim.id,
            message: `数字“${value}”没有事实依据`,
            blocking: true,
          })
        }
      }
      for (const value of valuesIn(claim.text, datePattern)) {
        if (!sourceDates.has(normalize(value))) {
          issues.push({
            code: 'UNSUPPORTED_DATE',
            claimId: claim.id,
            message: `日期“${value}”没有事实依据`,
            blocking: true,
          })
        }
      }

      const isOriginalEvidenceText = snapshots.some((snapshot) => snapshot.statement === claim.text)
      const isExactlyAttested = claim.userAttestation?.confirmedText === claim.text
      if (!isOriginalEvidenceText && !isExactlyAttested) {
        issues.push({
          code: 'USER_REVIEW_REQUIRED',
          claimId: claim.id,
          message: '该表述偏离原事实文字，必须由你逐条确认真实后才能导出',
          blocking: true,
        })
      }
    }
  }

  return {
    valid: !issues.some((issue) => issue.blocking),
    issues,
    referencedEvidenceCount: referenced.size,
  }
}

export function assertEditable(resume: ResumeDocument): void {
  if (resume.approvedAt) {
    throw new Error(
      'APPROVED_VERSION_MUTATED: approved resumes are immutable; create a new version',
    )
  }
}
