import type { AppServices } from './services'
import type { Folder, FolderId, NoteDocument, NoteId, NoteSummary } from '../domain/model'
import type { AppSettings, StartupRecoveryReport, TrashEntry, WindowPreferenceMap } from '../domain/ports'
import { DEFAULT_APP_SETTINGS, DEFAULT_STICKY_SETTINGS } from '../features/settings/theme'
import { parseInternalLinks } from '../features/editor/internalLinks'
import { formatStoredLink } from '../domain/noteFormat'

const STATE_KEY = 'simple-notes-e2e-state-v1'
const CANDIDATE_KEY = 'simple-notes-e2e-interrupted-save'
const folderId = '019c0000-0000-7000-8000-000000000701' as FolderId
const authenticationId = '019c0000-0000-7000-8000-000000000702' as NoteId

interface E2EState {
  notes: NoteDocument[]
  temporary: NoteDocument[]
  deletedTemporary: NoteDocument[]
  trashed: NoteDocument[]
  sequence: number
}

function initialState(): E2EState {
  return {
    notes: [document(authenticationId, 'formal', '用户认证', '# 用户认证\n\n身份验证入口。', folderId)],
    temporary: [
      document('019c0000-0000-7000-8000-000000000703' as NoteId, 'temporary', 'Temporary capture', '发布前检查', null),
      document('019c0000-0000-7000-8000-000000000704' as NoteId, 'temporary', 'Temporary capture', '接口异常处理', null),
    ],
    deletedTemporary: [],
    trashed: [],
    sequence: 710,
  }
}

function document(id: NoteId, kind: NoteDocument['kind'], title: string, markdown: string, owner: FolderId | null): NoteDocument {
  return {
    id,
    kind,
    title,
    folderId: owner,
    tags: [],
    markdown,
    revision: 0,
    createdAt: '2026-07-30T00:00:00Z',
    updatedAt: '2026-07-30T00:00:00Z',
  }
}

function loadState(): E2EState {
  const stored = localStorage.getItem(STATE_KEY)
  if (stored === null) {
    const state = initialState()
    saveState(state)
    return state
  }
  return JSON.parse(stored) as E2EState
}

function saveState(state: E2EState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state))
}

function temporaryTitleFrom(markdown: string) {
  const first = markdown.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '未命名笔记'
  return first.replace(/^#{1,6}\s+/u, '').slice(0, 80) || '未命名笔记'
}

function summary(note: NoteDocument): NoteSummary {
  return { ...note, excerpt: note.markdown.slice(0, 96) }
}

export function createE2EAppServices(): AppServices {
  const state = loadState()
  let recoveryReport: StartupRecoveryReport = {
    recovered: [], quarantined: [], ambiguous: [], indexRebuilt: false, indexQuarantine: null,
  }
  const interrupted = localStorage.getItem(CANDIDATE_KEY)
  if (interrupted !== null) {
    const candidate = JSON.parse(interrupted) as NoteDocument
    const index = state.notes.findIndex((note) => note.id === candidate.id)
    if (index >= 0 && candidate.revision > state.notes[index].revision) {
      state.notes[index] = candidate
      saveState(state)
      recoveryReport = {
        recovered: [{ noteId: candidate.id, revision: candidate.revision }],
        quarantined: [], ambiguous: [], indexRebuilt: true, indexQuarantine: null,
      }
    }
    localStorage.removeItem(CANDIDATE_KEY)
  }

  const folders: Folder[] = [{ id: folderId, parentId: null, name: '项目', sortOrder: 0 }]
  const preferences = new Map<keyof WindowPreferenceMap, WindowPreferenceMap[keyof WindowPreferenceMap]>()
  const notes = {
    async createNote(input: { folderId: FolderId | null; title: string }) {
      const id = `019c0000-0000-7000-8000-${String(state.sequence++).padStart(12, '0')}` as NoteId
      const created = document(id, 'formal', input.title.trim(), '', input.folderId)
      state.notes.push(created)
      saveState(state)
      return created
    },
    async loadNote(id: NoteId) {
      const found = state.notes.find((note) => note.id === id)
      if (found === undefined) throw new Error('note not found')
      return structuredClone(found)
    },
    async saveNote(input: NoteDocument) {
      const index = state.notes.findIndex((note) => note.id === input.id)
      if (index < 0) throw new Error('note not found')
      const saved = { ...input, revision: state.notes[index].revision + 1, updatedAt: new Date().toISOString() }
      state.notes[index] = saved
      saveState(state)
      return structuredClone(saved)
    },
    async listNotes(owner: FolderId | null) {
      return state.notes.filter((note) => note.folderId === owner).map(summary)
    },
    async renameNote(id: NoteId, title: string) {
      const index = state.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new Error('note not found')
      const renamed = {
        ...state.notes[index],
        title: title.trim(),
        revision: state.notes[index].revision + 1,
        updatedAt: new Date().toISOString(),
      }
      state.notes[index] = renamed
      let updated = 0
      for (let sourceIndex = 0; sourceIndex < state.notes.length; sourceIndex += 1) {
        const source = state.notes[sourceIndex]
        const matching = parseInternalLinks(source.markdown).filter((link) => link.targetId === id && link.label !== renamed.title)
        if (matching.length === 0) continue
        let markdown = source.markdown
        for (const link of matching.reverse()) {
          markdown = `${markdown.slice(0, link.from)}${formatStoredLink(renamed.title, id)}${markdown.slice(link.to)}`
        }
        state.notes[sourceIndex] = { ...source, markdown, revision: source.revision + 1, updatedAt: new Date().toISOString() }
        updated += 1
      }
      saveState(state)
      const authoritative = state.notes.find((note) => note.id === id)
      if (authoritative === undefined) throw new Error('renamed note disappeared')
      return { document: structuredClone(authoritative), linkRepair: { updated, failedSourceIds: [], failure: null } }
    },
    async moveNote(id: NoteId, owner: FolderId | null) {
      const index = state.notes.findIndex((note) => note.id === id)
      if (index < 0) throw new Error('note not found')
      const moved = { ...state.notes[index], folderId: owner, revision: state.notes[index].revision + 1, updatedAt: new Date().toISOString() }
      state.notes[index] = moved
      saveState(state)
      return structuredClone(moved)
    },
  }

  return {
    notes,
    folders: {
      async listFolders() { return folders },
      async createFolder() { return folders[0] },
      async renameFolder() { return folders[0] },
      async moveFolder() { return folders[0] },
      async deleteEmptyFolder() { return },
    },
    system: {
      async getWindowPreference(key) { return preferences.get(key) as never },
      async setWindowPreference(key, value) { preferences.set(key, value) },
      async hideTemporaryWindow() { return },
      async openExternal() { return },
    },
    assets: {
      async saveImage() { return { relativePath: 'assets/e2e.png', width: 1, height: 1 } },
      async readImage() { return { mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) } },
    },
    search: {
      async search(query) {
        if (query.kind === 'invalid') return []
        const needle = query.value.toLocaleLowerCase()
        return state.notes
          .filter((note) => query.kind === 'tag'
            ? note.tags.some((tag) => tag.toLocaleLowerCase().includes(needle))
            : `${note.title}\n${note.markdown}`.toLocaleLowerCase().includes(needle))
          .map((note) => ({ noteId: note.id, title: note.title, folderBreadcrumb: ['项目'], tags: note.tags, excerpt: note.markdown, score: 1 }))
      },
      async updateTags(id, tags) {
        const note = state.notes.find((item) => item.id === id)
        if (note === undefined) throw new Error('note not found')
        note.tags = tags
        saveState(state)
        return tags
      },
    },
    links: {
      async listTargets() { return state.notes.filter((note) => note.kind === 'formal').map(summary) },
      async resolve(id) { return state.notes.find((note) => note.id === id) ? summary(state.notes.find((note) => note.id === id)!) : null },
      async backlinks() { return [] },
      async renameTargetLabels() { return { updated: 0, failedSourceIds: [], failure: null } },
    },
    temporary: {
      async create() { throw new Error('not needed in main-window E2E') },
      async load(id) {
        const found = state.temporary.find((note) => note.id === id)
        if (found === undefined) throw new Error('temporary not found')
        return structuredClone(found)
      },
      async save(input) {
        const index = state.temporary.findIndex((note) => note.id === input.id)
        if (index < 0) throw new Error('temporary not found')
        const saved = { ...input, revision: state.temporary[index].revision + 1 }
        state.temporary[index] = saved
        saveState(state)
        return saved
      },
      async list() { return structuredClone(state.temporary) },
      async convert(input) {
        const converted: Array<{ temporaryId: NoteId; noteId: NoteId }> = []
        for (const id of input.ids) {
          const index = state.temporary.findIndex((note) => note.id === id)
          if (index < 0) continue
          const [capture] = state.temporary.splice(index, 1)
          state.notes.push({ ...capture, kind: 'formal', folderId: input.folderId, title: temporaryTitleFrom(capture.markdown) })
          converted.push({ temporaryId: id, noteId: id })
        }
        saveState(state)
        return { converted, failed: [] }
      },
      async delete(ids) {
        const deleted = state.temporary.filter((note) => ids.includes(note.id))
        state.deletedTemporary = deleted
        state.temporary = state.temporary.filter((note) => !ids.includes(note.id))
        saveState(state)
        return { operationId: 'e2e-delete', deleted: deleted.map((note) => note.id), failed: [] }
      },
      async undoDelete() {
        const restored = state.deletedTemporary.map((note) => note.id)
        state.temporary.push(...state.deletedTemporary)
        state.deletedTemporary = []
        saveState(state)
        return { operationId: 'e2e-delete', restored, failed: [] }
      },
    },
    temporaryWindows: {
      async show(id) { return { noteId: id, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop: true } },
      async hide() { return },
      async setAlwaysOnTop(id, alwaysOnTop) { return { noteId: id, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop } },
      async startDragging() { return },
    },
    trash: {
      async trash(ids) {
        const trashed = state.notes.filter((note) => ids.includes(note.id))
        state.trashed.push(...trashed)
        state.notes = state.notes.filter((note) => !ids.includes(note.id))
        saveState(state)
        return { operationId: 'e2e-trash', trashed: trashed.map((note) => note.id), failed: [] }
      },
      async list(): Promise<TrashEntry[]> {
        return state.trashed.map((note) => ({
          noteId: note.id, kind: note.kind, title: note.title, previousFolderId: note.folderId,
          previousRelativePath: `notes/${note.id}`, deletedAt: '2026-07-30T00:00:00Z', assets: [], operationId: 'e2e-trash',
        }))
      },
      async restore(ids) {
        const restored = state.trashed.filter((note) => ids.includes(note.id))
        state.notes.push(...restored)
        state.trashed = state.trashed.filter((note) => !ids.includes(note.id))
        saveState(state)
        return { restored, failed: [] }
      },
      async undo() { return { restored: [], failed: [] } },
      async purgeExpired() { return { purged: [], failed: [] } },
    },
    settings: settingsPort(),
    stickySettings: { async load() { return DEFAULT_STICKY_SETTINGS }, async onChanged() { return () => undefined } },
    exporter: {
      async exportLibrary() {
        return { completed: true, outputRoot: 'E2E Export/微屿导出', incompleteRoot: null, globalFailure: null, notesExported: state.notes.length, assetsExported: 0, renamedPaths: [], failed: [] }
      },
    },
    exportDestinationPicker: { async chooseExportDestination() { return 'E2E Export' } },
    recovery: { async load() { return recoveryReport }, async retry() { return recoveryReport } },
    windowChrome: {
      platform: 'windows',
      async startDragging() { return },
      async minimize() { return },
      async toggleMaximize() { return },
      async requestClose() { return },
    },
    // E2E keeps updater behavior local and deterministic; production invokes the main-only Rust commands.
    updater: {
      async check() { return { version: '0.1.1', notes: 'E2E updater fixture' } },
      async install() { return },
      async restart() { return },
    },
  }
}

function settingsPort() {
  let settings: AppSettings = { ...DEFAULT_APP_SETTINGS, autosaveDelayMs: 50 }
  return {
    async load() { return settings },
    async update(patch: Partial<AppSettings>) { settings = { ...settings, ...patch }; return settings },
    async reset() { settings = DEFAULT_APP_SETTINGS; return settings },
    async getStorageInfo() { return { root: 'E2E isolated storage', noteBytes: 0, assetBytes: 0, trashBytes: 0 } },
    async moveStorageRoot() { return },
    async restartApplication() { return },
    async onChanged() { return () => undefined },
    async getShortcutStatus() { return { current: settings.shortcut, registration: { state: 'active' }, acceptingTriggers: true, startupError: null } },
  }
}
