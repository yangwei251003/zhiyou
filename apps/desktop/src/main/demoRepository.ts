import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, dialog, safeStorage } from 'electron'
import type { SaveResult, SelectedEvidenceFile } from '../shared/contracts'
import { isHostEncryptionSecure } from './security'

const MAX_DEMO_STATE_BYTES = 2 * 1024 * 1024
const STATE_FILE_NAME = 'career-evidence-demo.bhlocal'

interface EncryptedEnvelope {
  version: 1
  encrypted: true
  payload: string
}

function statePath(): string {
  return join(app.getPath('userData'), STATE_FILE_NAME)
}

function serializeSnapshot(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  try {
    const serialized = JSON.stringify(snapshot)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DEMO_STATE_BYTES) return null
    return serialized
  } catch {
    return null
  }
}

export async function loadDemoState(): Promise<unknown> {
  if (!isHostEncryptionSecure()) return null
  try {
    const raw = await readFile(statePath(), 'utf8')
    const envelope = JSON.parse(raw) as Partial<EncryptedEnvelope>
    if (
      envelope.version !== 1 ||
      envelope.encrypted !== true ||
      typeof envelope.payload !== 'string'
    ) {
      return null
    }
    const decrypted = safeStorage.decryptString(Buffer.from(envelope.payload, 'base64'))
    return JSON.parse(decrypted) as unknown
  } catch {
    return null
  }
}

export async function saveDemoState(snapshot: unknown): Promise<SaveResult> {
  const serialized = serializeSnapshot(snapshot)
  if (!serialized) {
    return { saved: false, savedAt: null, reason: 'INVALID_PAYLOAD' }
  }
  if (!isHostEncryptionSecure()) {
    return { saved: false, savedAt: null, reason: 'ENCRYPTION_UNAVAILABLE' }
  }

  const target = statePath()
  await mkdir(dirname(target), { recursive: true })
  const envelope: EncryptedEnvelope = {
    version: 1,
    encrypted: true,
    payload: safeStorage.encryptString(serialized).toString('base64'),
  }
  await writeFile(target, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
  return { saved: true, savedAt: new Date().toISOString() }
}

export async function clearDemoState(): Promise<void> {
  await rm(statePath(), { force: true })
}

export async function selectEvidenceFiles(): Promise<SelectedEvidenceFile[]> {
  const result = await dialog.showOpenDialog({
    title: '选择用于建立职业档案的资料',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '支持的资料', extensions: ['pdf', 'docx', 'md', 'txt', 'png', 'jpg', 'jpeg'] },
    ],
  })
  if (result.canceled) return []

  return Promise.all(
    result.filePaths.map(async (filePath) => {
      const normalized = filePath.replaceAll('\\', '/')
      const name = normalized.split('/').at(-1) ?? '未命名资料'
      const extension = name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : ''
      const metadata = await stat(filePath)
      return {
        id: randomUUID(),
        name,
        extension,
        size: metadata.size,
        selectedAt: new Date().toISOString(),
      }
    }),
  )
}
