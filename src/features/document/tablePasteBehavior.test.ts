import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { richEditorExtensions } from './extensions'
import { pasteTsvAtSelection } from './tablePaste'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('table cell TSV replacement', () => {
  it('updates the selected rectangle without nesting a table and undoes as one action', () => {
    const editor = new Editor({ extensions: richEditorExtensions(), content: { type: 'doc', content: [{ type: 'paragraph' }] } })
    editors.push(editor)
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
    expect(pasteTsvAtSelection(editor, '甲\t乙\n丙\t丁')).toBe(true)
    expect(editor.getText()).toContain('甲')
    expect(editor.getText()).toContain('丁')
    expect(JSON.stringify(editor.getJSON()).match(/\"type\":\"table\"/g)).toHaveLength(1)
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getText()).not.toContain('甲')
  })
})
