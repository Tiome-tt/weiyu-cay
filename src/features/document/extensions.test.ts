import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { pasteTsvAtSelection, richEditorExtensions, setRichFontAttribute, splitBlockAfterSelectedHighlight, toggleYellowHighlight } from './extensions'

const editors: Editor[] = []
function createEditor(content?: object) {
  const editor = new Editor({ extensions: richEditorExtensions(), content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] } })
  editors.push(editor)
  return editor
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('rich editor commands', () => {
  it('formats instantly while preserving selectable marker text and tracks deletions',()=>{
    const editor=createEditor()
    const type=(text:string)=>{
      const handled=editor.view.someProp('handleTextInput', fn=>fn(editor.view,editor.state.selection.from,editor.state.selection.to,text,()=>editor.state.tr.insertText(text)))
      if(!handled)editor.commands.insertContent(text)
    }
    type('#');type('#');type(' ');type('章节')
    expect(editor.getJSON().content?.[0]).toMatchObject({type:'heading',attrs:{level:2},content:[{text:'## 章节'}]})
    editor.commands.setTextSelection({from:1,to:4})
    editor.commands.deleteSelection()
    expect(editor.getJSON().content?.[0]).toMatchObject({type:'paragraph',content:[{text:'章节'}]})
    expect(editor.commands.undo()).toBe(true)

  })
  it('returns a heading to a paragraph on Backspace without deleting its text',()=>{
    const editor=createEditor({type:'doc',content:[{type:'heading',attrs:{level:3,sourceMarker:true},content:[{type:'text',text:'### 章节'}]}]})
    editor.commands.setTextSelection(1)
    editor.view.dispatchEvent(new KeyboardEvent('keydown',{key:'Backspace',bubbles:true,cancelable:true}))
    expect(editor.getJSON().content?.[0]).toMatchObject({type:'paragraph',content:[{text:'章节'}]})
  })
  it('does not carry a selection highlight into the next paragraph', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一行' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 4 })
    expect(toggleYellowHighlight(editor)).toBe(true)
    editor.commands.setTextSelection(4)
    expect(splitBlockAfterSelectedHighlight(editor)).toBe(true)
    editor.commands.insertContent('下一行')

    const paragraphs = editor.getJSON().content ?? []
    expect(JSON.stringify(paragraphs[0])).toContain("highlight")
    expect(paragraphs[1]).toMatchObject({ type: 'paragraph', content: [{ type: 'text', text: '下一行' }] })
    expect(JSON.stringify(paragraphs[1])).not.toContain('"highlight"')
  })

  it('persists rich font attributes and supports paragraph justification', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '知识库内容' }] }],
    })
    editor.commands.setTextSelection({ from: 1, to: 5 })
    expect(setRichFontAttribute(editor, 'family', 'sans')).toBe(true)
    expect(setRichFontAttribute(editor, 'size', 'large')).toBe(true)
    expect(editor.commands.setTextAlign('justify')).toBe(true)
    const json = editor.getJSON()
    expect(json.content?.[0]).toMatchObject({ attrs: { textAlign: 'justify' } })
    expect(json.content?.[0].content?.[0].marks).toEqual([{ type: 'font', attrs: { family: 'sans', size: 'large' } }])
    expect(editor.getHTML()).toContain('data-rich-font')
  })
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
