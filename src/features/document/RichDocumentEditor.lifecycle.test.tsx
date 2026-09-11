import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { emptyRichDocument } from '../../domain/content'
import type { NoteId } from '../../domain/model'
import { RichDocumentEditor, type RichDocumentEditorHandle } from './RichDocumentEditor'

beforeAll(() => {
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.tiptap') })
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] })
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 0, 10, 10) })
})
afterEach(cleanup)

function clipboardImage() {
  const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  if (!file.arrayBuffer) Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([137, 80, 78, 71]).buffer })
  return { files: [file], getData: () => '' }
}

describe('RichDocumentEditor save barrier', () => {
  it('waits for an in-flight pasted image before resolving commitComposition', async () => {
    let finishSave!: (value: { relativePath: string; width: number; height: number }) => void
    const saveImage = vi.fn(() => new Promise<{ relativePath: string; width: number; height: number }>((resolve) => { finishSave = resolve }))
    const ref = createRef<RichDocumentEditorHandle>()
    const onChange = vi.fn()
    render(<RichDocumentEditor
      ref={ref}
      noteId={'019c0000-0000-7000-8000-000000000001' as NoteId}
      assets={{ saveImage }}
      value={emptyRichDocument()}
      onChange={onChange}
    />)
    fireEvent.paste(screen.getByRole('textbox', { name: '文档正文' }), { clipboardData: clipboardImage() })
    await vi.waitFor(() => expect(saveImage).toHaveBeenCalledOnce())

    let barrierFinished = false
    const barrier = ref.current!.commitComposition().then(() => { barrierFinished = true })
    await Promise.resolve()
    expect(barrierFinished).toBe(false)

    finishSave({ relativePath: 'assets/screenshot-019c0000-0000-7000-8000-000000000009.png', width: 20, height: 10 })
    await act(async () => { await barrier })
    expect(JSON.stringify(onChange.mock.calls)).toContain('screenshot-019c0000-0000-7000-8000-000000000009.png')
  })

  it('rejects the barrier and shows a safe error when image persistence fails', async () => {
    const ref = createRef<RichDocumentEditorHandle>()
    render(<RichDocumentEditor
      ref={ref}
      noteId={'019c0000-0000-7000-8000-000000000001' as NoteId}
      assets={{ saveImage: vi.fn().mockRejectedValue(new Error('absolute C:\\private\\note leaked')) }}
      value={emptyRichDocument()}
      onChange={vi.fn()}
    />)
    fireEvent.paste(screen.getByRole('textbox', { name: '文档正文' }), { clipboardData: clipboardImage() })

    await expect(ref.current!.commitComposition()).rejects.toThrow('图片保存失败')
    expect(await screen.findByRole('alert')).toHaveTextContent('图片保存失败，请重试。')
    expect(screen.queryByText(/private/)).not.toBeInTheDocument()
  })

  it('consumes a failed image barrier when a toolbar action waits on it', async () => {
    render(<RichDocumentEditor
      noteId={'019c0000-0000-7000-8000-000000000001' as NoteId}
      assets={{ saveImage: vi.fn().mockRejectedValue(new Error('disk failure')) }}
      value={emptyRichDocument()}
      onChange={vi.fn()}
    />)
    fireEvent.paste(screen.getByRole('textbox', { name: '文档正文' }), { clipboardData: clipboardImage() })
    expect(await screen.findByRole('alert')).toHaveTextContent('图片保存失败，请重试。')
    fireEvent.click(screen.getByRole('button', { name: '粗体' }))
    await act(async () => { await Promise.resolve() })
  })
})
