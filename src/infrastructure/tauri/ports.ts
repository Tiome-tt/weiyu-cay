import { LazyStore } from '@tauri-apps/plugin-store'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { AssetPort, FolderPort, LinkPort, SearchPort, SystemPort, TemporaryPort, TemporaryWindowPort, TemporaryWindowState, TrashEntry, TrashPort, WindowPreferenceMap } from '../../domain/ports'
import type { LibraryNotePort } from '../../features/library/useLibrary'
import { TauriClient } from './client'

class TauriNotePort implements LibraryNotePort {
  constructor(private readonly client: TauriClient) {}

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

  async deleteEmptyFolder(folderId: FolderId) {
    await this.client.invoke<void>('delete_empty_folder', { folderId })
  }
}

class TauriAssetPort implements AssetPort {
  constructor(private readonly client: TauriClient) {}

  saveImage(input: Parameters<AssetPort['saveImage']>[0]) {
    return this.client.invoke<Awaited<ReturnType<AssetPort['saveImage']>>>('save_image', {
      input: { ...input, bytes: Array.from(input.bytes) },
    })
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
    return this.client.invoke<Awaited<ReturnType<TemporaryPort['convert']>>>('convert_temporary', input)
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
    return getCurrentWebviewWindow().listen<unknown>('temporary-close-requested', (event) => {
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

  purgeExpired() {
    return this.client.invoke<Awaited<ReturnType<TrashPort['purgeExpired']>>>('purge_expired_trash')
  }
}

export function createTauriPorts(): {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
  assets: AssetPort
  search: SearchPort
  links: LinkPort
  temporary: TemporaryPort
  temporaryWindows: TemporaryWindowPort
  trash: TrashPort
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
  }
}
