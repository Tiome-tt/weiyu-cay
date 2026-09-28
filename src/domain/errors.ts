export type CommandErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'io'
  | 'database'
  | 'unsupported'

export type CommandError =
  | Readonly<{ code: 'validation'; message: string; diagnostic?: string }>
  | Readonly<{ code: 'not_found'; message: string; diagnostic?: string }>
  | Readonly<{ code: 'conflict'; message: string; diagnostic?: string }>
  | Readonly<{ code: 'io'; message: string; diagnostic?: string }>
  | Readonly<{ code: 'database'; message: string; diagnostic?: string }>
  | Readonly<{ code: 'unsupported'; message: string; diagnostic?: string }>

const safeMessages: Readonly<Record<CommandErrorCode, string>> = {
  validation: 'The request is invalid.',
  not_found: 'The requested item was not found.',
  conflict: 'The request conflicts with the current state.',
  io: 'The operation could not be completed on local storage.',
  database: 'The local note index is unavailable.',
  unsupported: 'This operation is not supported.',
}

export function commandError(code: CommandErrorCode, diagnostic?: string): CommandError {
  return diagnostic === undefined
    ? { code, message: safeMessages[code] }
    : { code, message: safeMessages[code], diagnostic }
}

export function normalizeCommandError(value: unknown): CommandError {
  const code = readCode(value)
  const diagnostic = readDiagnostic(value)
  if (isCommandErrorCode(code)) return commandError(code, diagnostic)
  return commandError('unsupported', diagnostic)
}

function readDiagnostic(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (value instanceof Error && value.message.trim().length > 0) return value.message
  if (typeof value !== 'object' || value === null || !('diagnostic' in value)) return undefined
  return typeof value.diagnostic === 'string' && value.diagnostic.trim().length > 0
    ? value.diagnostic
    : undefined
}

function readCode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  return value.code
}

function isCommandErrorCode(value: unknown): value is CommandErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(safeMessages, value)
}