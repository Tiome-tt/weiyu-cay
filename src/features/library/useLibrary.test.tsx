import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderId } from '../../domain/model'
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
})
