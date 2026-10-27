import type { JobRequirementInput, RequirementCoverage, ResumeDocument } from './model.js'

function normalizedWords(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .split(/[\s,，。.;；:：/|()（）-]+/)
      .filter((word) => word.length > 1),
  )
}

export function calculateRequirementCoverage(
  resume: ResumeDocument,
  requirements: readonly JobRequirementInput[],
): RequirementCoverage[] {
  const claims = resume.sections.flatMap((section) => section.claims)
  return requirements.map((requirement) => {
    const requirementWords = new Set([
      ...normalizedWords(requirement.label),
      ...requirement.keywords.flatMap((keyword) => [...normalizedWords(keyword)]),
    ])
    const matchedClaimIds = claims
      .filter((claim) => {
        if (claim.requirementIds.includes(requirement.id)) return true
        const claimWords = normalizedWords(claim.text)
        return [...requirementWords].some((word) => claimWords.has(word))
      })
      .map((claim) => claim.id)
    return {
      requirementId: requirement.id,
      matchedClaimIds,
      status: matchedClaimIds.length > 0 ? 'covered' : 'unknown',
    }
  })
}
