import type { AppNavigationPort, AssetPort, ExportDestinationPicker, ExportPort, FolderPort, ImageReadPort, LifecycleParticipantPort, LinkPort, RecoveryPort, SearchPort, SettingsPort, StartupGuidePort, StickySettingsPort, SystemPort, TemporaryPort, TemporaryWindowPort, TrashPort, UpdatePort, WindowChromePort } from '../domain/ports'
import type { LibraryNotePort } from '../features/library/useLibrary'
import { createTauriPorts } from '../infrastructure/tauri/ports'
import { createE2EAppServices } from './e2eServices'

export interface AppServices {
  files?: import('../domain/ports').FilePort
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
  startupGuide?: StartupGuidePort
  updater?: UpdatePort
  lifecycle?: LifecycleParticipantPort
  navigation?: AppNavigationPort
  windowChrome: WindowChromePort
}

export function createAppServices(): AppServices {
  return import.meta.env.MODE === 'e2e' ? createE2EAppServices() : createTauriPorts()
}
