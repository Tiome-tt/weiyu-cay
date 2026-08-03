import { vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId } from '../domain/model'
import type { AssetPort, FolderPort, LinkPort, NotePort, SearchPort, SettingsPort, SystemPort, TemporaryPort } from '../domain/ports'
import { DEFAULT_APP_SETTINGS } from '../features/settings/theme'

export const noteId = '019c0000-0000-7000-8000-000000000002' as NoteId
export const projectB = '019c0000-0000-7000-8000-000000000001' as FolderId

export const note = (markdown = ''): NoteDocument => ({
  id: noteId,
  kind: 'formal',
  title: '登录流程',
  folderId: projectB,
  tags: [],
  markdown,
  revision: 1,
  createdAt: '2026-07-30T15:30:00+08:00',
  updatedAt: '2026-07-30T15:30:00+08:00',
})

export const folders = (): Folder[] => [
  { id: projectB, parentId: null, name: '项目 B', sortOrder: 0 },
]

export const fakeNotePort = (overrides: Partial<NotePort> = {}): NotePort => ({
  createNote: vi.fn().mockResolvedValue(note()),
  loadNote: vi.fn().mockResolvedValue(note()),
  saveNote: vi.fn().mockResolvedValue(note()),
  listNotes: vi.fn().mockResolvedValue([]),
  moveNote: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

export const fakeFolderPort = (overrides: Partial<FolderPort> = {}): FolderPort => ({
  listFolders: vi.fn().mockResolvedValue(folders()),
  createFolder: vi.fn().mockResolvedValue(folders()[0]),
  renameFolder: vi.fn().mockResolvedValue(folders()[0]),
  moveFolder: vi.fn().mockResolvedValue(folders()[0]),
  deleteEmptyFolder: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

export const fakeAssetPort = (
  saved: Awaited<ReturnType<AssetPort['saveImage']>>,
): AssetPort => ({ saveImage: vi.fn().mockResolvedValue(saved) })

export const fakeSystemPort = (overrides: Partial<SystemPort> = {}): SystemPort => ({
  getWindowPreference: vi.fn().mockResolvedValue(undefined),
  setWindowPreference: vi.fn().mockResolvedValue(undefined),
  hideTemporaryWindow: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

export const fakeSettingsPort = (overrides: Partial<SettingsPort> = {}): SettingsPort => ({
  load: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
  update: vi.fn().mockImplementation(async (patch) => ({ ...DEFAULT_APP_SETTINGS, ...patch })),
  reset: vi.fn().mockResolvedValue(DEFAULT_APP_SETTINGS),
  getStorageInfo: vi.fn().mockResolvedValue({ root: 'Application data', noteBytes: 0, assetBytes: 0, trashBytes: 0 }),
  moveStorageRoot: vi.fn().mockResolvedValue(undefined),
  ...overrides,
})

export const fakeSearchPort = (overrides: Partial<SearchPort> = {}): SearchPort => ({
  search: vi.fn().mockResolvedValue([]),
  updateTags: vi.fn().mockResolvedValue([]),
  ...overrides,
})

export const fakeLinkPort = (overrides: Partial<LinkPort> = {}): LinkPort => ({
  resolve: vi.fn().mockResolvedValue(null),
  backlinks: vi.fn().mockResolvedValue([]),
  renameTargetLabels: vi.fn().mockResolvedValue({ updated: 0, failedSourceIds: [] }),
  ...overrides,
})

export const fakeTemporaryPort = (items: NoteDocument[]): TemporaryPort => ({
  create: vi.fn().mockResolvedValue(items[0]),
  load: vi.fn().mockImplementation(async (noteId: NoteId) => {
    const item = items.find((candidate) => candidate.id === noteId)
    if (item === undefined) throw new Error('temporary capture not found')
    return item
  }),
  save: vi.fn().mockImplementation(async (document: NoteDocument) => document),
  list: vi.fn().mockResolvedValue(items),
  convert: vi.fn().mockResolvedValue({ converted: [], failed: [] }),
  delete: vi.fn().mockResolvedValue({ operationId: 'temporary-delete', deleted: [], failed: [] }),
  undoDelete: vi.fn().mockResolvedValue({ operationId: 'temporary-delete', restored: [], failed: [] }),
})

export const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
export const pasteEvent = (bytes: Uint8Array) => ({ bytes, mediaType: 'image/png' })
export const twoCaptures = () => [
  {
    ...note('发布前检查'),
    id: '019c0000-0000-7000-8000-000000000010' as NoteId,
    kind: 'temporary' as const,
  },
  {
    ...note('接口异常处理'),
    id: '019c0000-0000-7000-8000-000000000011' as NoteId,
    kind: 'temporary' as const,
  },
]
