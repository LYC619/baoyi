/**
 * Unified runtime input validation and structured error helpers for Electron IPC boundaries.
 *
 * Per project conventions, validation happens once at the IPC boundary so internal
 * service functions can trust TypeScript types without redundant defensive checks.
 */

export type IpcErrorCode =
  | 'INVALID_ARGUMENT'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'INTERNAL'

export interface StructuredIpcError {
  ok: false
  code: IpcErrorCode
  message: string
  field?: string
}

export class IpcError extends Error {
  readonly code: IpcErrorCode
  readonly field?: string

  constructor(code: IpcErrorCode, message: string, field?: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
    if (field !== undefined) this.field = field
  }

  toJSON(): StructuredIpcError {
    return this.field !== undefined
      ? { ok: false, code: this.code, message: this.message, field: this.field }
      : { ok: false, code: this.code, message: this.message }
  }
}

export function invalidArg(field: string, reason: string): never {
  // Keep the raw Chinese contract for main-process classification; translate at the UI boundary.
  throw new IpcError('INVALID_ARGUMENT', `参数 ${field} 无效：${reason}`, field)
}

export function toStructuredIpcError(err: unknown): StructuredIpcError {
  if (err instanceof IpcError) return err.toJSON()
  const message = err instanceof Error ? err.message : String(err || '未知错误')
  const rawCode = (err && typeof err === 'object' && 'code' in err) ? String((err as { code?: unknown }).code || '') : ''
  if (rawCode.startsWith('SQLITE_CONSTRAINT')) return { ok: false, code: 'CONFLICT', message }
  if (/只允许主窗口|隐私内容|权限|禁止|越界|拒绝/.test(message)) return { ok: false, code: 'FORBIDDEN', message }
  if (/不存在|未找到|找不到/.test(message)) return { ok: false, code: 'NOT_FOUND', message }
  if (/正在退出|正在恢复|未就绪|还有操作正在进行/.test(message)) return { ok: false, code: 'UNAVAILABLE', message }
  if (/参数|无效|不能为空|格式/.test(message)) return { ok: false, code: 'INVALID_ARGUMENT', message }
  if (/冲突|同名|已存在|版本/.test(message)) return { ok: false, code: 'CONFLICT', message }
  return { ok: false, code: 'INTERNAL', message }
}

const MAX_IPC_ARGS = 12
const MAX_PAYLOAD_DEPTH = 16
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isBinary(value: unknown): boolean {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isBinary(value) || value instanceof Date) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype || Object.getPrototypeOf(proto) === null
}

function inspectPayload(value: unknown, channel: string, depth: number, seen: WeakSet<object>): void {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.includes('\0')) invalidArg(channel, '包含不支持的控制字符')
    return
  }
  if (typeof value !== 'object' || isBinary(value) || value instanceof Date) return
  if (depth > MAX_PAYLOAD_DEPTH) invalidArg(channel, '嵌套层级过深')
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) inspectPayload(value[i], channel, depth + 1, seen)
    return
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) invalidArg(channel, `包含不支持的字段名 ${key}`)
    inspectPayload((value as Record<string, unknown>)[key], channel, depth + 1, seen)
  }
}

/** Universal IPC boundary guard against prototype pollution, NUL bytes, and excessive payload nesting. */
export function assertSafeIpcArgs(channel: string, args: unknown[]): void {
  if (args.length > MAX_IPC_ARGS) invalidArg(channel, `参数数量超过上限 (${MAX_IPC_ARGS})`)
  const seen = new WeakSet<object>()
  for (let i = 0; i < args.length; i++) inspectPayload(args[i], channel, 0, seen)
}

export interface StringOptions {
  max?: number
  min?: number
  allowEmpty?: boolean
  trim?: boolean
}

export function reqString(value: unknown, field: string, opts: StringOptions = {}): string {
  if (typeof value !== 'string') invalidArg(field, '文本格式不正确')
  if (value.includes('\0')) invalidArg(field, '包含不支持的控制字符')
  const out = opts.trim ? value.trim() : value
  const max = opts.max ?? 10_000
  const min = opts.min ?? (opts.allowEmpty ? 0 : 1)
  if (out.length < min) invalidArg(field, min === 1 ? '不能为空' : `长度不能小于 ${min}`)
  if (out.length > max) invalidArg(field, `长度不能超过 ${max}`)
  return out
}

export function optString(value: unknown, field: string, opts: StringOptions = {}): string | undefined {
  if (value === undefined || value === null) return undefined
  return reqString(value, field, { allowEmpty: true, ...opts })
}

export function reqId(value: unknown, field = 'id'): string {
  return reqString(value, field, { max: 256, trim: true })
}

export function optId(value: unknown, field = 'id'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return reqId(value, field)
}

export function reqRecord<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, field: string): T {
  if (!isPlainObject(value)) invalidArg(field, '数据格式不正确')
  return value as T
}

export function optRecord<T extends Record<string, unknown> = Record<string, unknown>>(value: unknown, field: string): T | undefined {
  if (value === undefined || value === null) return undefined
  return reqRecord<T>(value, field)
}

export function reqArray<T = unknown>(value: unknown, field: string, opts: { min?: number; max?: number } = {}): T[] {
  if (!Array.isArray(value)) invalidArg(field, '列表格式不正确')
  if (opts.min !== undefined && value.length < opts.min) invalidArg(field, `长度不能小于 ${opts.min}`)
  if (opts.max !== undefined && value.length > opts.max) invalidArg(field, `长度不能超过 ${opts.max}`)
  return value as T[]
}

export function optArray<T = unknown>(value: unknown, field: string, opts: { min?: number; max?: number } = {}): T[] | undefined {
  if (value === undefined || value === null) return undefined
  return reqArray<T>(value, field, opts)
}

export function reqStringArray(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; itemMax?: number; allowEmpty?: boolean } = {}
): string[] {
  const arr = reqArray(value, field, { min: opts.min, max: opts.max ?? 10_000 })
  return arr.map((item, i) => reqString(item, `${field}[${i}]`, { max: opts.itemMax ?? 4096, allowEmpty: opts.allowEmpty ?? false }))
}

export function optStringArray(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; itemMax?: number; allowEmpty?: boolean } = {}
): string[] | undefined {
  if (value === undefined || value === null) return undefined
  return reqStringArray(value, field, opts)
}

export function reqBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalidArg(field, '开关状态不正确')
  return value
}

export function optBool(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined
  return reqBool(value, field)
}

export function reqNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalidArg(field, '需填写有效数字')
  if (opts.integer && !Number.isInteger(value)) invalidArg(field, '请填写整数')
  if (opts.min !== undefined && value < opts.min) invalidArg(field, `不能小于 ${opts.min}`)
  if (opts.max !== undefined && value > opts.max) invalidArg(field, `不能大于 ${opts.max}`)
  return value
}

export function optNumber(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {}
): number | undefined {
  if (value === undefined || value === null) return undefined
  return reqNumber(value, field, opts)
}

export function reqEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalidArg(field, `只允许 ${allowed.join(' / ')}`)
  }
  return value as T
}

export function optEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T | undefined {
  if (value === undefined || value === null) return undefined
  return reqEnum(value, allowed, field)
}

export function validateLanguageSetting(value: unknown): 'system' | 'zh-CN' | 'en' {
  return reqEnum(value, ['system', 'zh-CN', 'en'] as const, 'language')
}

export function reqUrl(value: unknown, field: string, protocols: readonly string[] = ['http:', 'https:']): string {
  const raw = reqString(value, field, { max: 8192, trim: true })
  let parsed: URL
  try { parsed = new URL(raw) } catch { invalidArg(field, '不是合法链接') }
  if (!protocols.includes(parsed.protocol)) invalidArg(field, `仅支持 ${protocols.join(' / ')} 协议`)
  return parsed.href
}

export function optUrl(value: unknown, field: string, protocols: readonly string[] = ['http:', 'https:']): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return reqUrl(value, field, protocols)
}

export function reqBytes(value: unknown, field: string, maxBytes = 64 * 1024 * 1024): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0 || value.byteLength > maxBytes) invalidArg(field, '文件或数据大小超出限制')
    return value
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0 || value.byteLength > maxBytes) invalidArg(field, '文件或数据大小超出限制')
    return new Uint8Array(value)
  }
  invalidArg(field, '数据格式不正确')
}
