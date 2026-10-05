import { describe, expect, it, vi } from 'vitest'
import { prepareImageForStorage } from './imageSaveQuality'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

describe('prepareImageForStorage', () => {
  it('uses WebP Q95 by default when the encoded image is smaller', async () => {
    const encode = vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2])], { type: 'image/webp' }))
    const result = await prepareImageForStorage({ mediaType: 'image/png', bytes: png }, 'webp-q95', encode)
    expect(encode).toHaveBeenCalledWith(expect.any(Blob), 0.95)
    expect(result.mediaType).toBe('image/webp')
    expect(result.bytes).toEqual(new Uint8Array([1, 2]))
  })

  it('keeps originals for the original setting, animations, unsupported output and larger output', async () => {
    const encode = vi.fn().mockResolvedValue(new Blob([new Uint8Array(32)], { type: 'image/webp' }))
    const source = { mediaType: 'image/png', bytes: png }
    expect(await prepareImageForStorage(source, 'original', encode)).toBe(source)
    expect(await prepareImageForStorage({ mediaType: 'image/gif', bytes: png }, 'webp-q95', encode)).toEqual({ mediaType: 'image/gif', bytes: png })
    expect(await prepareImageForStorage(source, 'webp-q85', encode)).toBe(source)
    expect(encode).toHaveBeenCalledWith(expect.any(Blob), 0.85)
    encode.mockResolvedValue(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    expect(await prepareImageForStorage(source, 'webp-q95', encode)).toBe(source)
  })

  it('preserves animated PNGs and falls back when encoding fails', async () => {
    const animated = new Uint8Array([...png.subarray(0, 8), 0, 0, 0, 0, 97, 99, 84, 76, 0, 0, 0, 0])
    const encode = vi.fn().mockRejectedValue(new Error('encoder unavailable'))
    const animation = { mediaType: 'image/png', bytes: animated }
    expect(await prepareImageForStorage(animation, 'webp-q95', encode)).toBe(animation)
    expect(encode).not.toHaveBeenCalled()
    const still = { mediaType: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) }
    expect(await prepareImageForStorage(still, 'webp-q95', encode)).toBe(still)
  })
})
