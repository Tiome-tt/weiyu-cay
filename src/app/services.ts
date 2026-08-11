import type { AppLifecyclePort, AssetPort, ExportDestinationPicker, ExportPort, FolderPort, ImageReadPort, LinkPort, RecoveryPort, SearchPort, SettingsPort, StickySettingsPort, SystemPort, TemporaryPort, TemporaryWindowPort, TrashPort, UpdatePort } from '../domain/ports'
import type { LibraryNotePort } from '../features/library/useLibrary'
import { createTauriPorts } from '../infrastructure/tauri/ports'
import { createE2EAppServices } from './e2eServices'

export interface AppServices {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets: AssetPort & ImageReadPort
  search: SearchPort
  links: LinkPort
  temporary?: TemporaryPort
  temporaryWindows?: TemporaryWindowPort
  trash?: TrashPort
  settings?: SettingsPort
  stickySettings?: StickySettingsPort
  exporter?: ExportPort
  exportDestinationPicker?: ExportDestinationPicker
  recovery?: RecoveryPort
  updater?: UpdatePort
  lifecycle?: AppLifecyclePort
}

export function createAppServices(): AppServices {
  return import.meta.env.MODE === 'e2e' ? createE2EAppServices() : createTauriPorts()
}
