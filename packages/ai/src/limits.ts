import { Buffer } from 'node:buffer'

import type { AiContextItem } from './types.js'

export const MAX_AI_CONTEXT_ITEMS = 128
export const MAX_AI_CONTEXT_BYTES = 256 * 1024
export const MAX_RPC_LINE_BYTES = 2 * 1024 * 1024

export function measureAiContextBytes(context: readonly AiContextItem[]): number {
  return Buffer.byteLength(JSON.stringify({ context }), 'utf8')
}
