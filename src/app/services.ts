import type { AssetPort, FolderPort, LinkPort, SearchPort, SettingsPort, StickySettingsPort, SystemPort, TemporaryPort, TemporaryWindowPort, TrashPort } from '../domain/ports'
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
  trash?: TrashPort
  settings?: SettingsPort
  stickySettings?: StickySettingsPort
}

export function createAppServices(): AppServices {
  return createTauriPorts()
}
