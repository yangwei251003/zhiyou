import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { StorageError } from './errors.js'

export interface SensitiveFieldCodec {
  readonly algorithm: string
  encrypt(plaintext: string, additionalAuthenticatedData?: string): string
  decrypt(encoded: string, additionalAuthenticatedData?: string): string
}

const ENVELOPE_PREFIX = 'bhenc:v1'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export class Aes256GcmCodec implements SensitiveFieldCodec {
  readonly algorithm = 'AES-256-GCM'
  readonly #key: Buffer

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new StorageError('ENCRYPTION_REQUIRED', 'AES-256-GCM requires a 32-byte host key')
    }
    this.#key = Buffer.from(key)
  }

  encrypt(plaintext: string, additionalAuthenticatedData?: string): string {
    try {
      const iv = randomBytes(IV_LENGTH)
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      })
      if (additionalAuthenticatedData !== undefined) {
        cipher.setAAD(Buffer.from(additionalAuthenticatedData, 'utf8'))
      }
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const authTag = cipher.getAuthTag()
      return [
        ENVELOPE_PREFIX,
        iv.toString('base64url'),
        authTag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join(':')
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError('ENCRYPTION_FAILED', 'Could not encrypt sensitive data', error)
    }
  }

  decrypt(encoded: string, additionalAuthenticatedData?: string): string {
    try {
      const parts = encoded.split(':')
      if (parts.length !== 5 || `${parts[0]}:${parts[1]}` !== ENVELOPE_PREFIX) {
        throw new StorageError('STORAGE_CORRUPT', 'Encrypted field has an unsupported envelope')
      }
      const iv = Buffer.from(parts[2] ?? '', 'base64url')
      const authTag = Buffer.from(parts[3] ?? '', 'base64url')
      const ciphertext = Buffer.from(parts[4] ?? '', 'base64url')
      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new StorageError('STORAGE_CORRUPT', 'Encrypted field envelope is malformed')
      }
      const decipher = createDecipheriv('aes-256-gcm', this.#key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      })
      if (additionalAuthenticatedData !== undefined) {
        decipher.setAAD(Buffer.from(additionalAuthenticatedData, 'utf8'))
      }
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError(
        'ENCRYPTION_FAILED',
        'Could not decrypt sensitive data; the key, context, or payload is invalid',
        error,
      )
    }
  }
}
