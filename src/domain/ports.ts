import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from './model'

export type SearchQuery =
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'invalid'; reason: 'empty-tag' | 'control-character' | 'too-long' }

export interface NotePort {
  createNote(folderId: FolderId | null): Promise<NoteDocument>
  loadNote(id: NoteId): Promise<NoteDocument>
  saveNote(document: NoteDocument): Promise<NoteDocument>
  listNotes(folderId: FolderId | null): Promise<NoteSummary[]>
  moveNote(id: NoteId, folderId: FolderId | null): Promise<void>
}

export interface FolderPort {
  listFolders(): Promise<Folder[]>
  createFolder(input: { parentId: FolderId | null; name: string }): Promise<Folder>
  renameFolder(id: FolderId, name: string): Promise<Folder>
  moveFolder(id: FolderId, parentId: FolderId | null): Promise<Folder>
  deleteEmptyFolder(id: FolderId): Promise<void>
}

export interface AssetPort {
  saveImage(input: {
    noteId: NoteId
    mediaType: string
    bytes: Uint8Array
  }): Promise<{ relativePath: string; width: number; height: number }>
}

export interface SearchResult {
  noteId: NoteId
  title: string
  folderBreadcrumb: string[]
  tags: string[]
  excerpt: string
  score: number
}

export interface SearchPort {
  search(query: SearchQuery, limit?: number): Promise<SearchResult[]>
  updateTags(noteId: NoteId, tags: string[]): Promise<string[]>
}

export interface SystemPort {
  getWindowPreference<Key extends keyof WindowPreferenceMap>(
    key: Key,
  ): Promise<WindowPreferenceMap[Key] | undefined>
  setWindowPreference<Key extends keyof WindowPreferenceMap>(
    key: Key,
    value: WindowPreferenceMap[Key],
  ): Promise<void>
  hideTemporaryWindow(noteId: NoteId): Promise<void>
}

export interface LibraryColumnPreference {
  folder: number
  noteList: number
}

export interface WindowPreferenceMap {
  'library-columns': LibraryColumnPreference
}

export interface TemporaryPort {
  list(): Promise<NoteDocument[]>
  convert(input: { ids: NoteId[]; folderId: FolderId }): Promise<BatchConversionResult>
  trash(ids: NoteId[]): Promise<{ operationId: string }>
  undoTrash(operationId: string): Promise<void>
}

export interface BatchConversionResult {
  converted: Array<{ temporaryId: NoteId; noteId: NoteId }>
  failed: Array<{ temporaryId: NoteId; message: string }>
}
