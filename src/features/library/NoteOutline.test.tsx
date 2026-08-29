import { describe, expect, it } from 'vitest'
import { parseNoteHeadings } from './NoteOutline'

  it('ignores headings inside fenced code blocks', () => {
    expect(parseNoteHeadings('```md\n# not a heading\n```\n## Real heading')).toEqual([
      { line: 4, index: 0, level: 2, text: 'Real heading' },
    ])
  })
describe('parseNoteHeadings', () => {
  it('keeps heading levels and source line numbers for navigation', () => {
    expect(parseNoteHeadings('# One\ntext\n## Two\n### Three')).toEqual([
      { line: 1, index: 0, level: 1, text: 'One' },
      { line: 3, index: 1, level: 2, text: 'Two' },
      { line: 4, index: 2, level: 3, text: 'Three' },
    ])
  })

  it('removes optional closing hash marks without treating plain text as a heading', () => {
    expect(parseNoteHeadings('title\n## Chapter ##\nnot # a heading')).toEqual([
      { line: 2, index: 0, level: 2, text: 'Chapter' },
    ])
  })
})
