const crypto = require('crypto')
const logger = require('./logger')

// AES-256-GCM for sensitive fields that need to be decrypted later for legitimate use (unlike
// passwords, which are hashed and never decrypted). GCM's auth tag also means tampered ciphertext
// fails to decrypt instead of silently returning garbage.
const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
// Marks a value as "this is our ciphertext", distinguishing it unambiguously from legacy
// plaintext already in the database from before this field was encrypted — a plain substring/
// colon check wouldn't be reliable since real server-access text often contains colons itself
// (e.g. "https://host:port", "user: admin").
const PREFIX = 'enc:v1:'

function getKey() {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error('ENCRYPTION_KEY is not configured')
  const buf = Buffer.from(key, 'hex')
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  return buf
}

function encrypt(plainText) {
  if (!plainText) return ''
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

// Fails safe on read — a list of many submissions shouldn't 500 entirely because one field can't
// be decrypted (wrong/rotated key, corrupted data); that one value just reads as unreadable
// instead of breaking the whole request. Encryption failures (see encrypt() above) are NOT
// caught the same way — if a value can't be encrypted before saving, the write should fail
// loudly rather than silently persist it as plaintext.
function decrypt(value) {
  if (!value) return ''
  if (!isEncrypted(value)) return value
  try {
    const [ivHex, authTagHex, ciphertextHex] = value.slice(PREFIX.length).split(':')
    const iv = Buffer.from(ivHex, 'hex')
    const authTag = Buffer.from(authTagHex, 'hex')
    const ciphertext = Buffer.from(ciphertextHex, 'hex')
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv)
    decipher.setAuthTag(authTag)
    const plainText = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plainText.toString('utf8')
  } catch (err) {
    logger.error({ err }, 'Failed to decrypt field')
    return '[unable to decrypt]'
  }
}

module.exports = { encrypt, decrypt, isEncrypted }
