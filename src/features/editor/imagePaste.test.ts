import { describe, expect, it, vi } from 'vitest'
import { fakeAssetPort, noteId, pngBytes } from '../../test/fakes'
import { handleImagePaste } from './imagePaste'

function paste(files: Array<Pick<File, 'type' | 'arrayBuffer'>>) {
  return {
    clipboardData: { files },
    preventDefault: vi.fn(),
  }
}

describe('handleImagePaste', () => {
  it('saves a supported image and returns a relative Markdown reference', async () => {
    const assets = fakeAssetPort({
      relativePath: 'assets/screenshot-019c.png',
      width: 800,
      height: 500,
    })
    const event = paste([
      { type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer },
    ])

    await expect(handleImagePaste(event, { noteId, assets })).resolves.toEqual({
      kind: 'success',
      markdown: '![截图](assets/screenshot-019c.png)',
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(assets.saveImage).toHaveBeenCalledWith({
      noteId,
      mediaType: 'image/png',
      bytes: pngBytes,
    })
  })

  it('leaves ordinary and unsupported paste behavior untouched', async () => {
    const assets = fakeAssetPort({ relativePath: 'unused', width: 1, height: 1 })
    const event = paste([{ type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(0) }])

    await expect(handleImagePaste(event, { noteId, assets })).resolves.toEqual({ kind: 'ignored' })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(assets.saveImage).not.toHaveBeenCalled()
  })

  it('owns supported image paste but returns a user-safe failure', async () => {
    const assets = {
      saveImage: vi.fn().mockRejectedValue(new Error('C:\\private\\notes\\asset.png')),
    }
    const event = paste([
      { type: 'image/png', arrayBuffer: async () => pngBytes.slice().buffer },
    ])

    await expect(handleImagePaste(event, { noteId, assets })).resolves.toEqual({
      kind: 'failure',
      message: '无法保存截图。',
    })
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})
