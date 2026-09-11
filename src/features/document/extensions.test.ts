import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { pasteTsvAtSelection, richEditorExtensions } from './extensions'

const editors: Editor[] = []
function createEditor(content?: object) {
  const editor = new Editor({ extensions: richEditorExtensions(), content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] } })
  editors.push(editor)
  return editor
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('rich editor commands', () => {
  it('keeps one undo step for one table insertion', () => {
    const editor = createEditor()
    expect(editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })).toBe(true)
    expect(editor.getJSON().content?.some((node) => node.type === 'table')).toBe(true)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON().content?.some((node) => node.type === 'table')).toBe(false)
  })

  it('merges a rectangular cell selection and can split it again', () => {
    const editor = createEditor()
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    const cellPositions: number[] = []
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'tableCell') cellPositions.push(position)
    })
    expect(editor.commands.setCellSelection({ anchorCell: cellPositions[0], headCell: cellPositions[1] })).toBe(true)
    expect(editor.commands.mergeCells()).toBe(true)
    expect((editor.getJSON() as JSONContent).content?.[0].content?.[0].content?.[0].attrs?.colspan).toBe(2)
    expect(editor.commands.splitCell()).toBe(true)
    expect((editor.getJSON() as JSONContent).content?.[0].content?.[0].content).toHaveLength(2)
  })

  it('replaces cells from TSV without inserting a nested or second table', () => {
    const editor = createEditor()
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    expect(pasteTsvAtSelection(editor, '甲\t乙\n丙\t丁')).toBe(true)
    const json = editor.getJSON()
    expect(JSON.stringify(json).match(/\"type\":\"table\"/g)).toHaveLength(1)
    expect(editor.getText()).toContain('甲')
    expect(editor.getText()).toContain('丁')
  })

  it('preserves internal-link and attachment UUID attributes through HTML paste parsing', () => {
    const editor = createEditor({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'internalLink', attrs: { noteId: '019c0000-0000-7000-8000-000000000002', label: '认证' } }] },
        { type: 'attachment', attrs: { entryId: '019c0000-0000-7000-8000-000000000003', label: '设计稿' } },
      ],
    })
    const html = editor.getHTML()
    editor.commands.clearContent()
    editor.commands.setContent(html)
    expect((editor.getJSON() as JSONContent).content?.[0].content?.[0].attrs).toMatchObject({ noteId: '019c0000-0000-7000-8000-000000000002', label: '认证' })
    expect((editor.getJSON() as JSONContent).content?.[1].attrs).toMatchObject({ entryId: '019c0000-0000-7000-8000-000000000003', label: '设计稿' })
  })
})
