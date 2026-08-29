import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import { fakeAssetPort, fakeLinkPort, fakeNotePort, fakeSearchPort, note, pngBytes } from '../../test/fakes'
import { EditorPane } from './EditorPane'

afterEach(cleanup)

const labels = ['源码视图', '分栏视图', '预览视图']

function view() {
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const editor = EditorView.findFromDOM(textbox)
  if (editor === null) throw new Error('CodeMirror view not found')
  return editor
}

function openMoreActions() {
  fireEvent.click(screen.getByRole('button', { name: '笔记更多操作' }))
  return screen.getByRole('menu', { name: '笔记操作' })
}

describe('EditorPane', () => {
  it('inserts and retargets escaped stable links through keyboard-reachable controls', async () => {
    const first = {
      ...note(''),
      id: '019c0000-0000-7000-8000-000000000081' as NoteId,
      title: 'A|B[1]',
      excerpt: '',
    }
    const second = {
      ...note(''),
      id: '019c0000-0000-7000-8000-000000000082' as NoteId,
      title: 'Second',
      excerpt: '',
    }
    const links = fakeLinkPort({ listTargets: vi.fn().mockResolvedValue([first, second]) })
    const user = userEvent.setup()
    render(<EditorPane document={note('')} notes={fakeNotePort()} links={links} linkCache={new Map()} />)

    openMoreActions()
    const target = await screen.findByRole('combobox', { name: '内部链接目标' })
    await user.selectOptions(target, first.id)
    await user.click(screen.getByRole('menuitem', { name: '插入内部链接' }))
    expect(view().state.doc.toString()).toBe(`[[A\\|B\\[1\\]|${first.id}]]`)

    openMoreActions()
    await user.selectOptions(screen.getByRole('combobox', { name: '内部链接目标' }), second.id)
    await user.click(screen.getByRole('menuitem', { name: '重定向内部链接' }))
    expect(view().state.doc.toString()).toBe(`[[Second|${second.id}]]`)
    expect(screen.getByRole('link', { name: '[[Second]]' })).toBeVisible()
  })

  it('starts in the configured default editor view', () => {
    render(<EditorPane document={note('# Preview')} notes={fakeNotePort()} initialMode="preview" autosaveDelayMs={10_000} />)
    expect(screen.getByRole('button', { name: '预览视图' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reports autosave state to the global toolbar while preserving detailed editor errors', async () => {
    const onSaveStateChange = vi.fn()
    render(
      <EditorPane
        document={note('')}
        notes={fakeNotePort()}
        onSaveStateChange={onSaveStateChange}
        autosaveDelayMs={10_000}
      />,
    )

    act(() => view().dispatch({ changes: { from: 0, insert: '新的正文' } }))

    await waitFor(() => expect(onSaveStateChange).toHaveBeenCalledWith('dirty'))
  })

  it('places the note title and exactly three primary view controls in the editor toolbar', () => {
    render(<EditorPane document={{ ...note('# Goal'), title: 'Goal' }} notes={fakeNotePort()} assets={fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 })} />)

    const toolbar = screen.getByRole('toolbar', { name: '编辑器视图' })
    expect(within(toolbar).getByRole('heading', { name: 'Goal' })).toBeVisible()
    expect(within(toolbar).getAllByRole('button')).toHaveLength(3)
    labels.forEach((label) => {
      const button = within(toolbar).getByRole('button', { name: label })
      expect(button).toHaveAttribute('title', label)
    })
    expect(within(toolbar).getByTestId('icon-source')).toBeVisible()
    expect(within(toolbar).getByTestId('icon-split')).toBeVisible()
    expect(within(toolbar).getByTestId('icon-preview')).toBeVisible()
    expect(within(toolbar).getByRole('button', { name: labels[0] })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('collects secondary metadata controls in a keyboard-discoverable more menu', async () => {
    const links = fakeLinkPort({ listTargets: vi.fn().mockResolvedValue([]) })
    render(
      <EditorPane
        document={{ ...note('# Goal'), title: 'Goal' }}
        notes={fakeNotePort()}
        links={links}
        folders={[]}
        onMoveNote={vi.fn()}
        search={fakeSearchPort()}
      />,
    )

    const user = userEvent.setup()
    const toolbar = screen.getByRole('toolbar', { name: '编辑器视图' })
    const primary = toolbar.querySelector('.editor-toolbar__primary') as HTMLElement
    const trigger = within(primary).getByRole('button', { name: '笔记更多操作' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(within(trigger).getByTestId('icon-more')).toBeVisible()
    labels.forEach((label) => expect(within(primary).getByRole('button', { name: label })).toBeVisible())

    await user.click(trigger)
    const menu = screen.getByRole('menu', { name: '笔记操作' })
    expect(toolbar).toContainElement(menu)
    const linkTarget = within(menu).getByRole('combobox', { name: '内部链接目标' })
    const folderTarget = within(menu).getByRole('combobox', { name: '笔记文件夹' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(folderTarget).toHaveFocus()
    expect(linkTarget).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: '插入内部链接' })).toBeDisabled()
    expect(within(menu).getByRole('menuitem', { name: '重定向内部链接' })).toBeDisabled()
    expect(folderTarget).toBeEnabled()
    expect(within(menu).getByRole('textbox', { name: '添加标签' })).toBeEnabled()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu', { name: '笔记操作' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()

    await user.keyboard('{ArrowDown}')
    const reopened = screen.getByRole('menu', { name: '笔记操作' })
    const lastControl = within(reopened).getByRole('button', { name: '添加标签' })
    lastControl.focus()
    await user.tab()
    expect(screen.queryByRole('menu', { name: '笔记操作' })).not.toBeInTheDocument()
    expect(within(primary).getByRole('button', { name: '源码视图' })).toHaveFocus()
  })

  it('assigns notices, document, and backlinks to stable editor grid regions', () => {
    render(
      <EditorPane
        document={note('# Goal')}
        notes={fakeNotePort()}
        links={fakeLinkPort()}
        onNavigateNote={vi.fn()}
      />,
    )

    const pane = screen.getByRole('toolbar', { name: '编辑器视图' }).parentElement
    expect(pane?.querySelector(':scope > .editor-notices')).not.toBeNull()
    expect(pane?.querySelector(':scope > .editor-document')).not.toBeNull()
    expect(pane?.querySelector(':scope > .backlinks')).not.toBeNull()
  })

  it('keeps one document while switching source, split, and preview modes', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('# Goal')} notes={fakeNotePort()} />)

    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: labels[1] }))
    expect(view().state.doc.toString()).toBe('# Goal')
    expect(screen.getByRole('article')).toHaveTextContent('Goal')
    expect(screen.getByRole('button', { name: labels[1] })).toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: labels[2] }))
    expect(screen.queryByRole('textbox', { name: 'Markdown source' })).not.toBeInTheDocument()
    expect(screen.getByRole('article')).toHaveTextContent('Goal')
    expect(screen.getByRole('button', { name: labels[2] })).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates split preview immediately from the single source state', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('# Old')} notes={fakeNotePort()} autosaveDelayMs={10_000} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))

    const editor = view()
    act(() => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '## New' } })
    })

    expect(screen.getByRole('article')).toHaveTextContent('New')
    expect(screen.getByRole('article')).not.toHaveTextContent('Old')
  })

  it('preserves CodeMirror selection and source and preview scroll positions across modes', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    const editor = view()
    editor.dispatch({ selection: EditorSelection.cursor(5) })
    editor.scrollDOM.scrollTop = 31

    await user.click(screen.getByRole('button', { name: labels[1] }))
    const preview = screen.getByRole('article')
    preview.scrollTop = 46
    await user.click(screen.getByRole('button', { name: labels[2] }))
    await user.click(screen.getByRole('button', { name: labels[1] }))

    expect(view().state.selection.main.head).toBe(5)
    expect(view().scrollDOM.scrollTop).toBe(31)
    expect(screen.getByRole('article').scrollTop).toBe(46)
  })

  it('synchronizes split source scrolling with the preview', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))
    const source = view().scrollDOM
    const preview = screen.getByRole('article')
    Object.defineProperties(source, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 },
    })
    Object.defineProperties(preview, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 900 },
    })
    source.scrollTop = 200

    fireEvent.scroll(source)

    expect(preview.scrollTop).toBe(400)
  })

  it('resizes the internal split with pointer and keyboard controls and resets on double click', async () => {
    const user = userEvent.setup()
    render(<EditorPane document={note('one\ntwo\nthree')} notes={fakeNotePort()} />)
    await user.click(screen.getByRole('button', { name: labels[1] }))
    const divider = screen.getByRole('separator', { name: 'Resize editor split' })
    const documentBody = divider.parentElement
    if (documentBody === null) throw new Error('editor document body not found')
    vi.spyOn(documentBody, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })

    fireEvent.pointerDown(divider, { clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(divider, { clientX: 520, pointerId: 1 })
    fireEvent.pointerUp(divider, { pointerId: 1 })
    expect(divider).toHaveAttribute('aria-valuenow', '65')

    divider.focus()
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(divider).toHaveAttribute('aria-valuenow', '63')
    fireEvent.doubleClick(divider)
    expect(divider).toHaveAttribute('aria-valuenow', '50')
  })

  it('keeps a save failure visible with a keyboard-accessible retry action', async () => {
    const saveNote = vi
      .fn()
      .mockRejectedValueOnce(new Error('private storage detail'))
      .mockImplementationOnce(async (document) => ({ ...document, revision: 2 }))
    render(
      <EditorPane
        document={note('old')}
        notes={fakeNotePort({ saveNote })}
        autosaveDelayMs={10_000}
      />,
    )
    const editor = view()
    act(() => {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept draft' } })
      window.dispatchEvent(new Event('blur'))
    })

    const alert = await screen.findByRole('alert')
    const toolbar = screen.getByRole('toolbar', { name: '编辑器视图' })
    const compactStatus = within(toolbar).getByRole('status', { name: '保存失败' })
    expect(compactStatus).toHaveTextContent('保存失败')
    expect(compactStatus).not.toHaveTextContent('The note could not be saved')

    expect(toolbar).not.toContainElement(alert)
    expect(alert.closest('.editor-notices')).not.toBeNull()
    expect(alert).not.toHaveTextContent('private storage detail')
    expect(alert).toHaveTextContent('无法保存，修改内容已保留在本地。')
    const retry = within(alert).getByRole('button', { name: '重试保存' })
    retry.focus()
    expect(retry).toHaveFocus()
    await userEvent.click(retry)

    await waitFor(() => expect(saveNote).toHaveBeenCalledTimes(2))
    expect(saveNote).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: 'kept draft' }))
  })

  it('exposes a safe image-save failure without changing the note', async () => {
    const assets = {
      saveImage: vi.fn(async () => {
        throw new Error('C:\\private\\asset.png')
      }),
    }
    render(<EditorPane document={note('kept')} notes={fakeNotePort()} assets={assets} />)

    fireEvent.paste(view().contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存截图。')
    expect(view().state.doc.toString()).toBe('kept')
    expect(screen.getByRole('alert')).not.toHaveTextContent('private')
  })

  it('flushes Markdown before tag updates and adopts the authoritative revision', async () => {
    const calls: string[] = []
    const authoritative = { ...note('draft'), tags: ['Backend'], revision: 3 }
    const notes = fakeNotePort({
      saveNote: vi.fn(async (document) => { calls.push('save'); return { ...document, revision: 2 } }),
      loadNote: vi.fn(async () => { calls.push('load'); return authoritative }),
    })
    const search = fakeSearchPort({
      updateTags: vi.fn(async () => { calls.push('tags'); return ['Backend'] }),
    })
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    render(<EditorPane document={note('old')} notes={notes} search={search} onDocumentAdopt={onDocumentAdopt} autosaveDelayMs={10_000} />)
    act(() => view().dispatch({ changes: { from: 0, to: 3, insert: 'draft' } }))

    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')

    await waitFor(() => expect(onDocumentAdopt).toHaveBeenCalledWith(authoritative))
    expect(calls).toEqual(['save', 'tags', 'load'])
    expect(search.updateTags).toHaveBeenCalledWith(note().id, ['Backend'])
  })

  it('does not load or adopt a stale tag response after switching notes', async () => {
    let resolveUpdate!: (tags: string[]) => void
    const update = new Promise<string[]>((resolve) => { resolveUpdate = resolve })
    const search = fakeSearchPort({ updateTags: vi.fn(() => update) })
    const notes = fakeNotePort()
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    const { rerender } = render(
      <EditorPane document={note('A')} notes={notes} search={search} onDocumentAdopt={onDocumentAdopt} />,
    )
    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')
    await waitFor(() => expect(search.updateTags).toHaveBeenCalled())

    rerender(
      <EditorPane
        document={{ ...note('B'), id: '019c0000-0000-7000-8000-000000000099' as NoteId }}
        notes={notes}
        search={search}
        onDocumentAdopt={onDocumentAdopt}
      />,
    )
    await act(async () => resolveUpdate(['Backend']))

    expect(notes.loadNote).not.toHaveBeenCalled()
    expect(onDocumentAdopt).not.toHaveBeenCalled()
  })

  it('locks source edits after flush until the authoritative tag revision is adopted', async () => {
    let resolveTags!: (tags: string[]) => void
    const pendingTags = new Promise<string[]>((resolve) => { resolveTags = resolve })
    const authoritative = { ...note('saved draft'), tags: ['Backend'], revision: 3 }
    const notes = fakeNotePort({
      saveNote: vi.fn(async (document) => ({ ...document, revision: 2 })),
      loadNote: vi.fn().mockResolvedValue(authoritative),
    })
    const search = fakeSearchPort({ updateTags: vi.fn(() => pendingTags) })
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    render(<EditorPane document={note('old')} notes={notes} search={search} onDocumentAdopt={onDocumentAdopt} autosaveDelayMs={10_000} />)
    act(() => view().dispatch({ changes: { from: 0, to: 3, insert: 'saved draft' } }))
    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')
    await waitFor(() => expect(search.updateTags).toHaveBeenCalled())

    act(() => view().dispatch({ changes: { from: view().state.doc.length, insert: ' lost text' } }))
    expect(view().state.doc.toString()).toBe('saved draft')
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveAttribute('contenteditable', 'false')
    await act(async () => resolveTags(['Backend']))
    await waitFor(() => expect(onDocumentAdopt).toHaveBeenCalledWith(authoritative))
    expect(notes.saveNote).toHaveBeenCalledTimes(1)
  })

  it('unlocks the unchanged Markdown after a tag transaction fails', async () => {
    const search = fakeSearchPort({ updateTags: vi.fn().mockRejectedValue(new Error('failed')) })
    const user = userEvent.setup()
    render(<EditorPane document={note('kept')} notes={fakeNotePort()} search={search} />)

    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')
    await screen.findByRole('alert')
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveAttribute('contenteditable', 'true'))
    act(() => view().dispatch({ changes: { from: 4, insert: ' draft' } }))
    expect(view().state.doc.toString()).toBe('kept draft')
  })

  it('settles a paste started before the tag barrier, flushes its reference, then updates tags', async () => {
    let resolveImage!: (value: { relativePath: string; width: number; height: number }) => void
    let resolveTags!: (tags: string[]) => void
    const image = new Promise<{ relativePath: string; width: number; height: number }>((resolve) => { resolveImage = resolve })
    const tagUpdate = new Promise<string[]>((resolve) => { resolveTags = resolve })
    const assets = { saveImage: vi.fn(() => image) }
    const saveNote = vi.fn(async (document) => ({ ...document, revision: 2 }))
    const reference = '![截图](assets/before-lock.png)'
    const authoritative = { ...note(`body${reference}`), tags: ['Backend'], revision: 3 }
    const notes = fakeNotePort({ saveNote, loadNote: vi.fn().mockResolvedValue(authoritative) })
    const search = fakeSearchPort({ updateTags: vi.fn(() => tagUpdate) })
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    render(<EditorPane document={note('body')} notes={notes} assets={assets} search={search} onDocumentAdopt={onDocumentAdopt} autosaveDelayMs={10_000} />)
    const source = view()
    source.dispatch({ selection: EditorSelection.cursor(source.state.doc.length) })
    fireEvent.paste(source.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())

    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')
    expect(search.updateTags).not.toHaveBeenCalled()
    await act(async () => resolveImage({ relativePath: 'assets/before-lock.png', width: 1, height: 1 }))
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: `body${reference}` })))
    await waitFor(() => expect(search.updateTags).toHaveBeenCalledWith(note().id, ['Backend']))
    await act(async () => resolveTags(['Backend']))
    await waitFor(() => expect(onDocumentAdopt).toHaveBeenCalledWith(authoritative))
  })

  it('does not deadlock when a pre-barrier image paste fails', async () => {
    let rejectImage!: (error: Error) => void
    const image = new Promise<{ relativePath: string; width: number; height: number }>((_resolve, reject) => { rejectImage = reject })
    const assets = { saveImage: vi.fn(() => image) }
    const search = fakeSearchPort({ updateTags: vi.fn().mockResolvedValue(['Backend']) })
    const user = userEvent.setup()
    render(<EditorPane document={note('kept')} notes={fakeNotePort()} assets={assets} search={search} onDocumentAdopt={vi.fn()} />)
    fireEvent.paste(view().contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())
    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')
    expect(search.updateTags).not.toHaveBeenCalled()

    await act(async () => rejectImage(new Error('disk')))
    await waitFor(() => expect(search.updateTags).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Markdown source' })).toHaveAttribute('contenteditable', 'true'))
    expect(view().state.doc.toString()).toBe('kept')
  })

  it('drains reverse-resolving pastes on the same selection without losing either reference', async () => {
    let resolveFirst!: (value: { relativePath: string; width: number; height: number }) => void
    let resolveSecond!: (value: { relativePath: string; width: number; height: number }) => void
    let resolveTags!: (tags: string[]) => void
    const assets = {
      saveImage: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })),
    }
    const tagUpdate = new Promise<string[]>((resolve) => { resolveTags = resolve })
    const expectedMarkdown = 'prefix ![截图](assets/first.png)![截图](assets/second.png) suffix'
    const authoritative = { ...note(expectedMarkdown), tags: ['Backend'], revision: 3 }
    const saveNote = vi.fn(async (document) => ({ ...document, revision: 2 }))
    const notes = fakeNotePort({ saveNote, loadNote: vi.fn().mockResolvedValue(authoritative) })
    const search = fakeSearchPort({ updateTags: vi.fn(() => tagUpdate) })
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    render(<EditorPane document={note('prefix SELECT suffix')} notes={notes} assets={assets} search={search} onDocumentAdopt={onDocumentAdopt} autosaveDelayMs={10_000} />)
    const source = view()
    source.dispatch({ selection: EditorSelection.range(7, 13) })
    fireEvent.paste(source.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    source.dispatch({ selection: EditorSelection.range(7, 13) })
    fireEvent.paste(source.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await waitFor(() => expect(assets.saveImage).toHaveBeenCalledTimes(2))
    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')

    await act(async () => resolveSecond({ relativePath: 'assets/second.png', width: 1, height: 1 }))
    expect(search.updateTags).not.toHaveBeenCalled()
    await act(async () => resolveFirst({ relativePath: 'assets/first.png', width: 1, height: 1 }))
    await waitFor(() => expect(saveNote).toHaveBeenCalledWith(expect.objectContaining({ markdown: expectedMarkdown })))
    await waitFor(() => expect(search.updateTags).toHaveBeenCalled())
    await act(async () => resolveTags(['Backend']))
    await waitFor(() => expect(onDocumentAdopt).toHaveBeenCalledWith(authoritative))
  })

  it('drains a failed overlapping range before a successful zero-width paste without deadlock', async () => {
    let rejectRange!: (error: Error) => void
    let resolveCursor!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRange = reject }))
        .mockImplementationOnce(() => new Promise((resolve) => { resolveCursor = resolve })),
    }
    const reference = '![截图](assets/cursor.png)'
    const authoritative = { ...note(`AB${reference}CDE`), tags: ['Backend'], revision: 2 }
    const search = fakeSearchPort({ updateTags: vi.fn().mockResolvedValue(['Backend']) })
    const onDocumentAdopt = vi.fn()
    const user = userEvent.setup()
    render(<EditorPane document={note('ABCDE')} notes={fakeNotePort({ loadNote: vi.fn().mockResolvedValue(authoritative) })} assets={assets} search={search} onDocumentAdopt={onDocumentAdopt} />)
    const source = view()
    source.dispatch({ selection: EditorSelection.range(1, 4) })
    fireEvent.paste(source.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    source.dispatch({ selection: EditorSelection.cursor(2) })
    fireEvent.paste(source.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await waitFor(() => expect(assets.saveImage).toHaveBeenCalledTimes(2))
    openMoreActions()
    await user.type(screen.getByRole('textbox', { name: '添加标签' }), 'Backend{Enter}')

    await act(async () => resolveCursor({ relativePath: 'assets/cursor.png', width: 1, height: 1 }))
    expect(search.updateTags).not.toHaveBeenCalled()
    await act(async () => rejectRange(new Error('disk')))
    await waitFor(() => expect(search.updateTags).toHaveBeenCalled())
    await waitFor(() => expect(onDocumentAdopt).toHaveBeenCalledWith(authoritative))
  })
})
