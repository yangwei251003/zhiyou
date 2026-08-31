export type VaultOpeningPolicy = 'encrypted' | 'memory-only' | 'locked'

export const LOCKED_VAULT_MESSAGE =
  '系统安全加密当前不可用，已有本机职业库已锁定且未被打开。请先恢复系统加密后重启应用；锁定期间不能创建、修改或导出资料。'

/**
 * Fail closed when durable data exists but the operating system cannot safely
 * unwrap its key. Memory-only mode is allowed only when there is no durable
 * vault to conceal.
 */
export function chooseVaultOpeningPolicy(input: {
  encryptionSecure: boolean
  persistentDataPresent: boolean
}): VaultOpeningPolicy {
  if (input.encryptionSecure) return 'encrypted'
  return input.persistentDataPresent ? 'locked' : 'memory-only'
}
