import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorSelection } from '@codemirror/state'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { MarkdownSource, type MarkdownSourceHandle } from './MarkdownSource'
import { tableMarkdownFromModel } from './markdownActions'
import { fakeAssetPort, fakeLinkPort, noteId, pngBytes } from '../../test/fakes'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function editorView() {
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const view = EditorView.findFromDOM(textbox)
  if (view === null) throw new Error('CodeMirror view not found')
  return view
}

describe('MarkdownSource', () => {
  it('preserves a local draft when the parent rerenders with the same stale Markdown prop', () => {
    const onChange = vi.fn()
    const rendered = render(<MarkdownSource markdown="old" onChange={onChange} />)
    const view = editorView()

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: ' draft' } }))
    expect(view.state.doc.toString()).toBe('old draft')

    rendered.rerender(<MarkdownSource markdown="old" onChange={onChange} />)

    expect(editorView().state.doc.toString()).toBe('old draft')
  })

  it('renders inactive inline Markdown while preserving the exact source', () => {
    const source = 'Start **bold** *italic* ~~gone~~ `code` [site](https://example.com)'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const view = editorView()

    expect(view.contentDOM).toHaveTextContent('Start bold italic gone code site')
    expect(view.contentDOM).not.toHaveTextContent('**')
    expect(view.contentDOM).not.toHaveTextContent('~~')
    expect(view.contentDOM).not.toHaveTextContent('https://example.com')
    expect(view.contentDOM.querySelector('.cm-live-strong')).toHaveTextContent('bold')
    expect(view.contentDOM.querySelector('.cm-live-emphasis')).toHaveTextContent('italic')
    expect(view.contentDOM.querySelector('.cm-live-strikethrough')).toHaveTextContent('gone')
    expect(view.contentDOM.querySelector('.cm-live-inline-code')).toHaveTextContent('code')
    expect(view.contentDOM.querySelector('.cm-live-link')).toHaveTextContent('site')
    expect(view.state.doc.toString()).toBe(source)
  })

  it('renders document hierarchy while keeping the Markdown source unchanged', () => {
    render(<MarkdownSource markdown={'开场\n# 标题\n> 引用\n- [ ] 任务'} onChange={vi.fn()} />)
    const view = editorView()
    const lines = Array.from(view.contentDOM.querySelectorAll('.cm-line'))

    expect(lines[1]).toHaveClass('cm-document-heading', 'cm-document-heading-1')
    expect(lines[1]).toHaveTextContent('标题')
    expect(lines[1]).not.toHaveTextContent('# 标题')
    expect(lines[2]).toHaveClass('cm-document-quote')
    expect(lines[3]).toHaveClass('cm-document-task')
    expect(view.state.doc.toString()).toBe('开场\n# 标题\n> 引用\n- [ ] 任务')

    act(() => view.dispatch({ selection: EditorSelection.cursor(4) }))
    expect(view.contentDOM.querySelectorAll('.cm-line')[1]).toHaveTextContent('# 标题')
  })

  it('reveals only the active inline Markdown node', () => {
    render(<MarkdownSource markdown="A **bold** and ~~gone~~" onChange={vi.fn()} />)
    const view = editorView()

    act(() => view.dispatch({ selection: EditorSelection.cursor(5) }))

    expect(view.contentDOM).toHaveTextContent('A **bold** and gone')
    expect(view.contentDOM).not.toHaveTextContent('~~gone~~')
    expect(view.state.doc.toString()).toBe('A **bold** and ~~gone~~')
  })

  it('renders document blocks without leaking inactive Markdown markers', () => {
    const source = 'Intro\n- item\n\n2. second\n\n- [ ] task\n> quote\n\n---\n\n```ts\nconst x = 1\n```'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const view = editorView()

    for (const visible of ['Intro', 'item', 'second', 'task', 'quote', 'const x = 1']) {
      expect(view.contentDOM).toHaveTextContent(visible)
    }
    expect(view.contentDOM).not.toHaveTextContent('- item')
    expect(view.contentDOM).not.toHaveTextContent('[ ]')
    expect(view.contentDOM).not.toHaveTextContent('> quote')
    expect(view.contentDOM).not.toHaveTextContent('---')
    expect(view.contentDOM).not.toHaveTextContent('```ts')
    expect(screen.getByRole('checkbox', { name: '标记任务“task”为完成' })).not.toBeChecked()
    expect(Array.from(view.contentDOM.querySelectorAll('.cm-live-list-marker'), (node) => node.textContent)).toEqual(['•', '2.'])
    expect(view.contentDOM.querySelector('.cm-live-divider')).toBeInTheDocument()
    expect(view.state.doc.toString()).toBe(source)

    act(() => view.dispatch({ selection: EditorSelection.cursor(source.indexOf('const')) }))
    expect(view.contentDOM).toHaveTextContent('```ts')
  })

  it('toggles a rendered task through one undoable CodeMirror change', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown={'Intro\n- [ ] task'} onChange={onChange} links={fakeLinkPort()} />)
    const view = editorView()

    fireEvent.click(screen.getByRole('checkbox', { name: '标记任务“task”为完成' }))

    expect(view.state.doc.toString()).toBe('Intro\n- [x] task')
    expect(onChange).toHaveBeenLastCalledWith('Intro\n- [x] task')
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe('Intro\n- [ ] task')
  })

  it('keeps a task checkbox mounted and accurate when typing shifts its Markdown position', () => {
    render(<MarkdownSource markdown={'Intro\n- [ ] task'} onChange={vi.fn()} />)
    const view = editorView()
    const checkbox = screen.getByRole('checkbox', { name: '标记任务“task”为完成' })

    act(() => view.dispatch({
      changes: { from: 0, insert: '新' },
      selection: { anchor: 1 },
    }))

    expect(screen.getByRole('checkbox', { name: '标记任务“task”为完成' })).toBe(checkbox)
    fireEvent.click(checkbox)
    expect(view.state.doc.toString()).toBe('新Intro\n- [x] task')
  })

  it('renders an owned image without exposing its Markdown path', async () => {
    const relativePath = `assets/screenshot-${noteId}.png`
    const readImage = vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:live-image')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const source = `Intro\n![海岸](${relativePath})`

    const rendered = render(
      <MarkdownSource
        markdown={source}
        noteId={noteId}
        assetReader={{ readImage }}
        onChange={vi.fn()}
      />,
    )

    expect(await screen.findByRole('img', { name: '海岸' })).toHaveAttribute('src', 'blob:live-image')
    expect(editorView().contentDOM).not.toHaveTextContent(relativePath)
    expect(editorView().state.doc.toString()).toBe(source)
    expect(readImage).toHaveBeenCalledWith({ noteId, relativePath })

    rendered.unmount()
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:live-image'))
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  it('keeps a loaded image mounted when typing only shifts its Markdown position', async () => {
    const relativePath = `assets/screenshot-${noteId}.png`
    const readImage = vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stable-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    render(
      <MarkdownSource
        markdown={`Intro\n![海岸](${relativePath})`}
        noteId={noteId}
        assetReader={{ readImage }}
        onChange={vi.fn()}
      />,
    )
    const image = await screen.findByRole('img', { name: '海岸' })
    const view = editorView()

    act(() => view.dispatch({
      changes: { from: 0, insert: '新' },
      selection: { anchor: 1 },
    }))

    expect(screen.getByRole('img', { name: '海岸' })).toBe(image)
    expect(readImage).toHaveBeenCalledOnce()
  })

  it('selects an image atom before deleting it and keeps deletion undoable', async () => {
    const relativePath = `assets/screenshot-${noteId}.png`
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:delete-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const source = `Intro\n![海岸](${relativePath})`
    render(
      <MarkdownSource
        markdown={source}
        noteId={noteId}
        assetReader={{ readImage: vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes }) }}
        links={fakeLinkPort()}
        onChange={vi.fn()}
      />,
    )
    await screen.findByRole('img', { name: '海岸' })
    const view = editorView()
    const imageFrom = source.indexOf('![')

    act(() => view.dispatch({ selection: EditorSelection.cursor(imageFrom) }))
    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.selection.main.from).toBe(imageFrom)
    expect(view.state.selection.main.to).toBe(source.length)
    expect(view.state.doc.toString()).toBe(source)

    fireEvent.keyDown(view.contentDOM, { key: 'Delete' })
    expect(view.state.doc.toString()).toBe('Intro\n')
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe(source)
  })

  it('shows a stable missing-image placeholder without changing Markdown', async () => {
    const relativePath = `assets/screenshot-${noteId}.png`
    const source = `Intro\n![旧照片](${relativePath})`
    render(
      <MarkdownSource
        markdown={source}
        noteId={noteId}
        assetReader={{ readImage: vi.fn().mockRejectedValue(new Error('missing')) }}
        onChange={vi.fn()}
      />,
    )

    const fallback = await screen.findByRole('img', { name: '找不到图片：旧照片' })
    expect(fallback).toHaveTextContent('找不到图片 · 旧照片')
    expect(fallback).toHaveAttribute('tabindex', '0')
    expect(editorView().contentDOM).not.toHaveTextContent(relativePath)
    expect(editorView().state.doc.toString()).toBe(source)
  })

  it('falls back when loaded image bytes cannot be decoded', async () => {
    const relativePath = `assets/screenshot-${noteId}.png`
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:invalid-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    render(
      <MarkdownSource
        markdown={`Intro\n![损坏照片](${relativePath})`}
        noteId={noteId}
        assetReader={{ readImage: vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes }) }}
        onChange={vi.fn()}
      />,
    )

    const image = await screen.findByRole('img', { name: '损坏照片' })
    fireEvent.error(image)

    expect(screen.getByRole('img', { name: '找不到图片：损坏照片' })).toHaveTextContent('找不到图片 · 损坏照片')
  })

  it('renders and edits an existing GFM table inline through one source-range replacement', async () => {
    const source = 'Intro\n\n| Name | Note |\n| :--- | ---: |\n| A | B |\n\nAfter'
    const onChange = vi.fn()
    render(<MarkdownSource markdown={source} onChange={onChange} links={fakeLinkPort()} />)
    const view = editorView()

    expect(screen.getByRole('textbox', { name: '1 行 1 列' })).toHaveValue('Name')
    expect(screen.getByRole('textbox', { name: '2 行 2 列' })).toHaveValue('B')
    expect(view.contentDOM).not.toHaveTextContent('| :--- | ---: |')
    const cell = screen.getByRole('textbox', { name: '2 行 2 列' })
    fireEvent.change(cell, { target: { value: 'C' } })

    expect(view.state.doc.toString()).toBe('Intro\n\n| Name | Note |\n| :--- | ---: |\n| A | C |\n\nAfter')
    expect(onChange).toHaveBeenLastCalledWith('Intro\n\n| Name | Note |\n| :--- | ---: |\n| A | C |\n\nAfter')
    act(() => { undo(view) })
    expect(view.state.doc.toString()).toBe(source)
  })

  it('keeps a rendered table mounted and editable when typing shifts its Markdown position', () => {
    const source = 'Intro\n\n| Name | Note |\n| --- | --- |\n| A | B |\n\nAfter'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const view = editorView()
    const table = screen.getByRole('table', { name: 'Markdown 表格' })

    act(() => view.dispatch({
      changes: { from: 0, insert: 'New\n' },
      selection: { anchor: 4 },
    }))

    expect(screen.getByRole('table', { name: 'Markdown 表格' })).toBe(table)
    fireEvent.change(screen.getByRole('textbox', { name: '2 行 2 列' }), { target: { value: 'C' } })
    expect(view.state.doc.toString()).toBe('New\nIntro\n\n| Name | Note |\n| --- | --- |\n| A | C |\n\nAfter')
  })

  it('keeps table Markdown hidden when the editor selection lands inside the table source', () => {
    const source = '| Name | Note |\n| --- | --- |\n| A | B |\n<!-- cay-table: {"merges":[]} -->'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const view = editorView()

    act(() => view.dispatch({ selection: EditorSelection.cursor(source.indexOf('| A') + 2) }))

    expect(screen.getByRole('table', { name: 'Markdown 表格' })).toBeInTheDocument()
    expect(view.contentDOM).not.toHaveTextContent('| Name | Note |')
    expect(view.contentDOM).not.toHaveTextContent('<!-- cay-table:')
  })

  it('offers row, column, merge, and split controls inline without opening a dialog', () => {
    const source = '| Name | Note |\n| --- | --- |\n| A | B |'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    fireEvent.click(screen.getByRole('textbox', { name: '1 行 1 列' }))

    expect(screen.queryByRole('dialog', { name: '编辑表格' })).not.toBeInTheDocument()
    expect(table).toHaveAttribute('aria-label', 'Markdown 表格')
    expect(screen.getByRole('toolbar', { name: '表格工具' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '添加行' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加列' })).not.toBeInTheDocument()
    expect(table.querySelector('[aria-label="在左侧添加列"]')).toBeInTheDocument()
    expect(table.querySelector('[aria-label="在下方添加行"]')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '合并单元格' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '拆分单元格' })).toBeDisabled()
  })

  it('keeps the full editable cell value available in a hover preview', () => {
    const source = '| Name | Note |\n| --- | --- |\n| A very long value | B |'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: '2 行 1 列' })
    expect(input).toHaveAttribute('title', 'A very long value')

    fireEvent.input(input, { target: { value: 'An updated long value' } })

    expect(input).toHaveAttribute('title', 'An updated long value')
  })

  it('exposes the full read-only cell value in a hover preview', () => {
    const source = '| Name | Note |\n| --- | --- |\n| A very long value | B |'
    render(<MarkdownSource markdown={source} onChange={vi.fn()} readOnly />)
    const cell = screen.getByRole('cell', { name: 'A very long value' })

    expect(cell).toHaveAttribute('title', 'A very long value')
  })

  it('anchors the table toolbar to the active cell and flips below when needed', () => {
    const rendered = render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const wrapper = table.closest<HTMLElement>('.cm-live-table')
    const toolbar = rendered.container.querySelector<HTMLElement>('.cm-live-table-toolbar')
    const cell = table.querySelector<HTMLElement>('[data-row="2"][data-column="0"]')
    if (wrapper === null || toolbar === null || cell === null) throw new Error('table layout elements not found')

    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 400))
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 180, 40))
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(200, 120, 120, 40))
    fireEvent.click(screen.getByRole('textbox', { name: '3 行 1 列' }))

    expect(toolbar).toHaveStyle({ left: '70px', top: '68px' })
  })

  it('anchors a multi-cell toolbar to the first selected cell', () => {
    const rendered = render(<MarkdownSource markdown={'| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const wrapper = table.closest<HTMLElement>('.cm-live-table')
    const toolbar = rendered.container.querySelector<HTMLElement>('.cm-live-table-toolbar')
    const start = table.querySelector<HTMLElement>('[data-row="0"][data-column="0"]')
    const end = table.querySelector<HTMLElement>('[data-row="2"][data-column="2"]')
    if (wrapper === null || toolbar === null || start === null || end === null) throw new Error('table layout elements not found')

    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 600, 600))
    vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 180, 40))
    vi.spyOn(start, 'getBoundingClientRect').mockReturnValue(new DOMRect(150, 300, 100, 40))
    vi.spyOn(end, 'getBoundingClientRect').mockReturnValue(new DOMRect(500, 500, 100, 40))
    fireEvent.pointerDown(start, { button: 0 })
    fireEvent.pointerEnter(end)

    expect(toolbar).toHaveStyle({ left: '10px', top: '152px' })
  })

  it('updates a selected column alignment from the inline toolbar', () => {
    const source = '| Name | Note |\n| --- | --- |\n| A | B |'
    const onChange = vi.fn()
    render(<MarkdownSource markdown={source} onChange={onChange} />)
    fireEvent.click(screen.getByRole('textbox', { name: '1 行 2 列' }))
    fireEvent.click(screen.getByRole('button', { name: '居中对齐' }))

    expect(onChange).toHaveBeenLastCalledWith('| Name | Note |\n| --- | :---: |\n| A | B |')
  })

  it('renders and edits Cay merge metadata in the inline grid', () => {
    const source = tableMarkdownFromModel({
      cells: [['Name', 'Note'], ['A', 'B']],
      alignments: [null, null],
      merges: [{ row: 0, column: 0, rowSpan: 1, columnSpan: 2 }],
    })
    const onChange = vi.fn()
    render(<MarkdownSource markdown={source} onChange={onChange} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    expect(table.querySelector('th')).toHaveAttribute('colspan', '2')
    const header = screen.getByRole('textbox', { name: '1 行 1 列' })
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: '拆分单元格' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '拆分单元格' }))
    expect(onChange).toHaveBeenLastCalledWith('| Name | Note |\n| --- | --- |\n| A | B |')
  })

  it('merges a selected rectangle and writes the Cay metadata immediately', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={onChange} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const start = table.querySelector<HTMLElement>('[data-row="0"][data-column="0"]')
    const end = table.querySelector<HTMLElement>('[data-row="1"][data-column="1"]')
    if (start === null || end === null) throw new Error('table cells not found')
    fireEvent.pointerDown(start, { button: 0 })
    fireEvent.pointerEnter(end)
    fireEvent.pointerUp(end, { button: 0 })
    expect(screen.getByRole('button', { name: '合并单元格' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '合并单元格' }))

    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('<!-- cay-table:'))
    expect(screen.getByRole('table', { name: 'Markdown 表格' }).querySelector('th')).toHaveAttribute('rowspan', '2')
    expect(screen.getByRole('table', { name: 'Markdown 表格' }).querySelector('th')).toHaveAttribute('colspan', '2')
  })

  it('uses a floating table toolbar instead of a full-width table row', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    fireEvent.click(screen.getByRole('textbox', { name: '1 行 1 列' }))

    const toolbar = screen.getByRole('toolbar', { name: '表格工具' })
    expect(toolbar).toHaveClass('cm-live-table-toolbar--floating')
    expect(toolbar.parentElement).not.toBe(table.parentElement)
  })

  it('keeps the table toolbar hidden until a cell is selected', () => {
    const rendered = render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const toolbar = rendered.container.querySelector<HTMLElement>('.cm-live-table-toolbar')
    if (toolbar === null) throw new Error('table toolbar not found')

    expect(toolbar).not.toBeVisible()
  })

  it('selects a rectangle while dragging across cells', () => {
    render(<MarkdownSource markdown={'| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const start = table.querySelector<HTMLElement>('[data-row="0"][data-column="0"]')
    const end = table.querySelector<HTMLElement>('[data-row="1"][data-column="1"]')
    if (start === null || end === null) throw new Error('table cells not found')

    fireEvent.pointerDown(start, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerEnter(end, { clientX: 50, clientY: 50 })
    fireEvent.pointerUp(end, { button: 0, clientX: 50, clientY: 50 })

    expect(start).toHaveAttribute('aria-selected', 'true')
    expect(end).toHaveAttribute('aria-selected', 'true')
    expect(table.querySelector('[data-row="0"][data-column="1"]')).toHaveAttribute('aria-selected', 'true')
    expect(table.querySelector('[data-row="1"][data-column="0"]')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: '合并单元格' })).toBeEnabled()
  })

  it('updates the drag selection from captured pointer movement', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const start = table.querySelector<HTMLElement>('[data-row="0"][data-column="0"]')
    const end = table.querySelector<HTMLElement>('[data-row="1"][data-column="1"]')
    if (start === null || end === null) throw new Error('table cells not found')
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => end),
    })

    fireEvent.pointerDown(start, { button: 0, pointerId: 1 })
    fireEvent.pointerMove(table, { pointerId: 1, clientX: 50, clientY: 50 })
    fireEvent.pointerUp(table, { button: 0, pointerId: 1 })

    expect(start).toHaveAttribute('aria-selected', 'true')
    expect(end).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: '合并单元格' })).toBeEnabled()
  })

  it('does not use Shift-click as a second selection gesture', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    const first = screen.getByRole('textbox', { name: '1 行 1 列' })
    fireEvent.click(first)
    fireEvent.click(screen.getByRole('textbox', { name: '2 行 2 列' }), { shiftKey: true })

    expect(table.querySelector('[data-row="0"][data-column="0"]')).toHaveAttribute('aria-selected', 'false')
    expect(table.querySelector('[data-row="1"][data-column="1"]')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: '合并单元格' })).toBeDisabled()
  })

  it('moves row and column insertion into the active cell edges', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    fireEvent.click(screen.getByRole('textbox', { name: '2 行 1 列' }))

    expect(screen.queryByRole('button', { name: '添加行' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加列' })).not.toBeInTheDocument()
    expect(table.querySelector('[aria-label="在左侧添加列"]')).toBeInTheDocument()
    expect(table.querySelector('[aria-label="在右侧添加列"]')).toBeInTheDocument()
    expect(table.querySelector('[aria-label="在下方添加行"]')).toBeInTheDocument()
  })

  it('inserts a column or row from the active cell edge control', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={onChange} />)
    const table = screen.getByRole('table', { name: 'Markdown 表格' })
    fireEvent.click(screen.getByRole('textbox', { name: '2 行 1 列' }))
    fireEvent.click(table.querySelector('[aria-label="在右侧添加列"]') as HTMLElement)

    expect(onChange).toHaveBeenLastCalledWith('| A | 列 2 | B |\n| --- | --- | --- |\n| 1 |  | 2 |')
  })

  it('applies alignment to the cell editor itself', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('textbox', { name: '2 行 2 列' }))
    fireEvent.click(screen.getByRole('button', { name: '居中对齐' }))

    expect(screen.getByRole('textbox', { name: '2 行 2 列' })).toHaveStyle({ textAlign: 'center' })
  })

  it('hides the table toolbar when the editor selection leaves the table', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |\n\n正文'} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('textbox', { name: '1 行 1 列' }))
    const toolbar = screen.getByRole('toolbar', { name: '表格工具' })
    expect(toolbar).toBeVisible()

    fireEvent.pointerDown(editorView().contentDOM)

    expect(toolbar).not.toBeVisible()
  })

  it('also hides the table toolbar when a captured mouse event leaves the table', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |\n\n正文'} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('textbox', { name: '1 行 1 列' }))
    const toolbar = screen.getByRole('toolbar', { name: '表格工具' })
    fireEvent.mouseDown(document.body)

    expect(toolbar).not.toBeVisible()
  })

  it('reveals only the edge insertion control nearest the pointer', () => {
    render(<MarkdownSource markdown={'| A | B |\n| --- | --- |\n| 1 | 2 |'} onChange={vi.fn()} />)
    const cell = screen.getByRole('textbox', { name: '2 行 1 列' }).parentElement
    if (!(cell instanceof HTMLElement)) throw new Error('table cell not found')
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 100, 200, 60))
    const actions = cell.querySelector<HTMLElement>('.cm-live-table-cell-actions')
    if (actions === null) throw new Error('cell actions not found')

    fireEvent.pointerMove(cell, { clientX: 200, clientY: 130 })
    expect(actions).toHaveAttribute('data-edge', 'none')
    fireEvent.pointerMove(cell, { clientX: 296, clientY: 130 })
    expect(actions).toHaveAttribute('data-edge', 'right')
  })

  it.each([
    ['b', '**sea**', 2, 5],
    ['i', '*sea*', 1, 4],
    ['k', '[sea](https://)', 1, 4],
  ] as const)('applies Mod-%s through the same Markdown transaction path', (key, expected, from, to) => {
    render(<MarkdownSource markdown="sea" onChange={vi.fn()} />)
    const view = editorView()
    act(() => view.dispatch({ selection: EditorSelection.range(0, 3) }))

    fireEvent.keyDown(view.contentDOM, { key, ctrlKey: true })

    expect(view.state.doc.toString()).toBe(expected)
    expect(view.state.selection.main.from).toBe(from)
    expect(view.state.selection.main.to).toBe(to)
  })

  it('opens a rendered standard link only through a modified click', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    render(
      <MarkdownSource
        markdown="Go [site](https://example.com)"
        onChange={vi.fn()}
        external={{ openExternal }}
      />,
    )
    const link = editorView().contentDOM.querySelector('.cm-live-link')
    if (!(link instanceof HTMLElement)) throw new Error('Rendered standard link not found')

    fireEvent.click(link)
    expect(openExternal).not.toHaveBeenCalled()
    fireEvent.click(link, { ctrlKey: true })
    expect(openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('opens the existing insertion menu from the active-line block handle', () => {
    render(<MarkdownSource markdown="正文" onChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '添加内容块' }))

    expect(screen.getByRole('menu', { name: 'Markdown 快捷插入' })).toBeVisible()
    expect(screen.getByRole('menuitem', { name: '插入表格' })).toBeVisible()
  })

  it('formats the real CodeMirror selection from the inline toolbar', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown="潮汐来信" onChange={onChange} />)
    const view = editorView()
    vi.spyOn(view, 'coordsAtPos').mockReturnValue(new DOMRect(80, 120, 20, 20))
    act(() => view.dispatch({ selection: EditorSelection.range(0, 2) }))

    expect(screen.getByRole('toolbar', { name: '选区格式' })).toHaveStyle({ top: '112px' })
    fireEvent.click(screen.getByRole('button', { name: '加粗' }))

    expect(view.state.doc.toString()).toBe('**潮汐**来信')
    expect(view.state.selection.main.from).toBe(2)
    expect(view.state.selection.main.to).toBe(4)
    expect(onChange).toHaveBeenLastCalledWith('**潮汐**来信')
  })

  it('labels every inline formatting control with a hover tooltip', () => {
    render(<MarkdownSource markdown="潮汐来信" onChange={vi.fn()} />)
    const view = editorView()
    act(() => view.dispatch({ selection: EditorSelection.range(0, 2) }))

    for (const label of ['加粗', '斜体', '链接', '行内代码', '删除线']) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('title', label)
    }
  })
  it('publishes user transactions from the CodeMirror document', () => {
    const onChange = vi.fn()
    render(<MarkdownSource markdown="old" onChange={onChange} />)
    const view = editorView()

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'new text' } })

    expect(onChange).toHaveBeenLastCalledWith('new text')
  })

  it('does not force layout measurements for ordinary typing on the same line', () => {
    render(<MarkdownSource markdown="island" onChange={vi.fn()} />)
    const view = editorView()
    act(() => view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) }))
    const coordsAtPos = vi.spyOn(view, 'coordsAtPos').mockReturnValue(new DOMRect(80, 120, 20, 20))

    const insertionPoint = view.state.selection.main.head
    act(() => view.dispatch({
      changes: { from: insertionPoint, insert: ' breeze' },
      selection: { anchor: insertionPoint + ' breeze'.length },
    }))

    expect(coordsAtPos.mock.calls.length).toBeLessThanOrEqual(1)

    coordsAtPos.mockClear()
    const lineBreakPoint = view.state.selection.main.head
    act(() => view.dispatch({
      changes: { from: lineBreakPoint, insert: '\n' },
      selection: { anchor: lineBreakPoint + 1 },
    }))
    expect(coordsAtPos).toHaveBeenCalled()
  })

  it('keeps the table editor open when its controls are clicked', () => {
    render(<MarkdownSource markdown="text" onChange={vi.fn()} />)
    fireEvent.contextMenu(editorView().contentDOM, { clientX: 20, clientY: 20 })
    fireEvent.click(screen.getByRole('menuitem', { name: '插入表格' }))

    const rowCount = screen.getByRole('spinbutton', { name: '表格行数' })
    fireEvent.pointerDown(rowCount)
    fireEvent.change(rowCount, { target: { value: '4' } })

    expect(screen.getByRole('dialog', { name: '编辑表格' })).toBeTruthy()
    expect((rowCount as HTMLInputElement).value).toBe('4')
  })

  it('applies external documents without feedback loops', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownSource markdown="old" onChange={onChange} />)

    rerender(<MarkdownSource markdown="authoritative" onChange={onChange} />)

    expect(editorView().state.doc.toString()).toBe('authoritative')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps selection and scroll when controlled content is unchanged', () => {
    const onChange = vi.fn()
    const { rerender } = render(<MarkdownSource markdown="one\ntwo\nthree" onChange={onChange} />)
    const before = editorView()
    before.dispatch({ selection: EditorSelection.cursor(5) })
    before.scrollDOM.scrollTop = 37

    rerender(<MarkdownSource markdown="one\ntwo\nthree" onChange={onChange} />)

    const after = editorView()
    expect(after.state.selection.main.head).toBe(5)
    expect(after.scrollDOM.scrollTop).toBe(37)
  })

  it('reports source scrolling for split synchronization', () => {
    const onScroll = vi.fn()
    render(<MarkdownSource markdown="one\ntwo\nthree" onChange={vi.fn()} onScroll={onScroll} />)
    const view = editorView()
    view.scrollDOM.scrollTop = 24

    fireEvent.scroll(view.scrollDOM)

    expect(onScroll).toHaveBeenLastCalledWith(24)
  })

  it('replaces the exact selection with a pasted image and places the caret after it', async () => {
    const onChange = vi.fn()
    const assets = fakeAssetPort({ relativePath: 'assets/screenshot-019c.png', width: 2, height: 3 })
    render(<MarkdownSource markdown="before selected after" noteId={noteId} assets={assets} onChange={onChange} />)
    const view = editorView()
    view.dispatch({ selection: EditorSelection.range(7, 15) })

    fireEvent.paste(view.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe('before ![截图](assets/screenshot-019c.png) after'))
    expect(view.state.selection.main.head).toBe('before ![截图](assets/screenshot-019c.png)'.length)
    expect(onChange).toHaveBeenLastCalledWith('before ![截图](assets/screenshot-019c.png) after')
  })

  it('does not change the document when saving a pasted image fails', async () => {
    const onImageError = vi.fn()
    const assets = {
      saveImage: vi.fn(async () => {
        throw new Error('private path')
      }),
    }
    render(<MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={vi.fn()} onImageError={onImageError} />)

    fireEvent.paste(editorView().contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    await vi.waitFor(() => expect(onImageError).toHaveBeenCalledWith('无法保存截图。'))
    expect(editorView().state.doc.toString()).toBe('kept')
  })

  it('does not insert an image resolved after the editor switches notes', async () => {
    let finish!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn(
        () =>
          new Promise<{ relativePath: string; width: number; height: number }>((resolve) => {
            finish = resolve
          }),
      ),
    }
    const { rerender } = render(<MarkdownSource markdown="note A" noteId={noteId} assets={assets} onChange={vi.fn()} />)

    fireEvent.paste(editorView().contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })
    await vi.waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())
    const otherId = '019c0000-0000-7000-8000-000000000099' as typeof noteId
    rerender(<MarkdownSource markdown="note B" noteId={otherId} assets={assets} onChange={vi.fn()} />)
    finish({ relativePath: 'assets/orphan.png', width: 2, height: 3 })

    await vi.waitFor(() => expect(editorView().state.doc.toString()).toBe('note B'))
  })

  it('blocks CodeMirror transactions and image paste while read only, then resumes editing', () => {
    const onChange = vi.fn()
    const assets = fakeAssetPort({ relativePath: 'assets/blocked.png', width: 1, height: 1 })
    const { rerender } = render(
      <MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={onChange} readOnly />,
    )
    const view = editorView()

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'lost' } })
    fireEvent.paste(view.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })

    expect(view.state.doc.toString()).toBe('kept')
    expect(view.contentDOM).toHaveAttribute('contenteditable', 'false')
    expect(onChange).not.toHaveBeenCalled()
    expect(assets.saveImage).not.toHaveBeenCalled()

    rerender(
      <MarkdownSource markdown="kept" noteId={noteId} assets={assets} onChange={onChange} readOnly={false} />,
    )
    view.dispatch({ changes: { from: 4, insert: ' editing' } })
    expect(view.state.doc.toString()).toBe('kept editing')
  })

  it('waits for every pre-barrier image paste and inserts each mapped reference', async () => {
    let finishFirst!: (value: { relativePath: string; width: number; height: number }) => void
    let finishSecond!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
        .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve })),
    }
    const ref = createRef<MarkdownSourceHandle>()
    render(<MarkdownSource ref={ref} markdown="AB" noteId={noteId} assets={assets} onChange={vi.fn()} />)
    const view = editorView()
    view.dispatch({ selection: EditorSelection.cursor(1) })
    fireEvent.paste(view.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    view.dispatch({ selection: EditorSelection.cursor(0) })
    fireEvent.paste(view.contentDOM, { clipboardData: { files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }], getData: () => '' } })
    await vi.waitFor(() => expect(assets.saveImage).toHaveBeenCalledTimes(2))

    const barrier = ref.current!.beginEditBarrier()
    view.dispatch({ changes: { from: 0, insert: 'blocked' } })
    expect(view.state.doc.toString()).toBe('AB')
    await act(async () => finishSecond({ relativePath: 'assets/second.png', width: 1, height: 1 }))
    await act(async () => finishFirst({ relativePath: 'assets/first.png', width: 1, height: 1 }))
    await barrier

    expect(view.state.doc.toString()).toContain('![截图](assets/first.png)')
    expect(view.state.doc.toString()).toContain('![截图](assets/second.png)')
    ref.current!.endEditBarrier()
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' editable' } })
    expect(view.state.doc.toString()).toMatch(/ editable$/)
  })
})
