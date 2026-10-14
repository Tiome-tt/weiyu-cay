import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { richEditorExtensions } from './extensions'
import { pasteTsvAtSelection } from './tablePaste'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('pasteTsvAtSelection', () => {
  it('uses the top left of a reversed cell selection and splits intersected merges', () => {
    const editor = new Editor({ extensions: richEditorExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } })
    editors.push(editor)
    editor.commands.insertTable({ rows: 3, cols: 3, withHeaderRow: false })
    const cells: number[] = []
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'tableCell') cells.push(pos) })
    editor.commands.setCellSelection({ anchorCell: cells[4], headCell: cells[0] })
    expect(pasteTsvAtSelection(editor, 'x\ty\nz\tw')).toBe(true)
    expect(editor.state.doc.firstChild?.child(0).child(0).textContent).toBe('x')
    expect(editor.state.doc.firstChild?.child(1).child(1).textContent).toBe('w')
    editor.commands.mergeCells()
    expect(pasteTsvAtSelection(editor, 'a\tb\nc\td')).toBe(true)
    expect(editor.state.doc.firstChild?.child(0).childCount).toBe(3)
    expect(editor.state.doc.firstChild?.child(0).child(0).textContent).toBe('a')
    expect(editor.state.doc.firstChild?.child(1).child(1).textContent).toBe('d')
  })
  it('pastes a single column across rows inside a table', () => {
    const editor = new Editor({ extensions: richEditorExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } })
    editors.push(editor)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    expect(pasteTsvAtSelection(editor, 'one\ntwo')).toBe(true)
    expect(editor.state.doc.firstChild?.child(0).child(0).textContent).toBe('one')
    expect(editor.state.doc.firstChild?.child(1).child(0).textContent).toBe('two')
  })
  it('replaces a rectangular region in one transaction and one undo', () => {
    const editor = new Editor({
      extensions: richEditorExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    editors.push(editor)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })

    expect(pasteTsvAtSelection(editor, '甲\t乙\n丙\t丁')).toBe(true)
    expect(editor.getText()).toContain('甲')
    expect(editor.getText()).toContain('丁')
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).not.toContain('甲')
  })

  it('creates a table when TSV is pasted outside a table', () => {
    const editor = new Editor({
      extensions: richEditorExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    editors.push(editor)
    expect(pasteTsvAtSelection(editor, 'A\tB')).toBe(true)
    expect(editor.getJSON().content?.some((node) => node.type === 'table')).toBe(true)
  })

  it('expands an overflowing TSV paste without truncating values and supports undo', () => {
    const editor = new Editor({
      extensions: richEditorExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    editors.push(editor)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    const before = editor.getJSON()
    expect(pasteTsvAtSelection(editor, '一\t二\t三\n四\t五\t六')).toBe(true)
    expect(editor.getText()).toContain('三')
    expect(editor.getText()).toContain('六')
    expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(3)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getJSON()).toEqual(before)
  })
})
