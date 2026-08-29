import { LazyStore } from '@tauri-apps/plugin-store'
import { open } from '@tauri-apps/plugin-dialog'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { AppLifecyclePort, AppSettings, AssetPort, ExportDestinationPicker, ExportPort, ExportReport, FolderPort, ImageReadPort, LinkPort, RecoveryPort, SearchPort, SettingsPort, StartupRecoveryReport, StickySettings, StickySettingsPort, StorageInfo, SystemPort, TemporaryPort, TemporaryWindowPort, TemporaryWindowState, TrashEntry, TrashPort, UpdatePort, WindowChromePort, WindowPreferenceMap } from '../../domain/ports'
import type { LibraryNotePort } from '../../features/library/useLibrary'
import { TauriClient } from './client'

class TauriNotePort implements LibraryNotePort {
  constructor(private readonly client: TauriClient) {}

  createNote(input: Parameters<LibraryNotePort['createNote']>[0]) {
    return this.client.invoke<NoteDocument>('create_note', { input })
  }

  loadNote(noteId: NoteId) {
    return this.client.invoke<NoteDocument>('load_note', { noteId })
  }

  saveNote(document: NoteDocument) {
    return this.client.invoke<NoteDocument>('save_note', {
      input: { document, expectedRevision: document.revision },
    })
  }

  listNotes(folderId: FolderId | null) {
    return this.client.invoke<NoteSummary[]>('list_notes', { folderId })
  }

  renameNote(noteId: NoteId, title: string) {
    return this.client.invoke<Awaited<ReturnType<LibraryNotePort['renameNote']>>>('rename_note', {
      noteId,
      title,
    })
  }

  moveNote(noteId: NoteId, folderId: FolderId | null) {
    return this.client.invoke<NoteDocument>('move_note', { noteId, folderId })
  }

  reorderNotes(folderId: FolderId | null, orderedIds: NoteId[]) {
    return this.client.invoke<void>('reorder_notes', { folderId, orderedIds })
  }
}

class TauriRecoveryPort implements RecoveryPort {
  constructor(private readonly client: TauriClient) {}

  load() {
    return this.client.invoke<StartupRecoveryReport>('startup_recovery_report')
  }

  retry() {
    return this.client.invoke<StartupRecoveryReport>('retry_startup_recovery')
  }
}

class TauriUpdatePort implements UpdatePort {
  constructor(private readonly client: TauriClient) {}

  check() {
    return this.client.invoke<Awaited<ReturnType<UpdatePort['check']>>>('check_for_update')
  }

  async install() {
    await this.client.invoke<void>('install_pending_update')
  }

  async restart() {
    await this.client.invoke<void>('restart_after_update')
  }
}

class TauriAppLifecyclePort implements AppLifecyclePort {
  constructor(private readonly client: TauriClient) {}

  beginCloseListenerRegistration() {
    return this.client.invoke<number>('begin_main_window_close_listener_registration')
  }

  onCloseRequested(handler: (request: { generation: number }) => void) {
    return getCurrentWebviewWindow().listen<{ generation: number }>('main-window-close-requested', (event) => handler(event.payload))
  }

  async setListenerReady(ready: boolean, registrationToken: number) {
    await this.client.invoke<void>('set_main_window_close_listener_ready', { ready, registrationToken })
  }

  async completeClose(generation: number, saved: boolean) {
    await this.client.invoke<void>('complete_main_window_close', { generation, saved })
  }
}

class TauriWindowChromePort implements WindowChromePort {
  readonly platform = normalizeWindowPlatform(
    typeof navigator === 'undefined' ? '' : navigator.userAgent,
  )

  startDragging() {
    return getCurrentWebviewWindow().startDragging()
  }

  minimize() {
    return getCurrentWebviewWindow().minimize()
  }

  toggleMaximize() {
    return getCurrentWebviewWindow().toggleMaximize()
  }

  requestClose() {
    // A normal close request is intercepted by the existing safe-close protocol.
    return getCurrentWebviewWindow().close()
  }
}

function normalizeWindowPlatform(userAgent: string): WindowChromePort['platform'] {
  return /Macintosh|Mac OS X/u.test(userAgent) ? 'macos' : 'windows'
}

class TauriFolderPort implements FolderPort {
  constructor(private readonly client: TauriClient) {}

  listFolders() {
    return this.client.invoke<Folder[]>('list_folders')
  }

  createFolder(input: { parentId: FolderId | null; name: string }) {
    return this.client.invoke<Folder>('create_folder', { input })
  }

  renameFolder(folderId: FolderId, name: string) {
    return this.client.invoke<Folder>('rename_folder', { folderId, name })
  }

  moveFolder(folderId: FolderId, parentId: FolderId | null) {
    return this.client.invoke<Folder>('move_folder', { folderId, parentId })
  }

  reorderFolders(parentId: FolderId | null, orderedIds: FolderId[]) {
    return this.client.invoke<void>('reorder_folders', { parentId, orderedIds })
  }

  setFolderStarred(folderId: FolderId, starred: boolean) {
    return this.client.invoke<Folder>('set_folder_starred', { folderId, starred })
  }

  async deleteEmptyFolder(folderId: FolderId) {
    await this.client.invoke<void>('delete_empty_folder', { folderId })
  }

  async deleteFolder(folderId: FolderId) {
    await this.client.invoke<void>('delete_folder', { folderId })
  }
}

class TauriAssetPort implements AssetPort {
  constructor(private readonly client: TauriClient) {}

  saveImage(input: Parameters<AssetPort['saveImage']>[0]) {
    return this.client.invoke<Awaited<ReturnType<AssetPort['saveImage']>>>('save_image', {
      input: { ...input, bytes: Array.from(input.bytes) },
    })
  }

  async readImage(input: Parameters<ImageReadPort['readImage']>[0]) {
    const result = await this.client.invoke<{ mediaType: string; bytes: number[] }>('read_image_asset', { input })
    return { mediaType: result.mediaType, bytes: Uint8Array.from(result.bytes) }
  }
}

class TauriExportPort implements ExportPort {
  constructor(private readonly client: TauriClient) {}

  exportLibrary(destination: string) {
    return this.client.invoke<ExportReport>('export_library', { destination })
  }
}

class TauriExportDestinationPicker implements ExportDestinationPicker {
  async chooseExportDestination() {
    const selected = await open({ directory: true, multiple: false, title: 'Export complete library' })
    return typeof selected === 'string' ? selected : null
  }
}

class TauriSearchPort implements SearchPort {
  constructor(private readonly client: TauriClient) {}

  search(query: Parameters<SearchPort['search']>[0], limit = 50) {
    if (query.kind === 'invalid') return Promise.resolve([])
    return this.client.invoke<Awaited<ReturnType<SearchPort['search']>>>('search_notes', { query, limit })
  }

  async updateTags(noteId: NoteId, tags: string[]) {
    const document = await this.client.invoke<NoteDocument>('update_note_tags', { noteId, tags })
    return document.tags
  }
}

class TauriLinkPort implements LinkPort {
  constructor(private readonly client: TauriClient) {}

  listTargets() {
    return this.client.invoke<NoteSummary[]>('list_link_targets')
  }

  resolve(noteId: NoteId) {
    return this.client.invoke<NoteSummary | null>('resolve_link', { noteId })
  }

  backlinks(noteId: NoteId) {
    return this.client.invoke<NoteSummary[]>('backlinks', { noteId })
  }

  renameTargetLabels(noteId: NoteId, title: string) {
    return this.client.invoke<Awaited<ReturnType<LinkPort['renameTargetLabels']>>>(
      'rename_target_labels',
      { noteId, title },
    )
  }
}

class TauriSystemPort implements SystemPort {
  private readonly preferences = new LazyStore('settings.json', { autoSave: true })

  constructor(private readonly client: TauriClient) {}

  async getWindowPreference<Key extends keyof WindowPreferenceMap>(key: Key) {
    return this.preferences.get<WindowPreferenceMap[Key]>(key)
  }

  async setWindowPreference<Key extends keyof WindowPreferenceMap>(
    key: Key,
    value: WindowPreferenceMap[Key],
  ) {
    await this.preferences.set(key, value)
  }

  async hideTemporaryWindow(noteId: NoteId) {
    await this.client.invoke<void>('hide_temporary_window', { noteId })
  }

  async openExternal(url: string) {
    await this.client.invoke<void>('open_external_link', { url })
  }
}

class TauriTemporaryPort implements TemporaryPort {
  constructor(private readonly client: TauriClient) {}

  create() {
    return this.client.invoke<NoteDocument>('create_temporary')
  }

  load(noteId: NoteId) {
    return this.client.invoke<NoteDocument>('load_temporary', { noteId })
  }

  save(document: NoteDocument) {
    return this.client.invoke<NoteDocument>('save_temporary', {
      input: { document, expectedRevision: document.revision },
    })
  }

  list() {
    return this.client.invoke<NoteDocument[]>('list_temporary')
  }

  convert(input: Parameters<TemporaryPort['convert']>[0]) {
    return this.client.invoke<Awaited<ReturnType<TemporaryPort['convert']>>>('convert_temporary', { input })
  }

  delete(ids: NoteId[]) {
    return this.client.invoke<Awaited<ReturnType<TemporaryPort['delete']>>>('delete_temporary', { ids })
  }

  undoDelete(operationId: string) {
    return this.client.invoke<Awaited<ReturnType<TemporaryPort['undoDelete']>>>('undo_delete', { operationId })
  }
}

class TauriTemporaryWindowPort implements TemporaryWindowPort {
  constructor(private readonly client: TauriClient) {}

  show(noteId: NoteId) {
    return this.client.invoke<TemporaryWindowState>('show_temporary_window', { noteId })
  }

  hide(noteId: NoteId) {
    return this.client.invoke<void>('hide_temporary_window', { noteId })
  }

  setAlwaysOnTop(noteId: NoteId, alwaysOnTop: boolean) {
    return this.client.invoke<TemporaryWindowState>('set_temporary_always_on_top', {
      noteId,
      alwaysOnTop,
    })
  }

  startDragging() {
    return getCurrentWebviewWindow().startDragging()
  }

  onCloseRequested(handler: (noteId: unknown) => void) {
    return listen<unknown>('temporary-close-requested', (event) => {
      handler(event.payload)
    })
  }

  onShown(handler: (noteId: unknown) => void) {
    return listen<unknown>('temporary-window-shown', (event) => {
      handler(event.payload)
    })
  }
}

class TauriTrashPort implements TrashPort {
  constructor(private readonly client: TauriClient) {}

  trash(noteIds: NoteId[]) {
    return this.client.invoke<Awaited<ReturnType<TrashPort['trash']>>>('trash_notes', { noteIds })
  }

  list() {
    return this.client.invoke<TrashEntry[]>('list_trash')
  }

  restore(noteIds: NoteId[]) {
    return this.client.invoke<Awaited<ReturnType<TrashPort['restore']>>>('restore_trash', { noteIds })
  }

  undo(operationId: string) {
    return this.client.invoke<Awaited<ReturnType<TrashPort['undo']>>>('undo_trash', { operationId })
  }

  purge(noteIds: NoteId[]) {
    return this.client.invoke<Awaited<ReturnType<NonNullable<TrashPort['purge']>>>>('purge_trash', { noteIds })
  }

  purgeExpired() {
    return this.client.invoke<Awaited<ReturnType<TrashPort['purgeExpired']>>>('purge_expired_trash')
  }
}

class TauriSettingsPort implements SettingsPort {
  constructor(private readonly client: TauriClient) {}

  load() {
    return this.client.invoke<AppSettings>('load_settings')
  }

  update(patch: Partial<AppSettings>) {
    return this.client.invoke<AppSettings>('update_settings', { patch })
  }

  reset() {
    return this.client.invoke<AppSettings>('reset_settings')
  }

  getStorageInfo() {
    return this.client.invoke<StorageInfo>('get_storage_info')
  }

  moveStorageRoot(destination: string) {
    return this.client.invoke<void>('move_storage_root', { destination })
  }

  restartApplication() {
    return this.client.invoke<void>('restart_application')
  }

  onChanged(handler: (settings: AppSettings) => void) {
    return getCurrentWebviewWindow().listen<AppSettings>('settings-updated', (event) => handler(event.payload))
  }

  getShortcutStatus() {
    return this.client.invoke<Awaited<ReturnType<SettingsPort['getShortcutStatus']>>>('get_capture_shortcut')
  }
}

class TauriStickySettingsPort implements StickySettingsPort {
  constructor(private readonly client: TauriClient) {}

  load() {
    return this.client.invoke<StickySettings>('load_sticky_settings')
  }

  onChanged(handler: (settings: StickySettings) => void) {
    return listen<StickySettings>('sticky-settings-updated', (event) => handler(event.payload))
  }
}

export function createTauriPorts(): {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets: AssetPort & ImageReadPort
  search: SearchPort
  links: LinkPort
  temporary: TemporaryPort
  temporaryWindows: TemporaryWindowPort
  trash: TrashPort
  settings: SettingsPort
  stickySettings: StickySettingsPort
  exporter: ExportPort
  exportDestinationPicker: ExportDestinationPicker
  recovery: RecoveryPort
  updater: UpdatePort
  lifecycle: AppLifecyclePort
  windowChrome: WindowChromePort
} {
  const client = new TauriClient()
  return {
    notes: new TauriNotePort(client),
    folders: new TauriFolderPort(client),
    system: new TauriSystemPort(client),
    assets: new TauriAssetPort(client),
    search: new TauriSearchPort(client),
    links: new TauriLinkPort(client),
    temporary: new TauriTemporaryPort(client),
    temporaryWindows: new TauriTemporaryWindowPort(client),
    trash: new TauriTrashPort(client),
    settings: new TauriSettingsPort(client),
    stickySettings: new TauriStickySettingsPort(client),
    exporter: new TauriExportPort(client),
    exportDestinationPicker: new TauriExportDestinationPicker(),
    recovery: new TauriRecoveryPort(client),
    updater: new TauriUpdatePort(client),
    lifecycle: new TauriAppLifecyclePort(client),
    windowChrome: new TauriWindowChromePort(),
  }
}
