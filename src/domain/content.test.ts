import { describe, expect, it } from 'vitest'
import { contentFormat, contentText, emptyRichDocument, type NoteContent } from './content'

describe('typed note content', () => {
  it('keeps omitted content compatible with legacy Markdown', () => {
    expect(contentFormat({ markdown: '# 原文' })).toBe('markdown')
    expect(contentText({ markdown: '# 原文' })).toBe('# 原文')
  })
  it('extracts document text without leaking legacy or attribute data', () => {
    const content: NoteContent = { type: 'document', document: { schemaVersion: 1, root: {
      type: 'doc', content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: '标题' }] },
        { type: 'paragraph', content: [{ type: 'text', text: '正文' }] },
      ],
    } } }
    expect(contentFormat({ content })).toBe('document')
    expect(contentText({ content, markdown: 'stale' })).toBe('标题\n正文')
  })
  it('keeps literal text and initializes independent document snapshots', () => {
    expect(contentText({ content: { type: 'text', text: '# 原样' } })).toBe('# 原样')
    const first = emptyRichDocument()
    first.root.content?.push({ type: 'paragraph' })
    expect(emptyRichDocument().root.content).toHaveLength(1)
  })
})
