import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import { RichDocumentEditor, type RichDocumentEditorHandle } from './RichDocumentEditor'

beforeAll(() => {
 Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
 Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
 Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0,0,10,10) })
})
afterEach(cleanup)

describe('RichDocumentEditor', () => {
  it('edits a document and emits the versioned app schema', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    const editor = screen.getByRole('textbox', { name: '文档正文' })
    await userEvent.setup().click(editor)
    await userEvent.setup().type(editor, '微屿文档')

    expect(onChange).toHaveBeenLastCalledWith({
      schemaVersion: 1,
      root: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '微屿文档' }] }] },
    })
  })

  it('opens external links only from a modified click', () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'paragraph' as const,
          content: [{ type: 'text' as const, text: '哔哩哔哩', marks: [{ type: 'link', attrs: { href: 'https://www.bilibili.com/video/BV1test' } }] }],
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={vi.fn()} external={{ openExternal }} />)
    const link = screen.getByRole('link', { name: '哔哩哔哩' })
    fireEvent.click(link)
    expect(openExternal).not.toHaveBeenCalled()
    fireEvent.click(link, { ctrlKey: true })
    expect(openExternal).toHaveBeenCalledWith('https://www.bilibili.com/video/BV1test')
  })

  it('turns a pasted URL into a safe link mark', () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const editor = screen.getByRole('textbox', { name: '文档正文' })
    fireEvent.paste(editor, { clipboardData: { getData: (type: string) => type === 'text/plain' ? 'https://www.bilibili.com/video/BV1test' : '' } })
    expect(editor.querySelector('a')?.getAttribute('href')).toBe('https://www.bilibili.com/video/BV1test')
  })
  it('keeps composition text when a save barrier settles the editor', async () => {
    const onChange = vi.fn()
    const ref = createRef<RichDocumentEditorHandle>()
    render(<RichDocumentEditor ref={ref} value={emptyRichDocument()} onChange={onChange} />)
    const editor = screen.getByRole('textbox', { name: '文档正文' })

    fireEvent.compositionStart(editor)
    editor.querySelector('p')!.textContent = '屿'
    fireEvent(editor, new InputEvent('input', {bubbles:true,data:'屿',inputType:'insertCompositionText'}))
    fireEvent.compositionEnd(editor, { data: '屿' })
    await act(async () => { await ref.current?.commitComposition() })

    expect(JSON.stringify(onChange.mock.calls)).toContain('屿')
    expect(ref.current).toMatchObject({
      focus: expect.any(Function),
      navigateToHeading: expect.any(Function),
      commitComposition: expect.any(Function),
    })
  })


  it('selects a rectangular cell range by dragging across cells', async () => {
    const onChange = vi.fn()
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'table' as const,
          content: [
            { type: 'tableRow' as const, content: [{ type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }, { type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }] },
            { type: 'tableRow' as const, content: [{ type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }, { type: 'tableCell' as const, content: [{ type: 'paragraph' as const }] }] },
          ],
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={onChange} />)
    const table = document.querySelector('table')!
    const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>('td,th'))
    const surface = document.querySelector('.rich-document__surface')!
    fireEvent.mouseDown(cells[0])
    fireEvent.mouseMove(cells[3])
    fireEvent.mouseUp(surface)
    expect(table.querySelectorAll('.selectedCell').length).toBe(4)
  })

  it('preserves document scroll when a controlled save acknowledgement updates content', async () => {
    const onChange = vi.fn()
    const initial = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: Array.from({ length: 12 }, (_, index) => ({ type: 'paragraph' as const, content: [{ type: 'text' as const, text: '第 ' + index + ' 段' }] })),
      },
    }
    const { rerender } = render(<RichDocumentEditor value={initial} onChange={onChange} />)
    const surface = document.querySelector('.rich-document__surface') as HTMLElement
    surface.scrollTop = 240
    const updated = { ...initial, root: { ...initial.root, content: [...initial.root.content!, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '保存后的内容' }] }] } }
    await act(async () => {
      rerender(<RichDocumentEditor value={updated} onChange={onChange} />)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(surface.scrollTop).toBe(240)
  })

  it('inserts a table through an accessible editor command', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    await userEvent.setup().click(screen.getByRole('button', { name: '插入' }))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '表格' }))
    await userEvent.setup().click(screen.getByRole('gridcell', { name: '3 行 3 列' }))

    expect(onChange.mock.calls.some(([value]) => value.root.content?.some((node: { type: string }) => node.type === 'table'))).toBe(true)
  })
})
