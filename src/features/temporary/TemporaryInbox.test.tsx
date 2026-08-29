import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Folder, FolderId, NoteDocument, NoteId } from '../../domain/model'
import type { TemporaryWindowPort } from '../../domain/ports'
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

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('TemporaryInbox', () => {
  it('opens a temporary capture in the document editor', async () => {
    const capture = twoCaptures()[0]
    const temporary = fakeTemporaryPort([capture])
    const user = userEvent.setup()

    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))

    expect(temporary.load).toHaveBeenCalledWith(capture.id)
    expect(await screen.findByRole('textbox', { name: 'Markdown source' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('发布前检查')
  })

  it('opens the listed snapshot when a second load is temporarily unavailable', async () => {
    const capture = twoCaptures()[0]
    const temporary = {
      ...fakeTemporaryPort([capture]),
      load: vi.fn().mockRejectedValue(new Error('temporary index busy')),
    }
    const user = userEvent.setup()

    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))

    expect(await screen.findByRole('textbox', { name: 'Markdown source' })).toBeVisible()
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveValue('发布前检查')
    expect(screen.queryByText('无法打开临时捕捉。')).not.toBeInTheDocument()
  })

  it('keeps the listed snapshot visible while the durable load is pending', async () => {
    const capture = twoCaptures()[0]
    const pendingLoad = deferred<NoteDocument>()
    const temporary = {
      ...fakeTemporaryPort([capture]),
      load: vi.fn(() => pendingLoad.promise),
    }
    const user = userEvent.setup()

    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))

    expect(await screen.findByRole('textbox', { name: 'Markdown source' })).toHaveValue('发布前检查')
    expect(screen.queryByText('正在打开临时捕捉…')).not.toBeInTheDocument()
    pendingLoad.resolve(capture)
  })

  it('does not reload the inbox just because a capture is opened', async () => {
    const capture = twoCaptures()[0]
    const pendingLoad = deferred<NoteDocument>()
    const list = vi.fn().mockResolvedValue([capture])
    const temporary = { ...fakeTemporaryPort([capture]), list, load: vi.fn(() => pendingLoad.promise) }
    const user = userEvent.setup()

    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)
    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))

    expect(list).toHaveBeenCalledOnce()
    pendingLoad.resolve(capture)
  })

  it('reopens a hidden sticky window from the main temporary inbox', async () => {
    const captures = twoCaptures()
    const windows = {
      show: vi.fn().mockResolvedValue({ noteId: captures[0].id, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop: true }),
    } as Pick<TemporaryWindowPort, 'show'>
    render(<TemporaryInbox temporary={fakeTemporaryPort(captures)} folders={folderRows} windows={windows} />)

    await userEvent.click(await screen.findByRole('button', { name: '重新显示 发布前检查' }))

    expect(windows.show).toHaveBeenCalledWith(captures[0].id)
  })

  it('uses the configured autosave delay for the active temporary draft', async () => {
    vi.useFakeTimers()
    const captures = twoCaptures()
    const save = vi.fn(async (document: NoteDocument) => document)
    const temporary = { ...fakeTemporaryPort(captures), save }
    render(<TemporaryInbox temporary={temporary} folders={folderRows} autosaveDelayMs={175} />)
    const title = deriveTemporaryPreviewTitle(captures[0].markdown, captures[0].createdAt)
    await act(async () => undefined)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(title) }))
    await act(async () => undefined)
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'delayed draft' } }))
    await act(async () => vi.advanceTimersByTimeAsync(174))
    expect(save).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(save).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
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

  it('deletes successful captures directly to trash and leaves failed captures selected', async () => {
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
    expect(screen.queryByRole('button', { name: '撤销删除' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: '选择 接口异常处理' })).toBeChecked()
    expect(temporary.undoDelete).not.toHaveBeenCalled()
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
    const inboxRef = createRef<import('./TemporaryInbox').TemporaryInboxHandle>()
    render(<TemporaryInbox ref={inboxRef} temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await act(async () => { await inboxRef.current?.refresh() })

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

  it('claims the mutation synchronously before awaiting an editor flush', async () => {
    const capture = twoCaptures()[0]
    const pendingSave = deferred<NoteDocument>()
    const save = vi.fn(() => pendingSave.promise)
    const remove = vi.fn(async () => ({ operationId: 'op', deleted: [capture.id], failed: [] }))
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort([capture]), save, delete: remove }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: `选择 ${capture.markdown}` }))
    await user.click(screen.getByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'pending durable edit' } }))
    const deleteButton = screen.getByRole('button', { name: /删除所选/ })

    deleteButton.click()
    deleteButton.click()

    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(remove).not.toHaveBeenCalled()
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: ' must not race' } }))
    expect(editor.state.doc.toString()).toBe('pending durable edit')
    await act(async () => pendingSave.resolve({ ...capture, markdown: 'pending durable edit', revision: 1 }))
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  })

  it('blocks capture navigation while a destructive mutation is in flight', async () => {
    const captures = twoCaptures()
    const pendingDelete = deferred<{ operationId: string; deleted: NoteId[]; failed: [] }>()
    const load = vi.fn(fakeTemporaryPort(captures).load)
    const remove = vi.fn(() => pendingDelete.promise)
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort(captures), load, delete: remove }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: `选择 ${captures[0].markdown}` }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    const otherCapture = screen.getByRole('button', { name: new RegExp(captures[1].markdown) })

    expect(otherCapture).toBeDisabled()
    otherCapture.click()
    expect(load).not.toHaveBeenCalledWith(captures[1].id)

    await act(async () => pendingDelete.resolve({ operationId: 'op', deleted: [captures[0].id], failed: [] }))
  })

  it('claims conversion synchronously and snapshots the selected captures before flushing', async () => {
    const captures = twoCaptures()
    const pendingSave = deferred<NoteDocument>()
    const save = vi.fn(() => pendingSave.promise)
    const convert = vi.fn(async ({ ids }: { ids: NoteId[]; folderId: FolderId }) => ({
      converted: ids.map((temporaryId) => ({ temporaryId, noteId: temporaryId })),
      failed: [],
    }))
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort(captures), save, convert }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: /选择 发布前检查/ }))
    await user.click(screen.getByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'pending conversion edit' } }))
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    await user.selectOptions(await screen.findByRole('combobox', { name: '目标文件夹' }), project)
    await user.clear(screen.getByRole('textbox', { name: '笔记标题' }))
    await user.type(screen.getByRole('textbox', { name: '笔记标题' }), '发布前检查笔记')
    await user.type(screen.getByRole('textbox', { name: '笔记标签' }), '工作,发布')
    const confirm = screen.getByRole('button', { name: '确认转换' })

    confirm.click()
    confirm.click()

    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    expect(convert).not.toHaveBeenCalled()
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    await act(async () => pendingSave.resolve({ ...captures[0], markdown: 'pending conversion edit', revision: 2 }))
    await waitFor(() => expect(convert).toHaveBeenCalledOnce())
    expect(convert).toHaveBeenCalledWith({ ids: [captures[0].id], folderId: project, title: '发布前检查笔记', tags: ['工作', '发布'] })
  })

  it('refreshes automatically and does not expose a manual refresh button', async () => {
    vi.useFakeTimers()
    const list = vi.fn().mockResolvedValue(twoCaptures())
    const temporary = { ...fakeTemporaryPort(twoCaptures()), list }
    render(<TemporaryInbox temporary={temporary} folders={folderRows} />)

    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('checkbox', { name: '选择 发布前检查' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '刷新临时收集箱' })).not.toBeInTheDocument()

    const initialCalls = list.mock.calls.length
    await act(async () => vi.advanceTimersByTimeAsync(1500))
    expect(list.mock.calls.length).toBeGreaterThan(initialCalls)
  })

  it('refreshes the formal library after a successful conversion', async () => {
    const capture = twoCaptures()[0]
    const convert = vi.fn(async () => ({
      converted: [{ temporaryId: capture.id, noteId: capture.id }],
      failed: [],
    }))
    const onConversionComplete = vi.fn(async () => undefined)
    const user = userEvent.setup()
    render(
      <TemporaryInbox
        temporary={{ ...fakeTemporaryPort([capture]), convert }}
        folders={folderRows}
        onConversionComplete={onConversionComplete}
      />,
    )

    await user.click(await screen.findByRole('checkbox', { name: /选择 发布前检查/ }))
    await user.click(screen.getByRole('button', { name: '转为笔记' }))
    await user.selectOptions(await screen.findByRole('combobox', { name: '目标文件夹' }), project)
    await user.click(screen.getByRole('button', { name: '确认转换' }))

    await waitFor(() => expect(onConversionComplete).toHaveBeenCalledWith(capture.id, project))
  })

  it('keeps the current capture open when its flush fails during a switch', async () => {
    const captures = twoCaptures()
    const load = vi.fn(fakeTemporaryPort(captures).load)
    const save = vi.fn().mockRejectedValue(new Error('disk full'))
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort(captures), load, save }} folders={folderRows} />)

    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'unsaved A' } }))
    await user.click(screen.getByRole('button', { name: /接口异常处理/ }))

    expect(await screen.findByText('当前临时捕捉无法保存。请重试保存后再切换。')).toBeVisible()
    expect(screen.getByRole('button', { name: /发布前检查/ })).toHaveAttribute('aria-current', 'true')
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalledWith(captures[1].id)
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))?.state.doc.toString()).toBe('unsaved A')
  })

  it('flushes before loading a new capture and ignores an older load result', async () => {
    const captures = twoCaptures()
    const third = { ...captures[0], id: '019c0000-0000-7000-8000-000000000012' as NoteId, markdown: 'third capture' }
    const pendingSave = deferred<NoteDocument>()
    const pendingSecond = deferred<NoteDocument>()
    const load = vi.fn((id: NoteId) => id === captures[1].id ? pendingSecond.promise : Promise.resolve([captures[0], captures[1], third].find((item) => item.id === id)!))
    const save = vi.fn(() => pendingSave.promise)
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{ ...fakeTemporaryPort([captures[0], captures[1], third]), load, save }} folders={folderRows} />)

    await user.click(await screen.findByRole('button', { name: /发布前检查/ }))
    const editor = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'durable A' } }))
    screen.getByRole('button', { name: /接口异常处理/ }).click()
    expect(load).not.toHaveBeenCalledWith(captures[1].id)
    expect(editor.state.facet(EditorView.editable)).toBe(false)
    await act(async () => pendingSave.resolve({ ...captures[0], markdown: 'durable A', revision: 2 }))
    await waitFor(() => expect(load).toHaveBeenCalledWith(captures[1].id))
    screen.getByRole('button', { name: /third capture/ }).click()
    await waitFor(() => expect(screen.getByRole('button', { name: /third capture/ })).toHaveAttribute('aria-current', 'true'))
    await act(async () => pendingSecond.resolve(captures[1]))
    expect(screen.getByRole('button', { name: /third capture/ })).toHaveAttribute('aria-current', 'true')
    expect(EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))?.state.doc.toString()).toBe('third capture')
  })

  it('does not offer undo when every requested deletion fails', async () => {
    const capture = twoCaptures()[0]
    const user = userEvent.setup()
    render(<TemporaryInbox temporary={{
      ...fakeTemporaryPort([capture]),
      delete: vi.fn(async () => ({ operationId: 'unused-operation', deleted: [], failed: [{ temporaryId: capture.id, message: '文件正被使用' }] })),
    }} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: /选择/ }))
    await user.click(screen.getByRole('button', { name: '删除所选' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('文件正被使用')
    expect(screen.queryByRole('button', { name: '撤销删除' })).not.toBeInTheDocument()
  })

  it('does not select a capture created during a refresh after deletion', async () => {
    const captures = twoCaptures()
    const created = { ...captures[0], id: '019c0000-0000-7000-8000-000000000088' as NoteId, markdown: 'new shortcut capture' }
    const list = vi.fn().mockResolvedValueOnce(captures).mockResolvedValue([...captures, created])
    const temporary = {
      ...fakeTemporaryPort(captures),
      list,
      delete: vi.fn(async () => ({ operationId: 'op', deleted: [captures[0].id], failed: [] })),
    }
    const user = userEvent.setup()
    const inboxRef = createRef<import('./TemporaryInbox').TemporaryInboxHandle>()
    render(<TemporaryInbox ref={inboxRef} temporary={temporary} folders={folderRows} />)

    await user.click(await screen.findByRole('checkbox', { name: '选择 发布前检查' }))
    await act(async () => { await inboxRef.current?.refresh() })
    expect(await screen.findByRole('checkbox', { name: '选择 new shortcut capture' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: '删除所选' }))
    expect(screen.queryByRole('button', { name: '撤销删除' })).not.toBeInTheDocument()
  })
})
