import { describe, expect, it } from 'vitest'
import { markdownToRichDocument } from './markdownConversion'

describe('Markdown document conversion', () => {
  it('converts supported headings, highlights, and UUID internal links', () => {
    const document = markdownToRichDocument('# 标题\n\n这是 ==重点==，参见 [[认证|019c0000-0000-7000-8000-000000000002]]。')
    expect(document.root.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(document.root.content?.[1].content).toContainEqual({ type: 'text', text: '重点', marks: [{ type: 'highlight', attrs: { color: 'yellow' } }] })
    expect(document.root.content?.[1].content).toContainEqual({
      type: 'internalLink',
      attrs: { noteId: '019c0000-0000-7000-8000-000000000002', label: '认证' },
    })
  })

  it('preserves unsupported source in a raw Markdown block', () => {
    const source = ':::custom\n不会丢失\n:::'
    expect(markdownToRichDocument(source)).toEqual({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'rawMarkdown', attrs: { source } }] },
    })
  })

  it('keeps fenced code literal instead of applying highlight shortcuts', () => {
    const document = markdownToRichDocument('```md\n==literal==\n```')
    expect(document.root.content?.[0]).toEqual({
      type: 'codeBlock', attrs: { language: 'md' }, content: [{ type: 'text', text: '==literal==' }],
    })
  })
})
