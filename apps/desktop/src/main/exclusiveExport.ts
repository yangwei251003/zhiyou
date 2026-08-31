import { rm, writeFile } from 'node:fs/promises'

import { ApplicationError } from '@bosshunter/application'

export interface ExclusiveExportOperations {
  write(destination: string, bytes: Uint8Array): Promise<void>
  remove(destination: string): Promise<void>
}

const defaultOperations: ExclusiveExportOperations = {
  async write(destination, bytes) {
    await writeFile(destination, bytes, { mode: 0o600, flag: 'wx' })
  },
  async remove(destination) {
    await rm(destination, { force: true })
  },
}

export async function writeExclusiveCommittedExport<T>(input: {
  destination: string
  bytes: Uint8Array
  commit: () => Promise<T>
  operations?: ExclusiveExportOperations
}): Promise<T> {
  const operations = input.operations ?? defaultOperations
  try {
    await operations.write(input.destination, input.bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ApplicationError('INVALID_INPUT', 'Resume export target already exists', {
        userMessage: '为保护已有文件，BossHunter 不会覆盖同名简历。请选择一个新的文件名。',
        cause: error,
      })
    }
    throw error
  }

  try {
    return await input.commit()
  } catch (error) {
    try {
      await operations.remove(input.destination)
    } catch (cleanupError) {
      throw new ApplicationError(
        'STORAGE_FAILED',
        'Resume file was written but export state could not be committed or cleaned up',
        {
          userMessage: `简历文件可能已保存在“${input.destination}”，但导出状态提交失败且无法自动清理。请立即检查并手动删除或妥善保管。`,
          cause: new AggregateError([error, cleanupError]),
        },
      )
    }
    throw error
  }
}
