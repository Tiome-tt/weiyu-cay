import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { fakeSystemPort, note } from '../../test/fakes'
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
    expect(adjustPdfScale(PDF_SCALE_STEPS[PDF_SCALE_STEPS.length - 1], -120)).toBe(3)
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
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toBeEnabled())
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
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toBeEnabled())

  first.unmount()
  render(createElement(PdfViewer, { bytes, cacheKey: 'stable-pdf-test' }))

  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toBeEnabled())
  expect(pdfMocks.getDocument).toHaveBeenCalledOnce()
  expect(documentProxy.cleanup).not.toHaveBeenCalled()
})

function mockPdf(pages = 8) {
  const getViewport = vi.fn(({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }))
  const getPage = vi.fn().mockResolvedValue({ getViewport, render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })) })
  pdfMocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: pages, getPage }), destroy: vi.fn() })
  return { getPage, getViewport }
}

it('jumps to entered pages, clamps bounds and restores invalid or cancelled input', async () => {
  const { getPage } = mockPdf()
  const user = userEvent.setup()
  render(createElement(PdfViewer, { bytes: new Uint8Array([1]) }))
  const input = screen.getByRole('textbox', { name: 'PDF 页码' })
  await waitFor(() => expect(input).toBeEnabled())
  await user.clear(input)
  await user.type(input, '5{Enter}')
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(5))
  await user.clear(input)
  await user.type(input, '999{Enter}')
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(8))
  await user.clear(input)
  await user.type(input, '0')
  fireEvent.blur(input)
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(1))
  await user.clear(input)
  await user.type(input, 'abc{Enter}')
  expect(input).toHaveValue('1')
  await user.clear(input)
  await user.type(input, '6{Escape}')
  expect(input).toHaveValue('1')
})

it('supports 300% from the menu and Ctrl+wheel', async () => {
  const { getViewport } = mockPdf()
  const user = userEvent.setup()
  const view = render(createElement(PdfViewer, { bytes: new Uint8Array([2]) }))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toBeEnabled())
  const zoom = screen.getByRole('combobox', { name: 'PDF 缩放' })
  await user.selectOptions(zoom, '3')
  await waitFor(() => expect(getViewport).toHaveBeenLastCalledWith({ scale: 3 }))
  await user.selectOptions(zoom, '2')
  const page = view.container.querySelector('.pdf-viewer__page')!
  fireEvent.wheel(page, { ctrlKey: true, deltaY: -100 })
  expect(zoom).toHaveValue('2.5')
  fireEvent.wheel(page, { ctrlKey: true, deltaY: -100 })
  expect(zoom).toHaveValue('3')
  fireEvent.wheel(page, { ctrlKey: true, deltaY: -100 })
  expect(zoom).toHaveValue('3')
})

it('restores the saved page, zoom and scroll after reopening with a new preferences session', async () => {
  mockPdf()
  const saved = new Map<string, unknown>()
  const preferences = fakeSystemPort({
    getWindowPreference: vi.fn().mockImplementation(async (key: string) => saved.get(key)),
    setWindowPreference: vi.fn(async (key: string, value: unknown) => { saved.set(key, value) }),
  })
  const props = { bytes: new Uint8Array([3]), noteId: note('').id, preferences }
  const user = userEvent.setup()
  const first = render(createElement('div', { className: 'file-viewer' }, createElement(PdfViewer, props)))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toBeEnabled())
  await user.type(screen.getByRole('textbox', { name: 'PDF 页码' }), '{Control>}a{/Control}4{Enter}')
  await user.selectOptions(screen.getByRole('combobox', { name: 'PDF 缩放' }), '3')
  const host = first.container.querySelector<HTMLElement>('.file-viewer')!
  host.scrollTop = 420
  fireEvent.scroll(host)
  const page = first.container.querySelector<HTMLElement>('.pdf-viewer__page')!
  page.scrollLeft = 160
  fireEvent.scroll(page)
  await waitFor(() => expect(preferences.setWindowPreference).toHaveBeenLastCalledWith(`pdf-reading:${props.noteId}`, { page: 4, scale: 3, scrollTop: 420, scrollLeft: 160 }))
  first.unmount()
  const second = render(createElement('div', { className: 'file-viewer' }, createElement(PdfViewer, { ...props, preferences: { ...preferences } })))
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'PDF 页码' })).toHaveValue('4'))
  expect(screen.getByRole('combobox', { name: 'PDF 缩放' })).toHaveValue('3')
  await waitFor(() => expect(second.container.querySelector('.file-viewer')?.scrollTop).toBe(420))
  expect(second.container.querySelector('.pdf-viewer__page')?.scrollLeft).toBe(160)
})

it('clamps a saved page to the current PDF length and keeps reading usable when preferences fail', async () => {
  const { getPage } = mockPdf(2)
  const preferences = fakeSystemPort({
    getWindowPreference: vi.fn().mockResolvedValue({ page: 50, scale: 3, scrollTop: 0, scrollLeft: 0 }),
    setWindowPreference: vi.fn().mockRejectedValue(new Error('disk unavailable')),
  })
  render(createElement(PdfViewer, { bytes: new Uint8Array([4]), preferences, noteId: note('').id }))
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(2))
  fireEvent.click(screen.getByRole('button', { name: '上一页' }))
  await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(1))
  expect(await screen.findByRole('alert')).toHaveTextContent('无法保存 PDF 阅读位置')
})
