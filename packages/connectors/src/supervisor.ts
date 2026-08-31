import type {
  ActionAuthorization,
  ActionOutcome,
  PlatformAdapter,
  PlatformCapabilities,
  PreparedAction,
} from './contracts.js'
import { ConnectorError } from './contracts.js'
import { consumeAuthorization, validateAuthorization } from './authorization.js'

function capabilityFor(action: PreparedAction): keyof PlatformCapabilities {
  switch (action.kind) {
    case 'apply':
      return 'apply'
    case 'send_greeting':
      return 'sendGreeting'
    case 'send_resume':
      return 'sendResume'
    case 'send_reply':
      return 'sendReply'
  }
}

export class SupervisedActionRunner {
  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(
    action: PreparedAction,
    authorization: ActionAuthorization,
  ): Promise<{ outcome: ActionOutcome; authorization: ActionAuthorization }> {
    validateAuthorization(action, authorization, this.clock())
    const capability = capabilityFor(action)
    if (!this.adapter.capabilities[capability]) {
      throw new ConnectorError(
        'CAPABILITY_UNAVAILABLE',
        `${this.adapter.id} does not support ${action.kind}`,
      )
    }
    if (action.target.platform !== this.adapter.id) {
      throw new ConnectorError('IDENTITY_MISMATCH', 'Action targets a different platform')
    }

    const health = await this.adapter.health()
    if (health.accountId !== action.target.accountId) {
      throw new ConnectorError('IDENTITY_MISMATCH', 'Signed-in platform account changed')
    }
    if (health.status !== 'ready') {
      const reasons = {
        login_required: 'AUTH_REQUIRED',
        captcha: 'CAPTCHA_REQUIRED',
        risk: 'CAPTCHA_REQUIRED',
        platform_changed: 'PLATFORM_CHANGED',
        offline: 'SESSION_EXPIRED',
      } as const
      throw new ConnectorError(reasons[health.status], health.message)
    }

    const consumed = consumeAuthorization(authorization, this.clock())
    const outcome = await this.adapter.execute(action, consumed)
    return { outcome, authorization: consumed }
  }

  async reconcileUnknown(action: PreparedAction): Promise<ActionOutcome> {
    return this.adapter.reconcile(action)
  }
}
