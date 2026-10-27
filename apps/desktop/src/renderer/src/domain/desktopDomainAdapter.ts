import type { DemoWorkspace, EvidenceFact, ResumeClaim } from '../store/types'

/**
 * Clean boundary for the future @bosshunter/domain integration. The renderer never
 * mutates domain entities directly; it asks this adapter for projections and checks.
 */
export const desktopDomainAdapter = {
  verifiedFacts(workspace: DemoWorkspace): EvidenceFact[] {
    return workspace.facts.filter((fact) => fact.status === 'verified')
  },
  unsupportedClaims(workspace: DemoWorkspace): ResumeClaim[] {
    const verifiedIds = new Set(
      workspace.facts.filter((fact) => fact.status === 'verified').map((fact) => fact.id),
    )
    return workspace.resumeClaims.filter(
      (claim) => claim.included && claim.sourceFactIds.some((id) => !verifiedIds.has(id)),
    )
  },
}
