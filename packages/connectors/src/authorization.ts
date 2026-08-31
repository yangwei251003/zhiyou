import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { ActionAuthorization, PreparedAction } from './contracts.js'
import { ConnectorError } from './contracts.js'

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export function prepareAction(
  input: Omit<PreparedAction, 'actionId' | 'bodyHash' | 'preparedAt'>,
): PreparedAction {
  return {
    ...input,
    actionId: randomUUID(),
    bodyHash: sha256(input.body),
    preparedAt: new Date().toISOString(),
  }
}

export function authorizeAction(
  action: PreparedAction,
  options: { now?: Date; validForMs?: number } = {},
): ActionAuthorization {
  const now = options.now ?? new Date()
  const validForMs = options.validForMs ?? 5 * 60_000
  return {
    authorizationId: randomUUID(),
    actionId: action.actionId,
    accountId: action.target.accountId,
    platformJobId: action.target.platformJobId,
    recipientId: action.recipientId,
    bodyHash: action.bodyHash,
    attachmentHash: action.attachmentHash,
    nonce: randomBytes(24).toString('base64url'),
    authorizedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + validForMs).toISOString(),
    consumedAt: null,
  }
}

export function validateAuthorization(
  action: PreparedAction,
  authorization: ActionAuthorization,
  now = new Date(),
): void {
  if (authorization.consumedAt) {
    throw new ConnectorError('DUPLICATE_ACTION', 'This authorization was already consumed')
  }
  if (Date.parse(authorization.expiresAt) <= now.getTime()) {
    throw new ConnectorError('AUTHORIZATION_INVALID', 'Authorization expired')
  }
  const unchanged =
    authorization.actionId === action.actionId &&
    authorization.accountId === action.target.accountId &&
    authorization.platformJobId === action.target.platformJobId &&
    authorization.recipientId === action.recipientId &&
    authorization.bodyHash === sha256(action.body) &&
    authorization.bodyHash === action.bodyHash &&
    authorization.attachmentHash === action.attachmentHash
  if (!unchanged) {
    throw new ConnectorError(
      'AUTHORIZATION_INVALID',
      'Target, message, or attachment changed after approval',
    )
  }
}

export function consumeAuthorization(
  authorization: ActionAuthorization,
  now = new Date(),
): ActionAuthorization {
  if (authorization.consumedAt) {
    throw new ConnectorError('DUPLICATE_ACTION', 'This authorization was already consumed')
  }
  return { ...authorization, consumedAt: now.toISOString() }
}
