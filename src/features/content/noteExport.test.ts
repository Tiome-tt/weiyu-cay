import { describe, expect, it } from 'vitest'
import { note } from '../../test/fakes'
import { noteExportOptions, noteMarkdown, notePlainText, buildNoteHtml } from './noteExport'

describe('portable note exports', () => {
  it('keeps paragraphs, code indentation and tabular columns in TXT exports', () => {
    const result = notePlainText(note('# 标题\n\n段落\n\n```java\n  value();\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |'))
    expect(result).toContain('标题\n\n段落')
    expect(result).toContain('  value();')
    expect(result).toContain('A\tB\n1\t2')
    expect(notePlainText(note('```\n  indented();\n```'))).toMatch(/^  indented/)
  })
  it('offers five formats for authored notes and original files for attachments', () => {
    expect(noteExportOptions(note('')).map(option => option.kind)).toEqual(['markdown', 'text', 'html', 'word', 'pdf'])
    expect(noteExportOptions({ ...note(''), content: { type: 'text', text: '正文' } })).toHaveLength(5)
    expect(noteExportOptions({ ...note(''), content: { type: 'file', file: { storageName: 'p', originalName: 'x.xlsx', mediaType: 'office', size: 1, sha256: '' } } }).map(option => option.kind)).toEqual(['original','text','html','pdf'])
  })
  it('preserves formatted text, code fences, images and table cells in rich Markdown export', () => {
    const markdown = noteMarkdown({ ...note(''), content: { type: 'document', document: { schemaVersion: 1, root: { type: 'doc', content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '标题' }] },
      { type: 'paragraph', content: [{ type: 'text', text: '重点', marks: [{ type: 'bold' }] }] },
      { type: 'codeBlock', attrs: { language: 'java' }, content: [{ type: 'text', text: '```\npublic class Demo {}' }] },
      { type: 'image', attrs: { src: 'assets/a.png', alt: '图片' } },
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] }] }, { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B|C' }] }] }] }] },
    ] } } } })
    expect(markdown).toContain('## 标题')
    expect(markdown).toContain('**重点**')
    expect(markdown).toContain('````java\n```\npublic class Demo {}\n````')
    expect(markdown).toContain('![图片](assets/a.png)')
    expect(markdown).toContain('B\\|C')
    expect(noteMarkdown({ ...note(''), content: { type: 'document', document: { schemaVersion: 1, root: { type: 'doc', content: [] } } } })).toBe('')
  })
  it('exports standalone HTML with escaped title and embedded managed images', async () => {
    const source = { ...note('**正文**\n\n![图](assets/screenshot-019c0000-0000-7000-8000-000000000003.png)'), title: '<script>bad</script>' }
    const html = await buildNoteHtml(source, { readImage: async () => ({ mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }) })
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('data:image/png;base64,AQID')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<strong>正文</strong>')
  })
})
