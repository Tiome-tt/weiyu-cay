import type { AssetPort, FolderPort, LinkPort, SearchPort, SystemPort, TemporaryPort, TemporaryWindowPort } from '../domain/ports'
import type { LibraryNotePort } from '../features/library/useLibrary'
import { createTauriPorts } from '../infrastructure/tauri/ports'

export interface AppServices {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets: AssetPort
  search: SearchPort
  links: LinkPort
  temporary?: TemporaryPort
  temporaryWindows?: TemporaryWindowPort
}

export function createAppServices(): AppServices {
  return createTauriPorts()
}
