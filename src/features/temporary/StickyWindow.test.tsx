import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteDocument, NoteId } from '../../domain/model'
import { pngBytes } from '../../test/fakes'
import { shouldHandleTemporaryClose, StickyWindow } from './StickyWindow'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const capture: NoteDocument = {
  id: '019c0000-0000-7000-8000-000000000031' as NoteId,
  kind: 'temporary',
  title: '临时便笺',
  folderId: null,
  tags: [],
  markdown: 'old',
  revision: 0,
  createdAt: '2026-07-30T08:00:00Z',
  updatedAt: '2026-07-30T08:00:00Z',
}

function setup(save = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 1 }))) {
  const temporary = { save }
  const windows = {
    hide: vi.fn().mockResolvedValue(undefined),
    setAlwaysOnTop: vi.fn().mockImplementation(async (noteId: NoteId, alwaysOnTop: boolean) => ({
      noteId,
      visible: true,
      x: 40,
      y: 40,
      width: 360,
      height: 420,
      alwaysOnTop,
    })),
    startDragging: vi.fn().mockResolvedValue(undefined),
  }
  render(
    <StickyWindow
      note={capture}
      temporary={temporary}
      windows={windows}
      autosaveDelayMs={400}
    />,
  )
  const textbox = screen.getByRole('textbox', { name: 'Markdown source' })
  const editor = EditorView.findFromDOM(textbox)
  if (editor === null) throw new Error('CodeMirror view not found')
  return { editor, save, windows }
}

describe('StickyWindow', () => {
  it('contains capture controls only and uses the shared theme color', () => {
    const { windows } = setup()

    expect(screen.queryByRole('button', { name: /删除|搜索|转为笔记|颜色/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '添加内容块' })).not.toBeInTheDocument()
    expect(screen.queryByText('已就绪')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭便笺' })).toBeVisible()
    expect(screen.getByRole('button', { name: '钉在桌面上' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('sticky-window')).not.toHaveAttribute('style')

    fireEvent.pointerDown(screen.getByTestId('sticky-drag-region'))
    expect(windows.startDragging).toHaveBeenCalledOnce()
  })

  it('autosaves edits and flushes before hiding', async () => {
    vi.useFakeTimers()
    const { editor, save, windows } = setup()
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'new capture' } })

    await act(async () => vi.advanceTimersByTimeAsync(400))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'new capture', revision: 0 }))

    await act(async () => screen.getByRole('button', { name: '关闭便笺' }).click())
    expect(windows.hide).toHaveBeenCalledWith(capture.id)
  })

  it('preserves the temporary port receiver when saving from the editor', async () => {
    const saveThroughClient = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 1 }))
    const temporary = {
      client: { save: saveThroughClient },
      save(document: NoteDocument) {
        return this.client.save(document)
      },
    }
    const windows = {
      hide: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn().mockImplementation(async (noteId: NoteId, alwaysOnTop: boolean) => ({
        noteId, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop,
      })),
      startDragging: vi.fn().mockResolvedValue(undefined),
    }
    render(<StickyWindow note={capture} temporary={temporary} windows={windows} />)
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    if (editor === null) throw new Error('CodeMirror view not found')
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'receiver safe' } })

    await act(async () => screen.getByRole('button', { name: '关闭便笺' }).click())

    expect(saveThroughClient).toHaveBeenCalledWith(expect.objectContaining({ markdown: 'receiver safe' }))
  })

  it('hides after a close flush fails while keeping a retryable local draft', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementationOnce(
      async (document: NoteDocument) => ({ ...document, revision: 1 }),
    )
    const { editor, windows } = setup(save)
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept locally' } })

    await act(async () => screen.getByRole('button', { name: '关闭便笺' }).click())

    expect(windows.hide).toHaveBeenCalledWith(capture.id)
    expect(editor.state.doc.toString()).toBe('kept locally')
    expect(screen.getByRole('alert')).toHaveTextContent('无法保存，修改内容已保留在本地。')
    await act(async () => screen.getByRole('button', { name: '重试保存' }).click())
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  })

  it('hides after a synchronous save failure instead of staying in saving', async () => {
    const save = vi.fn(() => { throw new Error('native save unavailable') })
    const { editor, windows } = setup(save)
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'kept locally' } })

    await act(async () => screen.getByRole('button', { name: '关闭便笺' }).click())

    expect(windows.hide).toHaveBeenCalledWith(capture.id)
    expect(screen.getByRole('alert')).toHaveTextContent('无法保存，修改内容已保留在本地。')
  })

  it('updates authoritative pin state only after the native operation succeeds', async () => {
    const { windows } = setup()
    windows.setAlwaysOnTop.mockResolvedValueOnce({
      noteId: capture.id,
      visible: true,
      x: 40,
      y: 40,
      width: 360,
      height: 420,
      alwaysOnTop: false,
    })

    await act(async () => screen.getByRole('button', { name: '钉在桌面上' }).click())

    expect(windows.setAlwaysOnTop).toHaveBeenCalledWith(capture.id, false)
    expect(screen.getByRole('button', { name: '钉在桌面上' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('adopts a controlled temporary document when the window route changes', () => {
    const temporary = { save: vi.fn(async (document: NoteDocument) => document) }
    const windows = {
      hide: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn().mockImplementation(async (noteId: NoteId, alwaysOnTop: boolean) => ({
        noteId, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop,
      })),
      startDragging: vi.fn().mockResolvedValue(undefined),
    }
    const { rerender } = render(
      <StickyWindow note={capture} temporary={temporary} windows={windows} />,
    )
    const next = {
      ...capture,
      id: '019c0000-0000-7000-8000-000000000032' as NoteId,
      markdown: 'second capture',
    }

    rerender(<StickyWindow note={next} temporary={temporary} windows={windows} />)

    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))
    expect(editor?.state.doc.toString()).toBe('second capture')
  })

  it('waits for an authorized image paste before flushing and hiding', async () => {
    let finishImage!: (value: { relativePath: string; width: number; height: number }) => void
    const assets = {
      saveImage: vi.fn(
        () =>
          new Promise<{ relativePath: string; width: number; height: number }>((resolve) => {
            finishImage = resolve
          }),
      ),
    }
    const save = vi.fn(async (document: NoteDocument) => ({ ...document, revision: 1 }))
    const windows = {
      hide: vi.fn().mockResolvedValue(undefined),
      setAlwaysOnTop: vi.fn().mockImplementation(async (noteId: NoteId, alwaysOnTop: boolean) => ({
        noteId, visible: true, x: 0, y: 0, width: 360, height: 420, alwaysOnTop,
      })),
      startDragging: vi.fn().mockResolvedValue(undefined),
    }
    render(
      <StickyWindow
        note={capture}
        temporary={{ save }}
        windows={windows}
        assets={assets}
        autosaveDelayMs={10_000}
      />,
    )
    const editor = EditorView.findFromDOM(screen.getByRole('textbox', { name: 'Markdown source' }))!
    fireEvent.paste(editor.contentDOM, {
      clipboardData: {
        files: [{ type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer }],
        getData: () => '',
      },
    })
    await vi.waitFor(() => expect(assets.saveImage).toHaveBeenCalledOnce())
    await act(async () => screen.getByRole('button', { name: '关闭便笺' }).click())
    expect(windows.hide).not.toHaveBeenCalled()

    await act(async () => finishImage({ relativePath: 'assets/capture.png', width: 2, height: 2 }))

    await vi.waitFor(() => expect(windows.hide).toHaveBeenCalledWith(capture.id))
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: expect.stringContaining('assets/capture.png') }),
    )
  })

  it('renders pasted image assets inside the sticky editor', async () => {
    const relativePath = `assets/capture-${capture.id}.png`
    const readImage = vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: pngBytes })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sticky-image')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    render(
      <StickyWindow
        note={{ ...capture, markdown: `![海岸](${relativePath})` }}
        temporary={{ save: vi.fn(async (document: NoteDocument) => document) }}
        windows={{
          hide: vi.fn().mockResolvedValue(undefined),
          setAlwaysOnTop: vi.fn().mockResolvedValue({ ...defaultWindowState(), noteId: capture.id }),
          startDragging: vi.fn().mockResolvedValue(undefined),
        }}
        assets={{ saveImage: vi.fn() }}
        assetReader={{ readImage }}
      />,
    )

    expect(await screen.findByRole('img', { name: '海岸' })).toHaveAttribute('src', 'blob:sticky-image')
    expect(readImage).toHaveBeenCalledWith({ noteId: capture.id, relativePath })
  })

  it('handles only a close event carrying its own note identity', () => {
    expect(shouldHandleTemporaryClose(capture.id, { payload: capture.id })).toBe(true)
    expect(
      shouldHandleTemporaryClose(capture.id, {
        payload: '019c0000-0000-7000-8000-000000000099',
      }),
    ).toBe(false)
  })
})

function defaultWindowState() {
  return {
    visible: true,
    x: 0,
    y: 0,
    width: 360,
    height: 420,
    alwaysOnTop: true,
  }
}
