import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import { afterEach, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { MarkdownSource, type MarkdownSourceHandle } from '../../../src/features/editor/MarkdownSource'
import { parseMarkdownTable, tableMarkdownFromModel, tableWithCell } from '../../../src/features/editor/markdownActions'
import { renderMarkdown } from '../../../src/features/editor/markdownPipeline'
import { richEditorExtensions } from '../../../src/features/document/extensions'
import { pasteTsvAtSelection } from '../../../src/features/document/tablePaste'
import { markdownToRichDocument } from '../../../src/features/document/markdownConversion'

const editors: Editor[] = []
afterEach(() => { cleanup(); editors.splice(0).forEach(editor => editor.destroy()) })
const source = '| A | B |\n| --- | --- |\n| 1 | 2 |'
it('AUDIT: Markdown table conversion preserves structure or verbatim unsupported source', () => {
  const rich = markdownToRichDocument(source)
  const hasTable = rich.root.content?.some(node => node.type === 'table')
  const hasVerbatim = rich.root.content?.some(node => node.type === 'rawMarkdown' && node.attrs?.source === source)
  expect(hasTable || hasVerbatim).toBe(true)
})
it('AUDIT: active Markdown cell text reaches the save barrier', async () => {
  const onChange = vi.fn(), ref = createRef<MarkdownSourceHandle>()
  render(<MarkdownSource ref={ref} markdown={source} onChange={onChange} />)
  const input = screen.getByRole('textbox', { name: '2 行 1 列' })
  input.focus()
  fireEvent.input(input, { target: { value: 'unsaved draft' } })
  await act(async () => { await ref.current!.beginEditBarrier() })
  expect(onChange).toHaveBeenCalledWith(source.replace('| 1 |', '| unsaved draft |'))
})
it('AUDIT: TSV paste into a real rich CellSelection stays in the existing table', () => {
  const editor = new Editor({ extensions: richEditorExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } })
  editors.push(editor)
  editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
  const cells: number[] = []
  editor.state.doc.descendants((node, pos) => { if (node.type.name === 'tableCell') cells.push(pos) })
  editor.commands.setCellSelection({ anchorCell: cells[0], headCell: cells[3] })
  expect(pasteTsvAtSelection(editor, 'x\ty\nz\tw')).toBe(true)
  expect(JSON.stringify(editor.getJSON()).match(/"type":"table"/g)).toHaveLength(1)
})
it('AUDIT: rowspan does not shift TSV to a different column', () => {
  const cell = (text: string, rowspan = 1) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const editor = new Editor({ extensions: richEditorExtensions(), content: { type: 'doc', content: [{ type: 'table', content: [
    { type: 'tableRow', content: [cell('A0', 2), cell('B0'), cell('C0')] },
    { type: 'tableRow', content: [cell('B1'), cell('C1')] },
    { type: 'tableRow', content: [cell('A2'), cell('B2'), cell('C2')] },
  ] }] } })
  editors.push(editor)
  let selected = 0
  editor.state.doc.descendants((node, pos) => { if (node.type.name === 'tableCell' && node.textContent === 'B1') selected = pos + 2 })
  editor.commands.setTextSelection(selected)
  expect(pasteTsvAtSelection(editor, 'x\ty\nz\tw')).toBe(true)
  const bottom = editor.state.doc.firstChild!.lastChild!
  const values: string[] = []
  bottom.forEach(node => values.push(node.textContent))
  expect(values).toEqual(['A2', 'z', 'w'])
})
it('AUDIT: editing another cell preserves escaped Markdown semantics', () => {
  const original = '| A | B |\n| --- | --- |\n| \\*literal\\* | old |'
  const edited = tableMarkdownFromModel(tableWithCell(parseMarkdownTable(original)!, 1, 1, 'new'))
  const root = document.createElement('div')
  root.innerHTML = renderMarkdown(original)
  const before = root.querySelector('td')!.innerHTML
  root.innerHTML = renderMarkdown(edited)
  expect(root.querySelector('td')!.innerHTML).toBe(before)
})
it('AUDIT: Excel quoted multiline TSV does not create an extra Markdown row', () => {
  const onChange = vi.fn()
  render(<MarkdownSource markdown={source} onChange={onChange} />)
  fireEvent.paste(screen.getByRole('textbox', { name: '2 行 1 列' }), { clipboardData: { getData: () => '"alpha\nbeta"\tX' } })
  const saved = onChange.mock.lastCall![0] as string
  expect(parseMarkdownTable(saved)!.cells).toHaveLength(2)
})
it('AUDIT: multi-row delete removes every selected row', () => {
  const onChange = vi.fn()
  render(<MarkdownSource markdown={source + '\n| 3 | 4 |\n| 5 | 6 |'} onChange={onChange} />)
  fireEvent.pointerDown(screen.getByRole('textbox', { name: '2 行 1 列' }), { button: 0 })
  fireEvent.pointerEnter(screen.getByRole('textbox', { name: '3 行 2 列' }).closest('td')!)
  fireEvent.pointerUp(document.body)
  fireEvent.click(screen.getByRole('button', { name: '删除行' }))
  const saved = onChange.mock.lastCall![0] as string
  expect(parseMarkdownTable(saved)!.cells).toEqual([['A', 'B'], ['5', '6']])
})
