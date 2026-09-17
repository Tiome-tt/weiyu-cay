import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import { RichDocumentEditor, nextRichDocumentZoom, type RichDocumentEditorHandle } from './RichDocumentEditor'

beforeAll(() => {
 Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
 Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
 Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0,0,10,10) })
})
afterEach(cleanup)

describe('RichDocumentEditor', () => {
  it('changes document zoom with Ctrl+wheel while keeping the zoom bounded', () => {
    expect(nextRichDocumentZoom(1, -100)).toBe(1.1)
    expect(nextRichDocumentZoom(1, 100)).toBe(0.9)
    expect(nextRichDocumentZoom(2, -100)).toBe(2)
    expect(nextRichDocumentZoom(0.5, 100)).toBe(0.5)

    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    const surface = document.querySelector('.rich-document__surface') as HTMLElement
    fireEvent.wheel(surface, { ctrlKey: true, deltaY: -100 })
    expect(surface).toHaveStyle('--rich-document-zoom: 1.1')
    fireEvent.wheel(surface, { ctrlKey: false, deltaY: -100 })
    expect(surface).toHaveStyle('--rich-document-zoom: 1.1')
  })
  it('exposes icon paragraph alignment buttons, font, and numeric size controls', () => {
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={vi.fn()} />)
    expect(screen.getByRole('group', { name: '正文对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '左对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '居中对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '右对齐' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '两端对齐' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '字体' })).toBeInTheDocument()
    expect(screen.getByRole('spinbutton', { name: '字号' })).toHaveAttribute('inputmode', 'numeric')
    expect(screen.getByRole('combobox', { name: '字号选项' })).toBeInTheDocument()
  })
  it('applies a custom numeric font size from the integrated size control', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)
    const user = userEvent.setup()
    const editor = screen.getByRole('textbox', { name: '文档正文' })
    await user.click(editor)
    await user.type(editor, 'X')
    const input = screen.getByRole('spinbutton', { name: '字号' })
    await user.clear(input)
    await user.type(input, '18')
    fireEvent.blur(input)
    await user.type(editor, 'Y')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ text: 'Y', marks: [{ type: 'font', attrs: { size: '18' } }] })]),
        })]),
      }),
    }))
  })

  it('keeps rich-document headings directly editable like Markdown headings', async () => {
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'heading' as const,
          attrs: { level: 2 },
          content: [{ type: 'text' as const, text: '旧标题' }],
        }],
      },
    }
    const onChange = vi.fn()
    render(<RichDocumentEditor value={value} onChange={onChange} />)
    const user = userEvent.setup()
    let heading = screen.getByRole('heading', { name: '旧标题', level: 2 })
    const editor = screen.getByRole('textbox', { name: '文档正文' })
    expect(heading).toHaveAttribute('data-rich-heading', 'true')
    expect(heading.querySelector('.rich-document__heading-marker')).toHaveTextContent('##')
    const marker = heading.querySelector('.rich-document__heading-marker') as HTMLElement
    expect(marker).toHaveAttribute('contenteditable', 'true')
    marker.textContent = '#'
    fireEvent.input(marker)
    heading = screen.getByRole('heading', { name: '旧标题', level: 1 })
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 1 }) })]) }),
    }))
    await user.click(heading)
    expect(heading).toHaveClass('rich-document__heading--editing')
    expect(editor).toHaveFocus()
    expect(editor).toHaveAttribute('contenteditable', 'true')
  })
  it('persists a heading level change made by deleting a marker', () => {
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'heading' as const,
          attrs: { level: 3 },
          content: [{ type: 'text' as const, text: '可降级标题' }],
        }],
      },
    }
    const onChange = vi.fn()
    render(<RichDocumentEditor value={value} onChange={onChange} />)

    const heading = screen.getByRole('heading', { name: '可降级标题', level: 3 })
    const marker = heading.querySelector('.rich-document__heading-marker') as HTMLElement
    marker.textContent = '##'
    fireEvent.keyDown(marker, { key: 'Backspace' })

    expect(screen.getByRole('heading', { name: '可降级标题', level: 2 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '可降级标题', level: 2 }).querySelector('.rich-document__heading-marker')).toHaveTextContent('##')
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 2 }) })]) }),
    }))
  })
  it('persists a marker change before leaving the heading', () => {
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{ type: 'heading' as const, attrs: { level: 3 }, content: [{ type: 'text' as const, text: '失焦同步' }] }, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '其他内容' }] }],
      },
    }
    const onChange = vi.fn()
    render(<RichDocumentEditor value={value} onChange={onChange} />)

    const heading = screen.getByRole('heading', { name: '失焦同步', level: 3 })
    const marker = heading.querySelector('.rich-document__heading-marker') as HTMLElement
    marker.textContent = '##'
    fireEvent.mouseDown(screen.getByText('其他内容'))

    expect(screen.getByRole('heading', { name: '失焦同步', level: 2 })).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 2 }) })]) }),
    }))
  })
  it('persists a marker change before keyboard navigation leaves the heading', () => {
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{ type: 'heading' as const, attrs: { level: 3 }, content: [{ type: 'text' as const, text: '方向键同步' }] }, { type: 'paragraph' as const, content: [{ type: 'text' as const, text: '下一段' }] }],
      },
    }
    const onChange = vi.fn()
    render(<RichDocumentEditor value={value} onChange={onChange} />)

    const heading = screen.getByRole('heading', { name: '方向键同步', level: 3 })
    const marker = heading.querySelector('.rich-document__heading-marker') as HTMLElement
    marker.textContent = '##'
    fireEvent.keyDown(heading.querySelector('.rich-document__heading-content') as HTMLElement, { key: 'ArrowDown' })

    expect(screen.getByRole('heading', { name: '方向键同步', level: 2 })).toBeInTheDocument()
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      root: expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ type: 'heading', attrs: expect.objectContaining({ level: 2 }) })]) }),
    }))
  })
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

  it('resizes an embedded image and persists its width', () => {
    const onChange = vi.fn()
    const value = {
      schemaVersion: 1 as const,
      root: {
        type: 'doc' as const,
        content: [{
          type: 'image' as const,
          attrs: {
            src: 'assets/screenshot-019c0000-0000-7000-8000-000000000002.png',
            alt: '架构图',
            width: 240,
          },
        }],
      },
    }
    render(<RichDocumentEditor value={value} onChange={onChange} />)
    const image = document.querySelector('.rich-document__content img') as HTMLImageElement
    const handle = screen.getByRole('button', { name: '调整图片大小' })
    vi.spyOn(image, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 120))

    fireEvent.pointerDown(handle, { clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 300 })
    fireEvent.pointerUp(window, { clientX: 300 })

    expect(onChange.mock.calls.some(([next]) => next.root.content?.[0]?.attrs?.width === 440)).toBe(true)
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

  it('inserts and edits a LaTeX formula from the editor toolbar', async () => {
    const onChange = vi.fn()
    render(<RichDocumentEditor value={emptyRichDocument()} onChange={onChange} />)

    await userEvent.setup().click(screen.getByRole('button', { name: '插入' }))
    await userEvent.setup().click(screen.getByRole('menuitem', { name: '公式' }))
    const input = screen.getByRole('textbox', { name: 'LaTeX 公式' })
    expect(input.getAttribute('placeholder')).toMatch(/例如：x_i.*frac.*sqrt/)
    fireEvent.change(input, { target: { value: '\\frac{a}{b}' } })
    await userEvent.setup().click(screen.getByRole('button', { name: '保存公式' }))

    expect(JSON.stringify(onChange.mock.calls)).toContain('math')
    expect(JSON.stringify(onChange.mock.calls)).toContain('\\frac{a}{b}')
    expect(document.querySelector('[data-rich-math="inline"]')).not.toBeNull()
  })
})
