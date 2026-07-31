export type CommandErrorCode =
  | 'validation'
  | 'not_found'
  | 'conflict'
  | 'io'
  | 'database'
  | 'unsupported'

export type CommandError =
  | Readonly<{ code: 'validation'; message: string }>
  | Readonly<{ code: 'not_found'; message: string }>
  | Readonly<{ code: 'conflict'; message: string }>
  | Readonly<{ code: 'io'; message: string }>
  | Readonly<{ code: 'database'; message: string }>
  | Readonly<{ code: 'unsupported'; message: string }>

const safeMessages: Readonly<Record<CommandErrorCode, string>> = {
  validation: 'The request is invalid.',
  not_found: 'The requested item was not found.',
  conflict: 'The request conflicts with the current state.',
  io: 'The operation could not be completed on local storage.',
  database: 'The local note index is unavailable.',
  unsupported: 'This operation is not supported.',
}

export function commandError(code: CommandErrorCode): CommandError {
  return { code, message: safeMessages[code] }
}

export function normalizeCommandError(value: unknown): CommandError {
  const code = readCode(value)
  if (isCommandErrorCode(code)) return commandError(code)
  return commandError('unsupported')
}

function readCode(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
  return value.code
}

function isCommandErrorCode(value: unknown): value is CommandErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(safeMessages, value)
}
