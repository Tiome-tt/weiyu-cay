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

export interface LinkPort {
  resolve(noteId: NoteId): Promise<NoteSummary | null>
  backlinks(noteId: NoteId): Promise<NoteSummary[]>
  renameTargetLabels(
    noteId: NoteId,
    title: string,
  ): Promise<{ updated: number; failedSourceIds: NoteId[] }>
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

export interface TemporaryWindowState {
  noteId: NoteId
  visible: boolean
  x: number
  y: number
  width: number
  height: number
  alwaysOnTop: boolean
}

export interface TemporaryWindowPort {
  show(noteId: NoteId): Promise<TemporaryWindowState>
  hide(noteId: NoteId): Promise<void>
  setAlwaysOnTop(noteId: NoteId, alwaysOnTop: boolean): Promise<TemporaryWindowState>
  startDragging(): Promise<void>
  onCloseRequested?(handler: (noteId: unknown) => void): Promise<() => void>
}

export interface LibraryColumnPreference {
  folder: number
  noteList: number
}

export interface WindowPreferenceMap {
  'library-columns': LibraryColumnPreference
}

export interface TemporaryPort {
  create(): Promise<NoteDocument>
  load(noteId: NoteId): Promise<NoteDocument>
  save(document: NoteDocument): Promise<NoteDocument>
  list(): Promise<NoteDocument[]>
  convert(input: { ids: NoteId[]; folderId: FolderId }): Promise<BatchConversionResult>
  delete(ids: NoteId[]): Promise<TemporaryDeleteResult>
  undoDelete(operationId: string): Promise<TemporaryUndoDeleteResult>
}

export interface BatchConversionResult {
  converted: Array<{ temporaryId: NoteId; noteId: NoteId }>
  failed: Array<{ temporaryId: NoteId; message: string }>
}

export interface TemporaryDeleteResult {
  operationId: string
  deleted: NoteId[]
  failed: Array<{ temporaryId: NoteId; message: string }>
}

export interface TemporaryUndoDeleteResult {
  operationId: string
  restored: NoteId[]
  failed: Array<{ temporaryId: NoteId; message: string }>
}

export interface TrashEntry {
  noteId: NoteId
  kind: NoteDocument['kind']
  title: string
  previousFolderId: FolderId | null
  previousRelativePath: string
  deletedAt: string
  assets: string[]
  operationId: string
}

export interface TrashFailure {
  noteId: NoteId
  message: string
}

export interface TrashBatchResult {
  operationId: string
  trashed: NoteId[]
  failed: TrashFailure[]
}

export interface RestoreTrashResult {
  restored: NoteDocument[]
  failed: TrashFailure[]
}

export interface PurgeTrashResult {
  purged: NoteId[]
  failed: TrashFailure[]
}

export interface TrashPort {
  trash(ids: NoteId[]): Promise<TrashBatchResult>
  list(): Promise<TrashEntry[]>
  restore(ids: NoteId[]): Promise<RestoreTrashResult>
  undo(operationId: string): Promise<RestoreTrashResult>
  purgeExpired(): Promise<PurgeTrashResult>
}
