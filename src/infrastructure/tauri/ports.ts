import { LazyStore } from '@tauri-apps/plugin-store'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import type { FolderPort, SystemPort, WindowPreferenceMap } from '../../domain/ports'
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

export function createTauriPorts(): {
  notes: LibraryNotePort
  folders: FolderPort
  system: SystemPort
} {
  const client = new TauriClient()
  return {
    notes: new TauriNotePort(client),
    folders: new TauriFolderPort(client),
    system: new TauriSystemPort(client),
  }
}
