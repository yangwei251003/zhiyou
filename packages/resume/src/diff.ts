import type { ResumeDocument } from './model.js'

export interface ResumeDiff {
  added: string[]
  removed: string[]
  unchanged: string[]
}

export function diffResumeClaims(before: ResumeDocument, after: ResumeDocument): ResumeDiff {
  const beforeClaims = new Map(
    before.sections.flatMap((section) => section.claims).map((claim) => [claim.id, claim.text]),
  )
  const afterClaims = new Map(
    after.sections.flatMap((section) => section.claims).map((claim) => [claim.id, claim.text]),
  )
  const added: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []
  for (const [id, text] of afterClaims) {
    if (!beforeClaims.has(id) || beforeClaims.get(id) !== text) added.push(id)
    else unchanged.push(id)
  }
  for (const [id, text] of beforeClaims) {
    if (!afterClaims.has(id) || afterClaims.get(id) !== text) removed.push(id)
  }
  return { added, removed, unchanged }
}
