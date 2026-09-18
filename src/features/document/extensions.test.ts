import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, describe, expect, it } from 'vitest'
import { decreaseRichHeadingLevel, pasteTsvAtSelection, richEditorExtensions, setRichFontAttribute, splitBlockAfterSelectedHighlight, toggleYellowHighlight } from './extensions'

const editors: Editor[] = []
function createEditor(content?: object) {
  const editor = new Editor({ extensions: richEditorExtensions(), content: content ?? { type: 'doc', content: [{ type: 'paragraph' }] } })
  editors.push(editor)
  return editor
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('rich editor commands', () => {
  it('lowers a heading when its leading Markdown marker is deleted', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '章节' }] }],
    })
    editor.commands.setTextSelection(1)
    expect(editor.view.dom.querySelector('.rich-document__heading-marker')?.textContent).toBe('###')

    expect(decreaseRichHeadingLevel(editor)).toBe(true)
    expect(editor.view.dom.querySelector('.rich-document__heading-marker')?.textContent).toBe('##')
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })

    editor.commands.setTextSelection(1)
    expect(decreaseRichHeadingLevel(editor)).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })

    editor.commands.setTextSelection(1)
    expect(decreaseRichHeadingLevel(editor)).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'paragraph' })
  })
  it('lowers a heading when Backspace starts in the rendered heading content', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '章节' }] }],
    })
    editor.commands.setTextSelection(1)
    const heading = editor.view.dom.querySelector('.rich-document__heading-content')?.parentElement
    if (!(heading instanceof HTMLElement)) throw new Error('heading NodeView not found')
    const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    heading.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.getJSON().content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    expect(editor.view.dom.querySelector('.rich-document__heading-marker')?.textContent).toBe('##')
  })
  it('inserts a paragraph before a heading when Enter is pressed on its marker', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: '高效微调算法（PEFT）' }] }],
    })
    editor.commands.setTextSelection(1)
    const marker = editor.view.dom.querySelector('.rich-document__heading-marker')
    if (!(marker instanceof HTMLElement)) throw new Error('heading marker not found')
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    marker.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    const blocks = editor.getJSON().content ?? []
    expect(blocks[0]).toMatchObject({ type: 'paragraph' })
    expect(blocks[1]).toMatchObject({
      type: 'heading',
      attrs: { level: 4 },
      content: [{ type: 'text', text: '高效微调算法（PEFT）' }],
    })
  })
  it('uses the native marker caret when the editor selection is stale inside the title', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Self-Attention' }] }],
    })
    document.body.append(editor.view.dom)
    editor.commands.setTextSelection(5)
    const heading = editor.view.dom.querySelector('[data-rich-heading]')
    const marker = heading?.querySelector('.rich-document__heading-marker')
    const content = heading?.querySelector('.rich-document__heading-content')
    if (!(marker instanceof HTMLElement) || !(content instanceof HTMLElement) || !marker.firstChild) throw new Error('heading NodeView not found')
    const range = document.createRange()
    range.setStart(marker.firstChild, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    expect(window.getSelection()?.anchorNode).toBe(marker.firstChild)
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    content.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(editor.getJSON().content?.slice(0, 2)).toMatchObject([
      { type: 'paragraph' },
      { type: 'heading', attrs: { level: 4 }, content: [{ type: 'text', text: 'Self-Attention' }] },
    ])
    window.getSelection()?.removeAllRanges()
    editor.view.dom.remove()
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
