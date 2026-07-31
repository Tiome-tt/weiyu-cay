import type { FolderPort, SystemPort } from '../domain/ports'
import type { LibraryNotePort } from '../features/library/useLibrary'
import { createTauriPorts } from '../infrastructure/tauri/ports'

export interface AppServices {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
}

export function createAppServices(): AppServices {
  return createTauriPorts()
}
