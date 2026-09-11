import { describe, expect, it, vi } from 'vitest'
import { PendingAssetWrites } from './PendingAssetWrites'

describe('PendingAssetWrites', () => {
  it('waits for work that was already registered', async () => {
    let finish!: () => void
    const pending = new PendingAssetWrites()
    pending.track(new Promise<void>((resolve) => { finish = resolve }))
    let settled = false
    const barrier = pending.settle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish()
    await barrier
    expect(settled).toBe(true)
  })

  it('reports a safe failure once without an unhandled rejection', async () => {
    const onFailure = vi.fn()
    const pending = new PendingAssetWrites(onFailure)
    pending.track(Promise.reject(new Error('C:\\private\\source.png')))
    await expect(pending.settle()).rejects.toThrow('图片保存失败')
    expect(onFailure).toHaveBeenCalledWith('图片保存失败，请重试。')
    await expect(pending.settle()).resolves.toBeUndefined()
  })
})
