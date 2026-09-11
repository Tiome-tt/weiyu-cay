import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import { richEditorExtensions } from './extensions'

const NOTE_ID = '019c0000-0000-7000-8000-000000000001' as NoteId
const IMAGE_PATH = 'assets/screenshot-019c0000-0000-7000-8000-000000000009.png'

beforeEach(() => {
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:managed-image'),
    revokeObjectURL: vi.fn(),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('managed rich images', () => {
  it('does not create an object URL after the node view is destroyed', async () => {
    let finishRead!: (value: { mediaType: string; bytes: Uint8Array }) => void
    const readImage = vi.fn(() => new Promise<{ mediaType: string; bytes: Uint8Array }>((resolve) => { finishRead = resolve }))
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: richEditorExtensions({ noteId: NOTE_ID, assetReader: { readImage } }),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: IMAGE_PATH } }] },
    })
    editor.destroy()
    finishRead({ mediaType: 'image/png', bytes: new Uint8Array([1]) })
    await Promise.resolve()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it('revokes a created object URL when the node view is destroyed', async () => {
    const element = document.createElement('div')
    const editor = new Editor({
      element,
      extensions: richEditorExtensions({
        noteId: NOTE_ID,
        assetReader: { readImage: vi.fn().mockResolvedValue({ mediaType: 'image/png', bytes: new Uint8Array([1]) }) },
      }),
      content: { type: 'doc', content: [{ type: 'image', attrs: { src: IMAGE_PATH } }] },
    })
    await vi.waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    const created = vi.mocked(URL.createObjectURL).mock.calls.length
    editor.destroy()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(created)
  })
})
