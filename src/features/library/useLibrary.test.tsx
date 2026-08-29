import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderId, NoteId } from '../../domain/model'
import { fakeFolderPort, fakeNotePort, note } from '../../test/fakes'
import { useLibrary } from './useLibrary'

const folderA = '019c0000-0000-7000-8000-000000000121' as FolderId
const folderB = '019c0000-0000-7000-8000-000000000122' as FolderId
const guideFolderId = '019c0000-0000-7000-8000-000000000123' as FolderId
const guideNoteId = '019c0000-0000-7000-8000-000000000124' as NoteId

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

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
})

describe('useLibrary startup guide', () => {
  it('opens the guide returned for a fresh installation', async () => {
    const guide = {
      ...note('# 欢迎来到微屿'),
      id: guideNoteId,
      folderId: guideFolderId,
      title: '欢迎来到微屿',
    }
    const notes = fakeNotePort({
      listNotes: vi.fn().mockImplementation(async (folderId) =>
        folderId === guideFolderId ? [{ ...guide, excerpt: guide.markdown }] : [],
      ),
      loadNote: vi.fn().mockResolvedValue(guide),
    })
    const folders = fakeFolderPort({
      listFolders: vi.fn().mockResolvedValue([
        { id: guideFolderId, parentId: null, name: '开始使用', sortOrder: 0 },
      ]),
    })
    const completeTarget = vi.fn().mockResolvedValue(undefined)
    const startup = {
      loadTarget: vi.fn().mockResolvedValue({ folderId: guideFolderId, noteId: guideNoteId }),
      completeTarget,
    }
    const hook = renderHook(() => useLibrary(notes, folders, startup))

    await waitFor(() => expect(hook.result.current.document?.id).toBe(guideNoteId))
    expect(hook.result.current.activeFolderId).toBe(guideFolderId)
    expect(hook.result.current.activeNoteId).toBe(guideNoteId)
    expect(completeTarget).toHaveBeenCalledWith({ folderId: guideFolderId, noteId: guideNoteId })
  })

  it('does not override navigation performed before the startup target arrives', async () => {
    const target = deferred<{ folderId: FolderId; noteId: NoteId } | null>()
    const startup = {
      loadTarget: vi.fn().mockReturnValue(target.promise),
      completeTarget: vi.fn().mockResolvedValue(undefined),
    }
    const notes = fakeNotePort()
    const folders = fakeFolderPort()
    const hook = renderHook(() => useLibrary(notes, folders, startup))
    act(() => hook.result.current.selectFolder(folderA))
    await waitFor(() => expect(hook.result.current.activeFolderId).toBe(folderA))

    await act(async () => {
      target.resolve({ folderId: guideFolderId, noteId: guideNoteId })
      await Promise.resolve()
    })

    expect(hook.result.current.activeFolderId).toBe(folderA)
    expect(hook.result.current.activeNoteId).toBeNull()
  })
})
