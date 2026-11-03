import { expect, it, vi } from 'vitest'
import { fakeSystemPort, note } from '../../test/fakes'
import { pdfReadingPositionStore, normalizePdfReadingPosition } from './pdfReadingPosition'

it('normalizes invalid preference data without passing invalid pages, zoom or offsets to the viewer', () => {
  expect(normalizePdfReadingPosition({ page: -1, scale: Infinity, scrollTop: -5, scrollLeft: NaN }))
    .toEqual({ page: 1, scale: 1, scrollTop: 0, scrollLeft: 0 })
  expect(normalizePdfReadingPosition(null)).toEqual({ page: 1, scale: 1, scrollTop: 0, scrollLeft: 0 })
})

it('keeps a recent position when an older asynchronous read completes', async () => {
  let resolve!: (value: unknown) => void
  const preferences = fakeSystemPort({ getWindowPreference: vi.fn().mockImplementation(() => new Promise(done => { resolve = done })) })
  const store = pdfReadingPositionStore(preferences)
  const id = note('').id
  const pending = store.load(id)
  const latest = { page: 4, scale: 3, scrollTop: 420, scrollLeft: 0 }
  await store.save(id, latest)
  resolve({ page: 1, scale: 1, scrollTop: 0, scrollLeft: 0 })
  expect(await pending).toEqual(latest)
})

it('serializes preference writes and still saves after an earlier failure', async () => {
  let reject!: (reason: Error) => void
  const write = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    .mockResolvedValue(undefined)
  const preferences = fakeSystemPort({ setWindowPreference: write })
  const store = pdfReadingPositionStore(preferences)
  const id = note('').id
  const first = store.save(id, { page: 2, scale: 1, scrollTop: 0, scrollLeft: 0 }).catch(() => undefined)
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  const second = store.save(id, { page: 3, scale: 1, scrollTop: 0, scrollLeft: 0 })
  expect(write).toHaveBeenCalledOnce()
  reject(new Error('write failed'))
  await first
  await second
  expect(write).toHaveBeenLastCalledWith(`pdf-reading:${id}`, { page: 3, scale: 1, scrollTop: 0, scrollLeft: 0 })
})
