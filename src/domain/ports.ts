import type { EditorMode, Folder, FolderId, NoteDocument, NoteId, NoteSummary } from './model'
import type { CommandErrorCode } from './errors'

export type SearchQuery =
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'invalid'; reason: 'empty-tag' | 'control-character' | 'too-long' }

export interface NotePort {
  createNote(input: { folderId: FolderId | null; title: string }): Promise<NoteDocument>
  loadNote(id: NoteId): Promise<NoteDocument>
  saveNote(document: NoteDocument): Promise<NoteDocument>
  listNotes(folderId: FolderId | null): Promise<NoteSummary[]>
  renameNote(id: NoteId, title: string): Promise<RenameNoteResult>
  moveNote(id: NoteId, folderId: FolderId | null): Promise<NoteDocument>
}

export interface RenameNoteResult {
  document: NoteDocument
  linkRepair: LinkRepairReport
}

export interface LinkRepairReport {
  updated: number
  failedSourceIds: NoteId[]
  failure: { code: CommandErrorCode; message: string } | null
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

export interface ImageReadPort {
  readImage(input: {
    noteId: NoteId
    relativePath: string
  }): Promise<{ mediaType: string; bytes: Uint8Array }>
}

export interface ExportReport {
  completed: boolean
  outputRoot: string | null
  incompleteRoot: string | null
  globalFailure: string | null
  notesExported: number
  assetsExported: number
  renamedPaths: Array<{ source: string; destination: string }>
  failed: Array<{ noteId: NoteId; message: string }>
}

export interface ExportPort {
  exportLibrary(destination: string): Promise<ExportReport>
}

export interface ExportDestinationPicker {
  chooseExportDestination(): Promise<string | null>
}

export interface StartupRecoveryReport {
  recovered: Array<{ noteId: NoteId; revision: number }>
  quarantined: Array<{ noteId: NoteId; candidate: string; reason: string }>
  ambiguous: string[]
  indexRebuilt: boolean
  indexQuarantine: { database: string | null; sidecars: string[] } | null
  failure?: { code: string; message: string } | null
}

export interface RecoveryPort {
  load(): Promise<StartupRecoveryReport>
  retry(): Promise<StartupRecoveryReport>
}

export interface AvailableUpdate {
  version: string
  notes: string | null
}

/** Main-window-only update boundary. Checks and installs are never automatic. */
export interface UpdatePort {
  check(): Promise<AvailableUpdate | null>
  install(): Promise<void>
  restart(): Promise<void>
}

/** Native main-window close requests stay prevented until the renderer acknowledges a flush. */
export interface AppLifecyclePort {
  onCloseRequested(handler: (request: { generation: number }) => void): Promise<() => void>
  setListenerReady(ready: boolean, listenerId: string): Promise<void>
  completeClose(generation: number, saved: boolean): Promise<void>
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
  listTargets(): Promise<NoteSummary[]>
  resolve(noteId: NoteId): Promise<NoteSummary | null>
  backlinks(noteId: NoteId): Promise<NoteSummary[]>
  renameTargetLabels(
    noteId: NoteId,
    title: string,
  ): Promise<LinkRepairReport>
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
  openExternal(url: string): Promise<void>
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

export interface LibraryCollapsedPreference {
  folder: boolean
  noteList: boolean
}

export interface WindowPreferenceMap {
  'library-columns': LibraryColumnPreference
  'library-collapsed': LibraryCollapsedPreference
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

export interface AppSettings {
  theme: 'forest' | 'sand' | 'system'
  stickyColorMode: 'follow-theme'
  bodyFont: string
  codeFont: string
  fontSize: number
  lineHeight: number
  shortcut: string
  launchAtStartup: boolean
  defaultEditorMode: EditorMode
  autosaveDelayMs: number
  dataRoot: { mode: 'default' } | { mode: 'custom'; path: string }
}

export interface StickySettings {
  theme: AppSettings['theme']
  stickyColorMode: AppSettings['stickyColorMode']
  bodyFont: string
  codeFont: string
  fontSize: number
  lineHeight: number
  autosaveDelayMs: number
}

export interface StickySettingsPort {
  load(): Promise<StickySettings>
  onChanged(handler: (settings: StickySettings) => void): Promise<() => void>
}

export interface StorageInfo {
  root: string
  noteBytes: number
  assetBytes: number
  trashBytes: number
  previousStorageCleanup?: {
    root: string
    candidates: Array<{
      relativePath: string
      kind: 'notes' | 'temporary' | 'trash' | 'folder-manifest' | 'index-database' | 'index-sidecar' | 'recovery-marker'
    }>
  }
}

export interface SettingsPort {
  load(): Promise<AppSettings>
  update(patch: Partial<AppSettings>): Promise<AppSettings>
  reset(): Promise<AppSettings>
  getStorageInfo(): Promise<StorageInfo>
  moveStorageRoot(destination: string): Promise<void>
  restartApplication(): Promise<void>
  onChanged(handler: (settings: AppSettings) => void): Promise<() => void>
  getShortcutStatus(): Promise<{
    current: string | null
    registration: { state: string }
    acceptingTriggers: boolean
    startupError: { kind: string; reason: string; accelerator?: string } | null
  }>
}
