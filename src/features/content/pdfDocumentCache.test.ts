import { describe, expect, it, vi } from 'vitest'
import { PdfDocumentCache } from './pdfDocumentCache'

function fakeDocument() {
  return { cleanup: vi.fn(() => Promise.resolve()) }
}

describe('PdfDocumentCache', () => {
  it('reuses a parsed document and refreshes its recency when read', () => {
    const cache = new PdfDocumentCache(2)
    const first = fakeDocument()
    const second = fakeDocument()
    const third = fakeDocument()

    cache.set('first', first)
    cache.set('second', second)

    expect(cache.get('first')).toBe(first)

    cache.set('third', third)

    expect(cache.get('first')).toBe(first)
    expect(cache.get('second')).toBeUndefined()
    expect(second.cleanup).toHaveBeenCalledOnce()
  })

  it('destroys cached documents when they are evicted or cleared', () => {
    const cache = new PdfDocumentCache(1)
    const first = fakeDocument()
    const second = fakeDocument()

    cache.set('first', first)
    cache.set('second', second)
    cache.clear()

    expect(first.cleanup).toHaveBeenCalledOnce()
    expect(second.cleanup).toHaveBeenCalledOnce()
  })
})