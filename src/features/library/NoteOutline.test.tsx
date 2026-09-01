import { describe, expect, it } from 'vitest'
import { parseNoteHeadings } from './NoteOutline'

describe('parseNoteHeadings', () => {
  it.each(['```markdown', '~~~markdown', '````markdown'])('ignores headings inside %s fences and preserves navigation indexes', (fence) => {
    const close = fence.replace('markdown', '')
    expect(parseNoteHeadings(`# Before\n${fence}\n# Code\n## Example\n${close}\n## After`)).toEqual([
      { line: 1, index: 0, level: 1, text: 'Before' },
      { line: 6, index: 1, level: 2, text: 'After' },
    ])
  })
  it('ignores unclosed fences, indented code and HTML blocks', () => {
    expect(parseNoteHeadings('    # Code\n\n<!--\n# Hidden\n-->\n\n~~~\n# Unclosed')).toEqual([])
  })
  it('matches rendered headings inside containers and setext headings', () => {
    expect(parseNoteHeadings('> # Quote\n\n- ## List\n\nSetext\n---\n\n### **Bold** and `code`')).toEqual([
      { line: 1, index: 0, level: 1, text: 'Quote' },
      { line: 3, index: 1, level: 2, text: 'List' },
      { line: 5, index: 2, level: 2, text: 'Setext' },
      { line: 8, index: 3, level: 3, text: 'Bold and code' },
    ])
  })
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
