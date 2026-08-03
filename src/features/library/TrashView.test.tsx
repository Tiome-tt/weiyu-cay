import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId } from '../../domain/model'
import type { TrashEntry, TrashPort } from '../../domain/ports'
import { TrashView } from './TrashView'

const project = '019c0000-0000-7000-8000-000000000021' as FolderId
const missingFolder = '019c0000-0000-7000-8000-000000000022' as FolderId
const formalId = '019c0000-0000-7000-8000-000000000031' as NoteId
const temporaryId = '019c0000-0000-7000-8000-000000000032' as NoteId
const recoveredFolder = '019c0000-0000-7000-8000-000000000023' as FolderId

const folders: Folder[] = [{ id: project, parentId: null, name: '项目 A', sortOrder: 0 }]
const entries: TrashEntry[] = [
  {
    noteId: formalId,
    kind: 'formal',
    title: '发布清单',
    previousFolderId: project,
    previousRelativePath: `notes/${formalId}`,
    deletedAt: '2026-08-02T02:30:00Z',
    assets: [],
    operationId: 'delete-op',
  },
  {
    noteId: temporaryId,
    kind: 'temporary',
    title: '临时想法',
    previousFolderId: missingFolder,
    previousRelativePath: `temporary/${temporaryId}`,
    deletedAt: '2026-08-01T02:30:00Z',
    assets: ['assets/screenshot.png'],
    operationId: 'older-delete-op',
  },
]

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TrashView', () => {
  it('lists formal and temporary notes with their prior folder, kind, and deletion date', async () => {
    render(<TrashView trash={fakeTrashPort()} folders={folders} />)

    expect(await screen.findByRole('checkbox', { name: '选择 发布清单' })).toBeVisible()
    expect(screen.getByText('正式笔记')).toBeVisible()
    expect(screen.getByText('原位置：项目 A')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: '选择 临时想法' })).toBeVisible()
    expect(screen.getByText('临时捕捉')).toBeVisible()
    expect(screen.getByText('原文件夹不可用，将恢复到“已恢复”')).toBeVisible()
    expect(screen.getAllByText(/2026/)).toHaveLength(2)
  })

  it('multi-selects and restores entries while reporting the missing-folder recovery destination', async () => {
    const restored = vi.fn(async (ids: NoteId[]) => ({
      restored: ids.map((id) => restoredDocument(id, id === temporaryId ? recoveredFolder : project)),
      failed: [],
    }))
    const user = userEvent.setup()
    render(<TrashView trash={fakeTrashPort({ restore: restored })} folders={folders} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布清单' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 临时想法' }))
    await user.click(screen.getByRole('button', { name: '恢复所选' }))

    expect(restored).toHaveBeenCalledWith([formalId, temporaryId])
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('已恢复 2 项')
    expect(status).toHaveTextContent('原文件夹不可用的项目已放入“已恢复”')
    expect(status).toHaveFocus()
    expect(screen.queryByRole('checkbox', { name: '选择 发布清单' })).not.toBeInTheDocument()
  })

  it('offers an immediate undo entry point, blocks duplicate activation, and refreshes the list', async () => {
    let resolveUndo!: (value: Awaited<ReturnType<TrashPort['undo']>>) => void
    const pending = new Promise<Awaited<ReturnType<TrashPort['undo']>>>((resolve) => { resolveUndo = resolve })
    const undo = vi.fn(() => pending)
    const list = vi.fn().mockResolvedValueOnce(entries).mockResolvedValueOnce([])
    render(<TrashView trash={fakeTrashPort({ list, undo })} folders={folders} recentOperationId="delete-op" />)

    const button = await screen.findByRole('button', { name: '撤销最近删除' })
    button.click()
    button.click()
    expect(undo).toHaveBeenCalledOnce()
    expect(undo).toHaveBeenCalledWith('delete-op')
    await waitFor(() => expect(button).toBeDisabled())

    resolveUndo({ restored: [restoredDocument(formalId, project)], failed: [] })
    expect(await screen.findByText('已撤销最近删除，恢复 1 项。')).toHaveFocus()
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it('derives the immediate undo entry point from the newest trash operation', async () => {
    const undo = vi.fn().mockResolvedValue({ restored: [], failed: [] })
    const user = userEvent.setup()
    render(<TrashView trash={fakeTrashPort({ undo })} folders={folders} />)

    await user.click(await screen.findByRole('button', { name: '撤销最近删除' }))
    expect(undo).toHaveBeenCalledWith('delete-op')
  })

  it('supports keyboard selection and preserves failed entries with an actionable error', async () => {
    const restore = vi.fn().mockResolvedValue({
      restored: [],
      failed: [{ noteId: formalId, message: '文件正在被使用，请关闭后重试' }],
    })
    const user = userEvent.setup()
    render(<TrashView trash={fakeTrashPort({ restore })} folders={folders} />)

    const checkbox = await screen.findByRole('checkbox', { name: '选择 发布清单' })
    checkbox.focus()
    await user.keyboard(' ')
    expect(checkbox).toBeChecked()
    await user.click(screen.getByRole('button', { name: '恢复所选' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('文件正在被使用，请关闭后重试')
    expect(screen.getByRole('checkbox', { name: '选择 发布清单' })).toBeVisible()
    expect(screen.getByRole('button', { name: '恢复所选' })).toBeEnabled()
  })

  it('shows load and operation failures without leaving controls busy', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <TrashView trash={fakeTrashPort({ list: vi.fn().mockRejectedValue(new Error('offline')) })} folders={folders} />,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载回收站')

    rerender(<TrashView trash={fakeTrashPort({ restore: vi.fn().mockRejectedValue(new Error('disk full')) })} folders={folders} />)
    await user.click(await screen.findByRole('checkbox', { name: '选择 发布清单' }))
    await user.click(screen.getByRole('button', { name: '恢复所选' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法恢复所选项目，请重试')
    expect(screen.getByRole('button', { name: '恢复所选' })).toBeEnabled()
  })
})

function fakeTrashPort(overrides: Partial<TrashPort> = {}): TrashPort {
  return {
    trash: vi.fn().mockResolvedValue({ operationId: 'delete-op', trashed: [], failed: [] }),
    list: vi.fn().mockResolvedValue(entries),
    restore: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
    undo: vi.fn().mockResolvedValue({ restored: [], failed: [] }),
    ...overrides,
  }
}

function restoredDocument(id: NoteId, folderId: FolderId | null): NoteDocument {
  return {
    id,
    kind: id === temporaryId ? 'temporary' : 'formal',
    title: id === temporaryId ? '临时想法' : '发布清单',
    folderId,
    tags: [],
    markdown: '',
    revision: 1,
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
  }
}
