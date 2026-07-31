import { invoke } from '@tauri-apps/api/core'
import { normalizeCommandError } from '../../domain/errors'

export type TauriCommandArguments = Readonly<Record<string, unknown>>

export class TauriClient {
  async invoke<Result>(command: string, args?: TauriCommandArguments): Promise<Result> {
    try {
      return await invoke<Result>(command, args)
    } catch (error: unknown) {
      throw normalizeCommandError(error)
    }
  }
}
