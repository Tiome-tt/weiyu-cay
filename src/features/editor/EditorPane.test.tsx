import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Profiler } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import { fakeAssetPort, fakeLinkPort, fakeNotePort, fakeSearchPort, folders, note, pngBytes } from '../../test/fakes'
import { EditorPane } from './EditorPane'
import * as markdownPipeline from './markdownPipeline'

afterEach(cleanup)

const labels = ['文档编辑', '分栏校对', '阅读视图']

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
  it.each(['右键菜单', '加号'] as const)('opens the same internal-link picker from the %s', async (entry) => {
    const current = { ...note('正文'), title: '当前笔记' }
    const target = {
      ...note(''),
      id: '019c0000-0000-7000-8000-000000000141' as NoteId,
      title: '潮汐计划',
      excerpt: '',
    }
    const links = fakeLinkPort({
      listTargets: vi.fn().mockResolvedValue([
        { ...current, excerpt: '正文' },
        target,
      ]),
    })
    const user = userEvent.setup()
    render(<EditorPane document={current} notes={fakeNotePort()} links={links} folders={folders()} />)
    act(() => view().dispatch({ selection: EditorSelection.cursor(view().state.doc.length) }))

    if (entry === '右键菜单') fireEvent.contextMenu(view().contentDOM, { clientX: 80, clientY: 120 })
    else await user.click(screen.getByRole('button', { name: '添加内容块' }))
    await user.click(screen.getByRole('menuitem', { name: '插入内部链接' }))

    const dialog = await screen.findByRole('dialog', { name: '插入内部链接' })
    expect(within(dialog).queryByRole('treeitem', { name: '选择链接：当前笔记' })).not.toBeInTheDocument()
    await user.type(within(dialog).getByRole('searchbox', { name: '筛选笔记' }), '潮汐')
    await user.click(within(dialog).getByRole('treeitem', { name: '选择链接：潮汐计划' }))
    await user.click(within(dialog).getByRole('button', { name: '插入链接' }))

    expect(view().state.doc.toString()).toBe('正文[[潮汐计划|' + target.id + ']]')
    expect(screen.queryByRole('dialog', { name: '插入内部链接' })).not.toBeInTheDocument()
  })

  it('shows document tags beside the last-edited metadata and omits an empty tag list', () => {
    const rendered = render(
      <EditorPane document={{ ...note(''), tags: ['项目', '待确认'] }} notes={fakeNotePort()} />,
    )
    const tags = screen.getByRole('list', { name: '笔记标签' })
    expect(tags).toHaveTextContent('项目')
    expect(tags).toHaveTextContent('待确认')
    expect(tags.parentElement).toHaveTextContent('最后编辑于')

    rendered.rerender(<EditorPane document={{ ...note(''), tags: [] }} notes={fakeNotePort()} />)
    expect(screen.queryByRole('list', { name: '笔记标签' })).not.toBeInTheDocument()
  })

  it('offers only real folders as move destinations for legacy unfiled notes', async () => {
    const onMoveNote = vi.fn().mockResolvedValue({ ...note(''), folderId: folders()[0].id })
    render(<EditorPane document={{ ...note(''), folderId: null }} notes={fakeNotePort()} folders={folders()} onMoveNote={onMoveNote} />)
    openMoreActions()
    const select = screen.getByRole('combobox', { name: '笔记文件夹' })
    expect(within(select).queryByRole('option', { name: '未归档笔记' })).not.toBeInTheDocument()
    expect(select.querySelector('option[value=""]')).toBeDisabled()
    expect(select).toHaveValue('')
    fireEvent.change(select, { target: { value: folders()[0].id } })
    await waitFor(() => expect(onMoveNote).toHaveBeenCalledWith(folders()[0].id))
  })

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
    await user.click(await screen.findByRole('treeitem', { name: '选择链接：A|B[1]' }))
    await user.click(screen.getByRole('menuitem', { name: '插入内部链接' }))
    expect(view().state.doc.toString()).toBe(`[[A\\|B\\[1\\]|${first.id}]]`)

    openMoreActions()
    await user.click(screen.getByRole('treeitem', { name: '选择链接：Second' }))
    await user.click(screen.getByRole('menuitem', { name: '重定向内部链接' }))
    expect(view().state.doc.toString()).toBe(`[[Second|${second.id}]]`)
    expect(screen.getByRole('link', { name: '[[Second]]' })).toBeVisible()
  })

  it('starts in the configured default editor view', () => {
    render(<EditorPane document={note('# Preview')} notes={fakeNotePort()} initialMode="preview" autosaveDelayMs={10_000} />)
    expect(screen.getByRole('button', { name: labels[2] })).toHaveAttribute('aria-pressed', 'true')
  })

  it('adopts a newly loaded default view instead of retaining the previous mode', () => {
    const { rerender } = render(
      <EditorPane document={note('# One')} notes={fakeNotePort()} initialMode="preview" autosaveDelayMs={10_000} />,
    )
    expect(screen.getByRole('button', { name: labels[2] })).toHaveAttribute('aria-pressed', 'true')

    rerender(<EditorPane document={note('# One')} notes={fakeNotePort()} initialMode="source" autosaveDelayMs={10_000} />)

    expect(screen.getByRole('button', { name: labels[0] })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('textbox', { name: 'Markdown source' })).toBeVisible()
  })

  it('shows complete Markdown source in split mode', () => {
    const markdown = 'Start **bold** and [site](https://example.com)'
    render(<EditorPane document={note(markdown)} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} />)

    expect(view().contentDOM).toHaveTextContent(markdown)
    expect(view().state.doc.toString()).toBe(markdown)
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

  it('places breadcrumbs in the quiet toolbar and the large title in the document', () => {
    render(<EditorPane document={{ ...note('# Goal'), title: 'Goal' }} notes={fakeNotePort()} folders={folders()} assets={fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 })} />)

    const toolbar = screen.getByRole('toolbar', { name: '编辑器视图' })
    expect(within(toolbar).getByLabelText('当前位置')).toHaveTextContent('项目 B/Goal')
    expect(within(toolbar).queryByRole('heading', { name: 'Goal' })).not.toBeInTheDocument()
    const title = screen.getByRole('heading', { name: 'Goal', level: 1 })
    expect(title.closest('.editor-document-heading')).not.toBeNull()
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

  it('separates the note title from the body with a localized last-edited timestamp', () => {
    render(
      <EditorPane
        document={{ ...note('正文第一段'), title: '岛屿周末计划', updatedAt: '2026-08-24T08:10:00Z' }}
        notes={fakeNotePort()}
      />,
    )

    const heading = screen.getByRole('heading', { name: '岛屿周末计划', level: 1 })
    const header = heading.closest('.editor-document-heading')
    expect(header).not.toBeNull()
    expect(header).toHaveTextContent('最后编辑于')
    expect(header?.querySelector('time')).toHaveAttribute('dateTime', '2026-08-24T08:10:00Z')
    expect(header?.nextElementSibling).toHaveClass('editor-document__body')
  })

  it('localizes the legacy temporary capture title in the document preview', () => {
    const temporary = { ...note('临时内容'), kind: 'temporary' as const, title: 'Temporary capture', folderId: null }
    render(<EditorPane document={temporary} notes={fakeNotePort()} initialMode="preview" />)

    expect(screen.getByRole('heading', { name: '临时便笺', level: 1 })).toBeVisible()
    expect(screen.getByLabelText('当前位置')).toHaveTextContent('未归档/临时便笺')
    expect(screen.queryByText('Temporary capture')).not.toBeInTheDocument()
  })

  it('keeps an editable document title named cleanly as a heading', () => {
    render(
      <EditorPane
        document={{ ...note('# Goal'), title: 'Goal' }}
        notes={fakeNotePort()}
        onRenameNote={vi.fn()}
      />,
    )

    const heading = screen.getByRole('heading', { name: 'Goal', level: 1 })
    expect(within(heading).getByRole('textbox', { name: '笔记标题' })).toHaveValue('Goal')
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
    const folderTarget = within(menu).getByRole('combobox', { name: '笔记文件夹' })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(folderTarget).toHaveFocus()
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
    expect(within(primary).getByRole('button', { name: labels[0] })).toHaveFocus()
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
    const preview = screen.getByRole('article')
    expect(preview).toHaveTextContent('Goal')
    expect(preview.querySelector(':scope > .markdown-preview__page')).not.toBeNull()
    expect(screen.getByRole('button', { name: labels[2] })).toHaveAttribute('aria-pressed', 'true')
  })

  it('updates split preview after a coalesced refresh from the single source state', () => {
    vi.useFakeTimers()
    try {
      render(<EditorPane document={note('# Old')} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} />)
      const editor = view()
      act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '## New' } }))
      act(() => vi.advanceTimersByTime(250))

      expect(screen.getByRole('article')).toHaveTextContent('New')
      expect(screen.getByRole('article')).not.toHaveTextContent('Old')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows internal-link targets in a folder tree while keeping folders non-selectable', async () => {
    const root = folders()[0]
    const child = {
      id: '019c0000-0000-7000-8000-000000000091' as import('../../domain/model').FolderId,
      parentId: root.id,
      name: '子目录',
      sortOrder: 0,
    }
    const target = {
      ...note(''),
      id: '019c0000-0000-7000-8000-000000000092' as NoteId,
      title: '子目录笔记',
      folderId: child.id,
      excerpt: '',
    }
    const links = fakeLinkPort({ listTargets: vi.fn().mockResolvedValue([target]) })
    render(
      <EditorPane
        document={note('')}
        notes={fakeNotePort()}
        links={links}
        folders={[root, child]}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: '笔记更多操作' }))
    const tree = await screen.findByRole('tree', { name: '内部链接目标' })
    expect(within(tree).getByText(root.name)).toBeVisible()
    expect(within(tree).getByText(child.name)).toBeVisible()
    expect(within(tree).getByRole('treeitem', { name: '选择链接：子目录笔记' })).toBeVisible()
    expect(within(tree).queryByRole('button', { name: root.name })).not.toBeInTheDocument()
    expect(within(tree).queryByRole('button', { name: child.name })).not.toBeInTheDocument()
  })

  it('coalesces split preview refreshes while typing', () => {
    vi.useFakeTimers()
    try {
      render(<EditorPane document={note('# Old')} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} />)
      const editor = view()

      act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '# New' } }))

      expect(screen.getByRole('article')).toHaveTextContent('Old')
      expect(screen.getByRole('article')).not.toHaveTextContent('New')

      act(() => vi.advanceTimersByTime(250))

      expect(screen.getByRole('article')).toHaveTextContent('New')
      expect(screen.getByRole('article')).not.toHaveTextContent('Old')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the split preview quiet during steady character input', () => {
    vi.useFakeTimers()
    const renderPreview = vi.spyOn(markdownPipeline, 'renderPreviewMarkdown')
    try {
      render(<EditorPane document={note('# Old\n\nlong body')} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} />)
      const editor = view()
      const initialRenderCount = renderPreview.mock.calls.length

      for (const character of 'steady typing') {
        act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: character } }))
        act(() => vi.advanceTimersByTime(100))
      }

      expect(renderPreview.mock.calls.length).toBe(initialRenderCount)
    } finally {
      renderPreview.mockRestore()
      vi.useRealTimers()
    }
  })

  it('coalesces outline draft notifications while typing', () => {
    vi.useFakeTimers()
    try {
      const onDraftChange = vi.fn()
      render(<EditorPane document={note('# Old')} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} onDraftChange={onDraftChange} />)
      const editor = view()

      for (const character of 'steady typing') {
        act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: character } }))
      }

      expect(onDraftChange).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(250))
      expect(onDraftChange).toHaveBeenCalledOnce()
      expect(onDraftChange).toHaveBeenLastCalledWith('# Oldsteady typing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not commit the editor pane once per split-view character', () => {
    vi.useFakeTimers()
    try {
      const commits: number[] = []
      render(
        <Profiler id="editor" onRender={() => commits.push(1)}>
          <EditorPane document={note('')} notes={fakeNotePort()} initialMode="split" autosaveDelayMs={10_000} />
        </Profiler>,
      )
      const beforeTyping = commits.length
      const editor = view()

      for (const character of 'abcdef') {
        act(() => editor.dispatch({ changes: { from: editor.state.doc.length, insert: character } }))
      }

      expect(commits.length - beforeTyping).toBeLessThan(6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('defers hidden preview rendering while typing and refreshes it when preview becomes visible', async () => {
    const user = userEvent.setup()
    const { container } = render(<EditorPane document={note('# Old')} notes={fakeNotePort()} autosaveDelayMs={10_000} />)
    const editor = view()

    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '# New' } }))

    expect(container.querySelector('.editor-document__preview')).toHaveTextContent('Old')
    expect(container.querySelector('.editor-document__preview')).not.toHaveTextContent('New')

    await user.click(screen.getByRole('button', { name: labels[1] }))
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
