import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { richEditorExtensions } from './extensions'
import { pasteTsvAtSelection } from './tablePaste'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('pasteTsvAtSelection', () => {
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

  it('leaves an oversized TSV paste untouched instead of truncating values', () => {
    const editor = new Editor({
      extensions: richEditorExtensions(),
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    })
    editors.push(editor)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    const before = editor.getJSON()
    expect(pasteTsvAtSelection(editor, '一\t二\t三\n四\t五\t六')).toBe(false)
    expect(editor.getJSON()).toEqual(before)
  })
})
