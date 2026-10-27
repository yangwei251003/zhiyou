import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { authorizeAction, prepareAction, validateAuthorization } from './authorization.js'
import { browserCommandSchema } from './browser-protocol.js'
import { ConnectorError } from './contracts.js'
import { MockPlatformAdapter } from './mock.js'
import { SupervisedActionRunner } from './supervisor.js'

const target = {
  platform: 'boss' as const,
  accountId: 'account-1',
  platformJobId: 'job-1',
  canonicalUrl: 'https://www.zhipin.com/job_detail/example.html',
  company: '示例科技',
  title: '产品实习生',
}

function action() {
  return prepareAction({
    kind: 'send_reply',
    target,
    recipientId: 'thread-1',
    body: '您好，我会在今天下午发送作品集。',
    attachmentPath: null,
    attachmentHash: null,
  })
}

describe('one-time action authorization', () => {
  it('invalidates approval after message edits', () => {
    const prepared = action()
    const authorization = authorizeAction(prepared)
    expect(() =>
      validateAuthorization({ ...prepared, body: '已经悄悄修改的正文' }, authorization),
    ).toThrow(ConnectorError)
  })

  it('binds approval to the exact target account and job', () => {
    const prepared = action()
    const authorization = authorizeAction(prepared)
    expect(() =>
      validateAuthorization(
        { ...prepared, target: { ...prepared.target, platformJobId: randomUUID() } },
        authorization,
      ),
    ).toThrow('Target, message, or attachment changed')
  })
})

describe('supervised fail-closed execution', () => {
  it('never executes when a captcha is present', async () => {
    const adapter = new MockPlatformAdapter('boss', {
      status: 'captcha',
      accountId: 'account-1',
      message: '需要人工完成验证',
    })
    const prepared = action()
    await expect(
      new SupervisedActionRunner(adapter).execute(prepared, authorizeAction(prepared)),
    ).rejects.toMatchObject({ code: 'CAPTCHA_REQUIRED' })
    expect(adapter.executed).toHaveLength(0)
  })

  it('consumes authorization exactly once before execution', async () => {
    const adapter = new MockPlatformAdapter('boss', {
      status: 'ready',
      accountId: 'account-1',
      message: 'ready',
    })
    const prepared = action()
    const result = await new SupervisedActionRunner(adapter).execute(
      prepared,
      authorizeAction(prepared),
    )
    expect(result.outcome.status).toBe('succeeded')
    expect(result.authorization.consumedAt).not.toBeNull()
    expect(adapter.executed).toHaveLength(1)
  })

  it('does not offer write capabilities for read-only platforms', async () => {
    const adapter = new MockPlatformAdapter('zhilian', {
      status: 'ready',
      accountId: 'account-1',
      message: 'ready',
    })
    const prepared = {
      ...action(),
      target: { ...target, platform: 'zhilian' as const },
    }
    const authorization = authorizeAction(prepared)
    await expect(
      new SupervisedActionRunner(adapter).execute(prepared, authorization),
    ).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' })
  })
})

describe('browser worker protocol', () => {
  it('has no arbitrary script or filesystem command', () => {
    expect(
      browserCommandSchema.safeParse({ type: 'eval', script: 'document.cookie' }).success,
    ).toBe(false)
    expect(
      browserCommandSchema.safeParse({ type: 'writeFile', path: 'C:\\anywhere' }).success,
    ).toBe(false)
  })
})
