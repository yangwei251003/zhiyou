import type {
  ActionOutcome,
  CollectionPage,
  CollectionQuery,
  CollectedJob,
  JobIdentity,
  PlatformAdapter,
  PlatformCapabilities,
  PlatformHealth,
  PlatformId,
  PreparedAction,
} from './contracts.js'
import { PLATFORM_CAPABILITIES } from './contracts.js'

export class MockPlatformAdapter implements PlatformAdapter {
  readonly capabilities: PlatformCapabilities
  executed: PreparedAction[] = []

  constructor(
    readonly id: PlatformId,
    private currentHealth: PlatformHealth,
    private readonly jobs: CollectedJob[] = [],
    private outcome: ActionOutcome = {
      status: 'succeeded',
      receiptId: 'mock-receipt',
      observedAt: new Date(0).toISOString(),
      evidence: { source: 'mock' },
    },
  ) {
    this.capabilities = PLATFORM_CAPABILITIES[id]
  }

  setHealth(health: PlatformHealth): void {
    this.currentHealth = health
  }

  setOutcome(outcome: ActionOutcome): void {
    this.outcome = outcome
  }

  health(): Promise<PlatformHealth> {
    return Promise.resolve(this.currentHealth)
  }

  collect(query: CollectionQuery): Promise<CollectionPage> {
    return Promise.resolve({ jobs: this.jobs.slice(0, query.limit), nextCursor: null })
  }

  inspect(identity: JobIdentity): Promise<CollectedJob> {
    const found = this.jobs.find((job) => job.identity.platformJobId === identity.platformJobId)
    if (!found) return Promise.reject(new Error('Mock job not found'))
    return Promise.resolve(found)
  }

  execute(action: PreparedAction): Promise<ActionOutcome> {
    this.executed.push(action)
    return Promise.resolve(this.outcome)
  }

  reconcile(): Promise<ActionOutcome> {
    return Promise.resolve(this.outcome)
  }
}
