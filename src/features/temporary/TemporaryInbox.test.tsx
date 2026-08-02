import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId } from '../../domain/model'
import { fakeTemporaryPort, twoCaptures } from '../../test/fakes'
import { deriveTemporaryPreviewTitle, TemporaryInbox } from './TemporaryInbox'

const project = '019c0000-0000-7000-8000-000000000021' as FolderId
const folderRows: Folder[] = [
  { id: project, parentId: null, name: '项目', sortOrder: 0 },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

afterEach(cleanup)

describe('TemporaryInbox', () => {
  it.each([
    ['removes one ATX marker run', '\n  ###  发布检查  \nbody', '发布检查'],
    ['keeps a hashtag that is not a heading', '#urgent keep', '#urgent keep'],
    ['collapses supported Unicode whitespace', '  中\u3000文\t😀  ', '中 文 😀'],
    ['counts Unicode scalar values instead of UTF-16 units', `${'界'.repeat(79)}😀尾`, `${'界'.repeat(79)}😀`],
    ['uses a deterministic localized fallback', '\u3000\t\n', '未命名笔记 2026-08-02 12-34'],
  ])('%s', (_case, markdown, expected) => {
    expect(deriveTemporaryPreviewTitle(markdown, '2026-08-02T12:34:56+08:00')).toBe(expected)
  })

  it('converts selected captures to one chosen folder and keeps only failed captures selected', async () => {
    const captures = twoCaptures()
    const convert = vi.fn(async ({ ids }: { ids: NoteId[]; folderId: FolderId }) => ({
      converted: [{ temporaryId: ids[0], noteId: ids[0] }],
      failed: [{ temporaryId: ids[1], message: '目标文件夹不可用' }],
    }))
    const temporary = {
      ...fakeTemporaryPort(captures),
      convert,
      delete: vi.fn(),
      undoDelete: vi.fn(),
    }
    const user = userEvent.setup()

    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 接口异常处理' }))
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    const destination = await screen.findByRole('combobox', { name: '目标文件夹' })
    await user.selectOptions(destination, project)
    await user.click(screen.getByRole('button', { name: '确认转换' }))

    await waitFor(() => expect(convert).toHaveBeenCalledWith({ ids: captures.map((item) => item.id), folderId: project }))
    expect(screen.queryByRole('checkbox', { name: '选择 发布前检查' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 接口异常处理' })).toBeChecked()
    expect(screen.getByRole('alert')).toHaveTextContent('目标文件夹不可用')
  })

  it('deletes successful captures, exposes undo, and leaves failed captures selected', async () => {
    const captures = twoCaptures()
    const deleted = captures[0].id
    const temporary = {
      ...fakeTemporaryPort(captures),
      convert: vi.fn(),
      delete: vi.fn(async () => ({
        operationId: '019c0000-0000-7000-8000-000000000099',
        deleted: [deleted],
        failed: [{ temporaryId: captures[1].id, message: '文件正被使用' }],
      })),
      undoDelete: vi.fn(async () => ({ operationId: '019c0000-0000-7000-8000-000000000099', restored: [deleted], failed: [] })),
    }
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('checkbox', { name: '选择 接口异常处理' }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))

    await waitFor(() => expect(temporary.delete).toHaveBeenCalledWith(captures.map((item) => item.id)))
    expect(screen.getByRole('button', { name: '撤销删除' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: '选择 接口异常处理' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: '撤销删除' }))
    await waitFor(() => expect(temporary.undoDelete).toHaveBeenCalledWith('019c0000-0000-7000-8000-000000000099'))
  })

  it('removes stale selection when a refresh no longer includes that capture', async () => {
    const captures = twoCaptures()
    const list = vi.fn().mockResolvedValueOnce(captures).mockResolvedValueOnce([captures[1]])
    const temporary = {
      ...fakeTemporaryPort(captures),
      list,
      convert: vi.fn(),
      delete: vi.fn(async () => ({ operationId: 'op', deleted: [], failed: [] })),
      undoDelete: vi.fn(),
    }
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: '刷新临时收集箱' }))

    await waitFor(() => expect(screen.queryByRole('checkbox', { name: '选择 发布前检查' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: '删除所选' })).toBeDisabled()
  })

  it('reports an empty inbox and a safe loading error', async () => {
    const { unmount } = render(
      <TemporaryInbox temporary={{ ...fakeTemporaryPort([]) }} folders={folderRows} />,
    )
    expect(await screen.findByText('临时收集箱为空。')).toBeVisible()
    unmount()

    render(
      <TemporaryInbox
        temporary={{ ...fakeTemporaryPort([]), list: vi.fn().mockRejectedValue(new Error('C:\\private\\capture.md')) }}
        folders={folderRows}
      />,
    )
    expect(await screen.findByText('无法加载临时捕捉。')).toBeVisible()
    expect(screen.queryByText(/private/)).not.toBeInTheDocument()
  })

  it('supports select all and keyboard cancellation of a focused conversion dialog', async () => {
    const child = '019c0000-0000-7000-8000-000000000022' as FolderId
    const user = userEvent.setup()
    render(
      <TemporaryInbox
        temporary={fakeTemporaryPort(twoCaptures())}
        folders={[...folderRows, { id: child, parentId: project, name: '子项目', sortOrder: 0 }]}
      />,
    )

    await user.click(await screen.findByRole('button', { name: '全选' }))
    expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    const destination = await screen.findByRole('combobox', { name: '目标文件夹' })
    expect(destination).toHaveFocus()
    expect(screen.getByRole('option', { name: '项目 / 子项目' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps Tab focus inside the conversion dialog and disables confirmation when there are no folders', async () => {
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={fakeTemporaryPort(twoCaptures())} folders={[]} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    const destination = await screen.findByRole('combobox', { name: '目标文件夹' })
    const cancel = screen.getByRole('button', { name: '取消' })
    const confirm = screen.getByRole('button', { name: '确认转换' })
    expect(confirm).toBeDisabled()
    expect(destination).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(destination).toHaveFocus()
    await user.tab({ shift: true })
    expect(cancel).toHaveFocus()
  })

  it('keeps destructive actions disabled without a selection and never converts after dialog cancellation', async () => {
    const convert = vi.fn()
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort(twoCaptures()), convert }} folders={folderRows} />)

    expect(screen.getByRole('button', { name: '删除所选' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '转为笔记' })).toBeDisabled()
    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(convert).not.toHaveBeenCalled()
  })

  it('prevents duplicate deletion while the first request is pending and exposes its busy state', async () => {
    const pending = deferred<{ operationId: string; deleted: NoteId[]; failed: [] }>()
    const remove = vi.fn(() => pending.promise)
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort(twoCaptures()), delete: remove }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    expect(screen.getByRole('button', { name: '正在删除…' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: '正在删除…' }))
    expect(remove).toHaveBeenCalledOnce()
    await act(async () => pending.resolve({ operationId: 'op', deleted: [], failed: [] }))
  })

  it('flushes an open selected capture before deletion and does not submit when the flush fails', async () => {
    const capture = twoCaptures()[0]
    const save = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 2 }))
    const remove = vi.fn(async () => ({ operationId: 'op', deleted: [], failed: [] }))
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort([capture]), save, delete: remove }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'durable edit' } }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: capture.id, markdown: 'durable edit' })))
    expect(remove).toHaveBeenCalledWith([capture.id])

    const failedSave = vi.fn().mockRejectedValue(new Error('disk full'))
    const failedDelete = vi.fn()
    cleanup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort([capture]), save: failedSave, delete: failedDelete }} folders={folderRows} />)
    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: /发布前检查/ }))
    const failedEditor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (failedEditor === null) throw new Error('CodeMirror view not found')
    act(() => failedEditor.dispatch({ changes: { from: 0, to: failedEditor.state.doc.length, insert: 'kept edit' } }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    expect(await screen.findByText('请先解决保存错误，再删除临时捕捉。')).toBeVisible()
    expect(failedDelete).not.toHaveBeenCalled()
  })

  it('does not select a capture created during a refresh and keeps a partial undo retryable', async () => {
    const captures = twoCaptures()
    const created = { ...captures[0], id: '019c0000-0000-7000-8000-000000000088' as NoteId, markdown: 'new shortcut capture' }
    const list = vi.fn().mockResolvedValueOnce(captures).mockResolvedValue([...captures, created])
    const undoDelete = vi.fn(async () => ({ operationId: 'op', restored: [], failed: [{ temporaryId: captures[0].id, message: '恢复冲突' }] }))
    const temporary = {
      ...fakeTemporaryPort(captures),
      list,
      delete: vi.fn(async () => ({ operationId: 'op', deleted: [captures[0].id], failed: [] })),
      undoDelete,
    }
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await user.click(screen.getByRole('button', { name: '刷新临时收集箱' }))
    expect(await screen.findByRole('checkbox', { name: '选择 new shortcut capture' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    await user.click(await screen.findByRole('button', { name: '撤销删除' }))
    expect(await screen.findByText('恢复冲突')).toBeVisible()
    expect(screen.getByRole('button', { name: '撤销删除' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: '撤销删除' }))
    expect(undoDelete).toHaveBeenCalledTimes(2)
  })
})
