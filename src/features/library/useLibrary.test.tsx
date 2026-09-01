import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderId, NoteDocument, NoteId, NoteSummary } from '../../domain/model'
import { fakeFolderPort, fakeNotePort, note } from '../../test/fakes'
import { useLibrary } from './useLibrary'

const folderA = '019c0000-0000-7000-8000-000000000121' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000122' as FolderId

afterEach(cleanup)

describe('useLibrary createNote', () => {
  it('uses an explicit target folder instead of the active folder', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: folderB })
    const notes = fakeNotePort({ createNote })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('目标目录', folderB))

    expect(createNote).toHaveBeenCalledWith({ folderId: folderB, title: '目标目录' })
  })

  it('falls back to the active folder when no target folder is passed', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: folderA })
    const notes = fakeNotePort({ createNote })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('当前目录'))

    expect(createNote).toHaveBeenCalledWith({ folderId: folderA, title: '当前目录' })
  })

  it('switches to an explicit root target and refreshes that root note list', async () => {
    const createNote = vi.fn().mockResolvedValue({ ...note(''), folderId: null })
    const listNotes = vi.fn().mockResolvedValue([])
    const notes = fakeNotePort({ createNote, listNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => hook.result.current.createNote('根目录笔记', null))

    expect(hook.result.current.activeFolderId).toBeNull()
    expect(listNotes).toHaveBeenLastCalledWith(null)
  })

  it('removes a deleted note from every cached folder list', async () => {
    const rootNote = { ...note('root'), id: '019c0000-0000-7000-8000-000000000131' as NoteId, folderId: null, title: '根目录笔记' }
    const folderNote = { ...note('folder'), id: '019c0000-0000-7000-8000-000000000132' as NoteId, folderId: folderA, title: '文件夹笔记' }
    const toSummary = ({ markdown, ...summary }: NoteDocument): NoteSummary => ({ ...summary, excerpt: markdown })
    const listNotes = vi.fn(async (folderId: FolderId | null) => folderId === null ? [toSummary(rootNote)] : [toSummary(folderNote)])
    const notes = fakeNotePort({ listNotes })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))

    await waitFor(() => expect(hook.result.current.notesByFolder['__unfiled__']).toHaveLength(1))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))

    act(() => hook.result.current.clearDeletedNote(folderNote.id))

    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notes).toEqual([])
  })
})

describe('useLibrary moveNote', () => {
  it('exposes a failed uncached destination read without inventing an incomplete list', async () => {
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => {
        if (id === folderB) throw new Error('read failed')
        return []
      }),
      moveNote: vi.fn(async () => ({ ...note('body'), folderId: folderB })),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    await act(async () => hook.result.current.moveNote(note('').id, folderB))
    expect(hook.result.current.notesByFolder[folderB]).toBeUndefined()
    expect(hook.result.current.folderNoteErrors[folderB]).toBe(true)
  })

  it.each(['move', 'delete'])('keeps unrelated destination refreshes alive during concurrent %s', async (operation) => {
    let finishB!: (items: NoteSummary[]) => void
    const folderC = '019c0000-0000-7000-8000-000000000123' as FolderId
    const first = { ...note('one'), folderId: folderB, excerpt: 'one' }
    const second = { ...note('two'), id: '019c0000-0000-7000-8000-000000000134' as NoteId, folderId: folderC, excerpt: 'two' }
    const notes = fakeNotePort({
      moveNote: vi.fn(async (id) => id === first.id ? first : second),
      listNotes: vi.fn(async (id) => id === folderB
        ? new Promise<NoteSummary[]>((resolve) => { finishB = resolve })
        : id === folderC ? [second] : []),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(first.id, folderB) })
    await waitFor(() => expect(notes.listNotes).toHaveBeenCalledWith(folderB))
    if (operation === 'move') await act(async () => hook.result.current.moveNote(second.id, folderC))
    else act(() => hook.result.current.clearDeletedNote(second.id))
    await act(async () => { finishB([first]); await moving })
    expect(hook.result.current.notesByFolder[folderB]).toEqual([first])
    if (operation === 'move') expect(hook.result.current.notesByFolder[folderC]).toEqual([second])
  })

  it('keeps a durable move visible in cached folders even if the follow-up read fails', async () => {
    const original = { ...note('body'), folderId: folderA, excerpt: 'body' }
    let moved = false
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => {
        if (moved) throw new Error('index temporarily unavailable')
        return id === folderA ? [original] : []
      }),
      moveNote: vi.fn(async () => { moved = true; return { ...original, folderId: folderB } }),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => hook.result.current.selectFolder(folderB))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderB]).toEqual([]))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))
    await act(async () => hook.result.current.moveNote(original.id, folderB))
    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notesByFolder[folderB]).toEqual([expect.objectContaining({
      id: original.id, title: original.title, folderId: folderB,
    })])
  })

  it('does not let a pending destination refresh resurrect a deleted note', async () => {
    let finishList!: (notes: NoteSummary[]) => void
    const moved = { ...note('body'), folderId: folderB }
    const notes = fakeNotePort({
      listNotes: vi.fn(async (id) => id === folderB
        ? new Promise<NoteSummary[]>((resolve) => { finishList = resolve })
        : []),
      moveNote: vi.fn(async () => moved),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    await waitFor(() => expect(hook.result.current.noteListState).toBe('ready'))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(moved.id, folderB) })
    await waitFor(() => expect(notes.listNotes).toHaveBeenCalledWith(folderB))
    act(() => hook.result.current.clearDeletedNote(moved.id))
    await act(async () => { finishList([{ ...moved, excerpt: 'body' }]); await moving })
    expect(hook.result.current.notesByFolder[folderB] ?? []).toEqual([])

    // A fresh read after undo may legitimately contain the restored note again.
    let restored!: Promise<void>
    act(() => { restored = hook.result.current.refreshNotes(folderB, true) })
    await act(async () => { finishList([{ ...moved, excerpt: 'body' }]); await restored })
    expect(hook.result.current.notesByFolder[folderB]).toEqual([{ ...moved, excerpt: 'body' }])
  })

  it.each([false, true])('refreshes both folder lists without another click (cached destination: %s)', async (cachedDestination) => {
    let stored: NoteDocument = { ...note('body'), folderId: folderA }
    const summary = (): NoteSummary => ({ ...stored, excerpt: 'body' })
    const listNotes = vi.fn(async (id: FolderId | null) => id === stored.folderId ? [summary()] : [])
    const notes = fakeNotePort({
      listNotes,
      loadNote: vi.fn(async () => stored),
      moveNote: vi.fn(async (_id, folderId) => (stored = { ...stored, folderId })),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    if (cachedDestination) {
      act(() => hook.result.current.selectFolder(folderB))
      await waitFor(() => expect(hook.result.current.notesByFolder[folderB]).toEqual([]))
    }
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.notesByFolder[folderA]).toHaveLength(1))
    act(() => hook.result.current.selectNote(stored.id))
    await waitFor(() => expect(hook.result.current.document?.folderId).toBe(folderA))

    await act(async () => hook.result.current.moveNote(stored.id, folderB))

    expect(hook.result.current.notesByFolder[folderA]).toEqual([])
    expect(hook.result.current.notesByFolder[folderB]).toEqual([summary()])
    expect(hook.result.current.notes).toEqual([])
    expect(hook.result.current.document?.folderId).toBe(folderB)
    expect(hook.result.current.activeFolderId).toBe(folderA)

    await act(async () => hook.result.current.moveNote(stored.id, folderA))
    expect(hook.result.current.notesByFolder[folderB]).toEqual([])
    expect(hook.result.current.notesByFolder[folderA]).toEqual([summary()])
    expect(hook.result.current.notes).toEqual([summary()])
  })

  it('does not replace a newly selected document when a move finishes late', async () => {
    let finishMove!: (document: NoteDocument) => void
    const original = { ...note('body'), folderId: folderA }
    const other = { ...note('other'), id: '019c0000-0000-7000-8000-000000000133' as NoteId, folderId: folderB }
    const notes = fakeNotePort({
      loadNote: vi.fn(async (id) => id === original.id ? original : other),
      moveNote: vi.fn(() => new Promise<NoteDocument>((resolve) => { finishMove = resolve })),
      listNotes: vi.fn(async () => []),
    })
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders))
    act(() => { hook.result.current.selectFolder(folderA); hook.result.current.selectNote(original.id) })
    await waitFor(() => expect(hook.result.current.document?.id).toBe(original.id))
    let moving!: Promise<NoteDocument>
    act(() => { moving = hook.result.current.moveNote(original.id, folderB) })
    act(() => { hook.result.current.selectFolder(folderB); hook.result.current.selectNote(other.id) })
    await waitFor(() => expect(hook.result.current.document?.id).toBe(other.id))

    await act(async () => { finishMove({ ...original, folderId: folderB }); await moving })

    expect(hook.result.current.document?.id).toBe(other.id)
    expect(hook.result.current.activeFolderId).toBe(folderB)
    expect(notes.listNotes).toHaveBeenLastCalledWith(folderB)
  })
})