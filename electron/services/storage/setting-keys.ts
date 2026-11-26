import type { SqlDb } from './schema.ts'
import { transaction } from '../../workspace/validation.ts'

/** The database module binds Electron's system vault after app readiness. */
interface KeyVault {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(bytes: Buffer): string
  getSelectedStorageBackend?(): string
}
const vaults = new WeakMap<SqlDb, KeyVault>()
export function bindKeyVault(db: SqlDb, vault: KeyVault) { vaults.set(db, vault) }
function vault(db: SqlDb) {
  const value = vaults.get(db)
  if (!value?.isEncryptionAvailable() || (process.platform === 'linux' && value.getSelectedStorageBackend?.() === 'basic_text')) {
    throw new Error('系统加密服务不可用，请解锁系统密钥库后重试')
  }
  return value
}

type Encrypted = { safeStorageV1: string }
type Secret = string | Encrypted
function mapKeys(key: string, value: any, transform: (secret: Secret) => Secret) {
  const config = (item: { api_key?: Secret }) => item?.api_key ? { ...item, api_key: transform(item.api_key) } : item
  if (key === 'ai_profiles') return value.map(config)
  return key === 'ai' || key === 'tmdb' || key === 'search' ? config(value) : value
}
function encrypt(db: SqlDb, plain: string): Encrypted {
  return { safeStorageV1: vault(db).encryptString(plain).toString('base64') }
}
export function protectSetting(db: SqlDb, key: string, value: unknown) {
  return mapKeys(key, value, plain => {
    if (typeof plain !== 'string') throw new Error('API Key 格式无效')
    return encrypt(db, plain)
  })
}
export function revealSetting(db: SqlDb, key: string, value: unknown) {
  return mapKeys(key, value, secret => typeof secret === 'string' ? secret : vault(db).decryptString(Buffer.from(secret.safeStorageV1, 'base64')))
}
/** Schema 32: all existing keys move together or the old settings stay intact. */
export function migrateSettingKeys(db: SqlDb) {
  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('ai','ai_profiles','search','tmdb')").all() as {key:string;value:string}[]
  const write = db.prepare('UPDATE settings SET value=? WHERE key=?')
  transaction(db, () => {
    for (const row of rows) {
      const updated = mapKeys(row.key, JSON.parse(row.value), plain => typeof plain === 'string' ? encrypt(db, plain) : plain)
      write.run(JSON.stringify(updated), row.key)
    }
  })
}
