import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NoteOutline, parseNoteHeadings } from './NoteOutline'

afterEach(cleanup)

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

describe('NoteOutline level hierarchy', () => {
  it('keeps distinct classes for fourth through sixth level headings', () => {
    expect(parseNoteHeadings('#### Four\n##### Five\n###### Six')).toEqual([
      { line: 1, index: 0, level: 4, text: 'Four' },
      { line: 2, index: 1, level: 5, text: 'Five' },
      { line: 3, index: 2, level: 6, text: 'Six' },
    ])
  })
})
describe('NoteOutline folding', () => {
  it('shows folding controls only for headings with children and hides descendants after one click', () => {
    render(<NoteOutline markdown={'# One\n## Two\n### Three\n# Four'} onNavigate={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'One' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Two' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Three' })).toBeVisible()
    expect(screen.getByRole('button', { name: '折叠“One”下级标题' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '折叠“Two”下级标题' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '折叠“One”下级标题' }))

    expect(screen.queryByRole('button', { name: 'Two' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Three' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Four' })).toBeVisible()
    expect(screen.getByRole('button', { name: '展开“One”下级标题' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('restores collapsed keys and reports changes for persistence', () => {
    const onCollapsedKeysChange = vi.fn()
    render(<NoteOutline markdown={'# One\n## Two\n# Four'} onNavigate={vi.fn()} collapsedKeys={['1:0']} onCollapsedKeysChange={onCollapsedKeysChange} />)

    expect(screen.queryByRole('button', { name: 'Two' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开“One”下级标题' }))

    expect(screen.getByRole('button', { name: 'Two' })).toBeVisible()
    expect(onCollapsedKeysChange).toHaveBeenCalledWith([])
  })
  it('keeps title clicks for navigation while folding uses a separate control', () => {
    const onNavigate = vi.fn()
    render(<NoteOutline markdown={'# One\n## Two'} onNavigate={onNavigate} />)

    fireEvent.click(screen.getByRole('button', { name: 'One' }))
    expect(onNavigate).toHaveBeenCalledWith(1, 0)
    fireEvent.click(screen.getByRole('button', { name: '折叠“One”下级标题' }))
    expect(onNavigate).toHaveBeenCalledOnce()
  })
})