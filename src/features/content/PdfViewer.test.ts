import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pdfMocks = vi.hoisted(() => ({
  getDocument: vi.fn(),
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: pdfMocks.getDocument,
  GlobalWorkerOptions: {},
}))

import PdfViewer, { adjustPdfScale, PDF_SCALE_STEPS } from './PdfViewer'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

beforeEach(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({})),
  })
})

describe('adjustPdfScale', () => {
  it('moves one themed scale step per Ctrl+wheel notch and clamps at the bounds', () => {
    expect(adjustPdfScale(1, -120)).toBe(1.25)
    expect(adjustPdfScale(1.25, 120)).toBe(1)
    expect(adjustPdfScale(PDF_SCALE_STEPS[PDF_SCALE_STEPS.length - 1], -120)).toBe(2)
    expect(adjustPdfScale(PDF_SCALE_STEPS[0], 120)).toBe(0.5)
  })

  it('chooses the nearest supported step when the current value is between options', () => {
    expect(adjustPdfScale(1.1, -1)).toBe(1.25)
    expect(adjustPdfScale(1.1, 1)).toBe(0.75)
  })
})

it('shares one parse while the same PDF is still loading', async () => {
  const documentProxy = {
    numPages: 1,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 100, height: 100 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  }
  let resolveDocument!: (value: typeof documentProxy) => void
  const pending = new Promise<typeof documentProxy>(resolve => {
    resolveDocument = resolve
  })
  pdfMocks.getDocument.mockReturnValue({
    promise: pending,
    destroy: vi.fn().mockResolvedValue(undefined),
  })

  const bytes = new Uint8Array([37, 80, 68, 70, 45])
  const first = render(createElement(PdfViewer, { bytes, cacheKey: 'pending-pdf-test' }))
  await waitFor(() => expect(pdfMocks.getDocument).toHaveBeenCalledOnce())

  first.unmount()
  render(createElement(PdfViewer, { bytes, cacheKey: 'pending-pdf-test' }))
  expect(pdfMocks.getDocument).toHaveBeenCalledOnce()

  resolveDocument(documentProxy)
  await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())
})
 it('reuses a parsed PDF document when reopening the same stable file revision', async () => {
  const documentProxy = {
    numPages: 1,
    getPage: vi.fn().mockResolvedValue({
      getViewport: vi.fn(() => ({ width: 100, height: 100 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    }),
    cleanup: vi.fn().mockResolvedValue(undefined),
  }
  pdfMocks.getDocument.mockReturnValue({
    promise: Promise.resolve(documentProxy),
    destroy: vi.fn().mockResolvedValue(undefined),
  })

  const bytes = new Uint8Array([37, 80, 68, 70, 45])
  const first = render(createElement(PdfViewer, { bytes, cacheKey: 'stable-pdf-test' }))
  await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())

  first.unmount()
  render(createElement(PdfViewer, { bytes, cacheKey: 'stable-pdf-test' }))

  await waitFor(() => expect(screen.getByText('1 / 1')).toBeInTheDocument())
  expect(pdfMocks.getDocument).toHaveBeenCalledOnce()
  expect(documentProxy.cleanup).not.toHaveBeenCalled()
})
