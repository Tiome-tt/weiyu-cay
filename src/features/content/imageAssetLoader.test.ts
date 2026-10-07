import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteId } from '../../domain/model'
import { clearImageAssetCache, readImageAsset, waitForImageAssets } from './imageAssetLoader'

const noteId = '019c0000-0000-7000-8000-000000000001' as NoteId

afterEach(() => {
  clearImageAssetCache()
})

describe('image asset loader', () => {
  it('coalesces same-tick image requests into one batch and preserves each path', async () => {
    const readImages = vi.fn(async ({ relativePaths }: { relativePaths: string[] }) => relativePaths.map((relativePath) => ({
      relativePath,
      mediaType: 'image/png',
      bytes: new Uint8Array([relativePath.length]),
    })))
    const reader = { readImage: vi.fn(), readImages }

    const loaded = await Promise.all([
      readImageAsset(reader, noteId, 'assets/a.png'),
      readImageAsset(reader, noteId, 'assets/b.png'),
      readImageAsset(reader, noteId, 'assets/a.png'),
    ])

    expect(readImages).toHaveBeenCalledOnce()
    expect(readImages).toHaveBeenCalledWith({ noteId, relativePaths: ['assets/a.png', 'assets/b.png'] })
    expect(reader.readImage).not.toHaveBeenCalled()
    expect(loaded.map((image) => image.bytes[0])).toEqual([12, 12, 12])
  })

  it('deduplicates concurrent reads when the port has no batch method', async () => {
    let resolveRead!: (value: { mediaType: string; bytes: Uint8Array }) => void
    const readImage = vi.fn(() => new Promise<{ mediaType: string; bytes: Uint8Array }>((resolve) => { resolveRead = resolve }))
    const reader = { readImage }

    const first = readImageAsset(reader, noteId, 'assets/a.png')
    const second = readImageAsset(reader, noteId, 'assets/a.png')
    await new Promise((resolve) => setTimeout(resolve, 16))
    expect(readImage).toHaveBeenCalledOnce()
    resolveRead({ mediaType: 'image/png', bytes: new Uint8Array([1]) })

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(readImage).toHaveBeenCalledOnce()
  })

  it('falls back to individual reads when the batch method is unavailable at runtime', async () => {
    const readImage = vi.fn(async ({ relativePath }: { relativePath: string }) => ({
      mediaType: 'image/png',
      bytes: new Uint8Array([relativePath.length]),
    }))
    const readImages = vi.fn(async () => { throw new Error('unknown command') })
    const reader = { readImage, readImages }

    const loaded = await Promise.all([
      readImageAsset(reader, noteId, 'assets/a.png'),
      readImageAsset(reader, noteId, 'assets/b.png'),
    ])

    expect(readImages).toHaveBeenCalledOnce()
    expect(readImage).toHaveBeenCalledTimes(2)
    expect(loaded.map((image) => image.bytes[0])).toEqual([12, 12])
  })

  it('splits a large image batch so the browser can process images incrementally', async () => {
    const readImages = vi.fn(async ({ relativePaths }: { relativePaths: string[] }) => relativePaths.map((relativePath) => ({
      relativePath,
      mediaType: 'image/png',
      bytes: new Uint8Array([1]),
    })))
    const reader = { readImage: vi.fn(), readImages }
    const paths = Array.from({ length: 7 }, (_, index) => `assets/${index}.png`)

    await Promise.all(paths.map((path) => readImageAsset(reader, noteId, path)))

    expect(readImages).toHaveBeenCalledTimes(4)
    expect(readImages.mock.calls[0]?.[0].relativePaths).toHaveLength(2)
    expect(readImages.mock.calls[1]?.[0].relativePaths).toHaveLength(2)
    expect(readImages.mock.calls[2]?.[0].relativePaths).toHaveLength(2)
    expect(readImages.mock.calls[3]?.[0].relativePaths).toHaveLength(1)
  })

  it('waits for pending image reads before AI starts', async () => {
    let resolveRead!: (value: { mediaType: string; bytes: Uint8Array }) => void
    const readImage = vi.fn(() => new Promise<{ mediaType: string; bytes: Uint8Array }>((resolve) => { resolveRead = resolve }))
    const reader = { readImage }
    const pending = readImageAsset(reader, noteId, 'assets/wait.png')
    const waiting = waitForImageAssets(reader, noteId)

    await new Promise((resolve) => setTimeout(resolve, 32))
    expect(readImage).toHaveBeenCalledOnce()
    resolveRead({ mediaType: 'image/png', bytes: new Uint8Array([1]) })

    await expect(pending).resolves.toBeTruthy()
    await expect(waiting).resolves.toBeUndefined()
  })
  it('defers the first image batch until after the initial task', async () => {
    vi.useFakeTimers()
    try {
      const readImages = vi.fn(async ({ relativePaths }: { relativePaths: string[] }) => relativePaths.map((relativePath) => ({
        relativePath,
        mediaType: 'image/png',
        bytes: new Uint8Array([1]),
      })))
      const reader = { readImage: vi.fn(), readImages }
      const pending = readImageAsset(reader, noteId, 'assets/deferred.png')

      await Promise.resolve()
      expect(readImages).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(16)
      await expect(pending).resolves.toEqual({ mediaType: 'image/png', bytes: new Uint8Array([1]) })
    } finally {
      vi.useRealTimers()
    }
  })
})

it('drains a new image request added while the previous batch is loading',async()=>{
 let finish!:()=>void
 const firstGate=new Promise<void>(resolve=>{finish=resolve})
 const readImages=vi.fn(async({relativePaths}:{relativePaths:string[]})=>{
  if(relativePaths.includes('assets/first.png'))await firstGate
  return relativePaths.map(relativePath=>({relativePath,mediaType:'image/png',bytes:new Uint8Array([1])}))
 })
 const reader={readImage:vi.fn(),readImages}
 const first=readImageAsset(reader,noteId,'assets/first.png')
 await vi.waitFor(()=>expect(readImages).toHaveBeenCalledOnce())
 const second=readImageAsset(reader,noteId,'assets/second.png')
 finish()
 await expect(Promise.all([first,second])).resolves.toHaveLength(2)
 expect(readImages).toHaveBeenCalledTimes(2)
})
