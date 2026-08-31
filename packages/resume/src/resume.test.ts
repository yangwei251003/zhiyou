import { describe, expect, it } from 'vitest'

import { diffResumeClaims } from './diff.js'
import {
  resumeDocumentSchema,
  type EvidenceSnapshot,
  type ResumeDocument,
  type ResumeTemplate,
} from './model.js'
import { toAtsText, toSafeHtml } from './render.js'
import { assertEditable, validateResume } from './validation.js'

function exampleResume(
  text = '在校园媒体负责选题与采访，按期交付 12 篇报道',
  template: ResumeTemplate = 'ats_single_column',
): ResumeDocument {
  return {
    id: 'resume-1',
    version: 1,
    language: 'zh-CN',
    template,
    targetJobSnapshotId: 'job-1',
    candidateName: '林同学',
    contact: { email: 'lin@example.com', links: [] },
    sections: [
      {
        id: 'experience',
        kind: 'experience',
        title: '项目经历',
        claims: [
          {
            id: 'claim-1',
            text,
            evidenceRevisionIds: ['revision-1'],
            requirementIds: ['requirement-1'],
            userAttestation: null,
          },
        ],
      },
    ],
    approvedAt: null,
    createdAt: '2026-08-31T00:00:00.000Z',
  }
}

const evidence: EvidenceSnapshot = {
  revisionId: 'revision-1',
  factId: 'fact-1',
  status: 'verified',
  statement: '在校园媒体负责选题与采访，一个学期按期交付 12 篇报道。',
  allowedEntities: ['校园媒体'],
  allowedNumbers: ['12'],
  allowedDates: [],
  allowedSkills: ['采访'],
}

describe('resume evidence invariants', () => {
  it('accepts a claim backed by a verified immutable revision', () => {
    const result = validateResume(
      exampleResume(evidence.statement),
      new Map([[evidence.revisionId, evidence]]),
    )
    expect(result.valid).toBe(true)
    expect(result.referencedEvidenceCount).toBe(1)
  })

  it('blocks invented numeric impact', () => {
    const result = validateResume(
      exampleResume('负责校园媒体选题与采访，阅读量增长 300%'),
      new Map([[evidence.revisionId, evidence]]),
    )
    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_NUMBER' })]),
    )
  })

  it('does not treat a numeric substring as the same evidence value', () => {
    const result = validateResume(
      exampleResume('负责校园媒体选题与采访，交付 1 篇报道'),
      new Map([[evidence.revisionId, evidence]]),
    )
    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_NUMBER' })]),
    )
  })

  it('blocks an entirely invented entity, role, skill, and experience until exact-text attestation', () => {
    const fabricated = '曾任谷歌高级工程师，精通 Rust 并主导全球商业化战略'
    const document = exampleResume(fabricated)
    const blocked = validateResume(document, new Map([[evidence.revisionId, evidence]]))

    expect(blocked.valid).toBe(false)
    expect(blocked.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'USER_REVIEW_REQUIRED' })]),
    )

    const attested: ResumeDocument = {
      ...document,
      sections: document.sections.map((section) => ({
        ...section,
        claims: section.claims.map((claim) => ({
          ...claim,
          userAttestation: {
            confirmedText: fabricated,
            confirmedAt: '2026-08-31T01:00:00.000Z',
          },
        })),
      })),
    }
    expect(validateResume(attested, new Map([[evidence.revisionId, evidence]])).valid).toBe(true)
  })

  it('invalidates a prior attestation when the claim text changes', () => {
    const document = exampleResume('我确认这是真实改写')
    const staleAttestation: ResumeDocument = {
      ...document,
      sections: document.sections.map((section) => ({
        ...section,
        claims: section.claims.map((claim) => ({
          ...claim,
          text: '我确认这是真实改写，但后来又被改了',
          userAttestation: {
            confirmedText: '我确认这是真实改写',
            confirmedAt: '2026-08-31T01:00:00.000Z',
          },
        })),
      })),
    }

    expect(validateResume(staleAttestation, new Map([[evidence.revisionId, evidence]])).valid).toBe(
      false,
    )
  })

  it('ignores model-provided hidden allowlists for unsupported numbers and dates', () => {
    const poisonedEvidence: EvidenceSnapshot = {
      ...evidence,
      allowedNumbers: ['999%'],
      allowedDates: ['2029'],
      allowedEntities: ['Google'],
      allowedSkills: ['Rust'],
    }
    const document = exampleResume('2029 年在 Google 用 Rust 提升业务 999%')
    const result = validateResume(document, new Map([[evidence.revisionId, poisonedEvidence]]))

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'UNSUPPORTED_NUMBER' }),
        expect.objectContaining({ code: 'UNSUPPORTED_DATE' }),
        expect.objectContaining({ code: 'USER_REVIEW_REQUIRED' }),
      ]),
    )
  })

  it('does not permit mutation after approval', () => {
    const resume = { ...exampleResume(), approvedAt: '2026-08-31T01:00:00.000Z' }
    expect(() => assertEditable(resume)).toThrow('APPROVED_VERSION_MUTATED')
  })
})

describe('safe exports', () => {
  it('defaults legacy documents without a template to the safest ATS preset', () => {
    const legacyDocument: Record<string, unknown> = { ...exampleResume() }
    delete legacyDocument.template

    expect(resumeDocumentSchema.parse(legacyDocument).template).toBe('ats_single_column')
  })

  it('renders three distinct, static, single-column templates', () => {
    const templates = [
      'ats_single_column',
      'professional',
      'campus_project',
    ] as const satisfies readonly ResumeTemplate[]
    const htmlByTemplate = templates.map((template) =>
      toSafeHtml(exampleResume(undefined, template)),
    )

    expect(new Set(htmlByTemplate).size).toBe(3)
    templates.forEach((template, index) => {
      const html = htmlByTemplate[index]
      expect(html).toContain(`data-template="${template}"`)
      expect(html).toContain("default-src 'none'")
      expect(html).not.toMatch(/<script\b|<link\b|<table\b/i)
      expect(html).not.toMatch(/display\s*:\s*(grid|flex)|column-count|grid-template/i)
    })
  })

  it('escapes every untrusted text position and never emits executable markup', () => {
    const base = exampleResume('<script>alert(1)</script>')
    const hostile: ResumeDocument = {
      ...base,
      candidateName: '<img src=x onerror=alert(2)>',
      contact: { ...base.contact, location: '<svg onload=alert(3)>' },
      sections: base.sections.map((section) => ({
        ...section,
        title: '</h2><script>alert(4)</script>',
      })),
    }
    const html = toSafeHtml(hostile)

    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<svg')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
    expect(html).toContain('&lt;svg onload=alert(3)&gt;')
    expect(html).toContain("default-src 'none'")
  })

  it('keeps the plain ATS-readable representation identical across templates', () => {
    const baseline = toAtsText(exampleResume())

    expect(toAtsText(exampleResume(undefined, 'professional'))).toBe(baseline)
    expect(toAtsText(exampleResume(undefined, 'campus_project'))).toBe(baseline)
    expect(baseline).toContain('项目经历')
    expect(baseline).toContain('lin@example.com')
  })
})

describe('version diff', () => {
  it('reports changed claims as removed and added', () => {
    const before = exampleResume()
    const after = exampleResume('改写后的真实表述')
    expect(diffResumeClaims(before, after)).toEqual({
      added: ['claim-1'],
      removed: ['claim-1'],
      unchanged: [],
    })
  })
})
