import { expect, it } from 'vitest'
import { PDF_EXPORT_BACKGROUND, PDF_EXPORT_HEADING_COLOR, PDF_EXPORT_INLINE_CSS, PDF_EXPORT_SCALE, PDF_EXPORT_TABLE_CSS, PDF_EXPORT_TEXT_COLOR, normalizePdfExportHref, pageCountForRenderedHeight, pageRangesForRenderedDocument, pdfAssetPathFromElement, pdfLinkLabel, pdfLinkSegmentsForPage } from './pdfExport'

it('splits a rendered document into complete A4 pages', () => {
  expect(pageCountForRenderedHeight(0, 1000)).toBe(0)
  expect(pageCountForRenderedHeight(999, 1000)).toBe(1)
  expect(pageCountForRenderedHeight(1000, 1000)).toBe(1)
  expect(pageCountForRenderedHeight(1001, 1000)).toBe(2)
})
it('keeps a clickable link rectangle when it crosses an A4 page boundary', () => {
  expect(pdfLinkSegmentsForPage(
    { left: 10, top: 90, width: 100, height: 30, href: 'https://example.com' },
    100,
    100,
    2,
  )).toEqual([{ x: 20, y: 0, width: 200, height: 40, href: 'https://example.com' }])
})
it('uses a neutral print palette instead of the application theme', () => {
  expect(PDF_EXPORT_BACKGROUND).toBe('#ffffff')
  expect(PDF_EXPORT_TEXT_COLOR).toBe('#1f2933')
  expect(PDF_EXPORT_HEADING_COLOR).toBe('#111827')
  expect(PDF_EXPORT_SCALE).toBe(2)
  expect(PDF_EXPORT_INLINE_CSS).toContain('background: transparent')
  expect(PDF_EXPORT_INLINE_CSS).toContain('display: inline')
  expect(PDF_EXPORT_INLINE_CSS).toContain('overflow-wrap: anywhere')
  expect(PDF_EXPORT_INLINE_CSS).toContain('pdf-export-highlight')
  expect(PDF_EXPORT_TABLE_CSS).toContain('table-layout: fixed')
  expect(PDF_EXPORT_TABLE_CSS).toContain('overflow-wrap: anywhere')
  expect(PDF_EXPORT_TABLE_CSS).toContain('margin-left: auto')
  expect(PDF_EXPORT_TABLE_CSS).toContain('figure.rich-document__image-node')
  expect(PDF_EXPORT_TABLE_CSS).toContain('margin-right: auto')
})

it('recovers Markdown preview external URLs stored in data attributes', () => {
  expect(normalizePdfExportHref('#simple-notes-external', 'https://example.com/apply', 'https://notes.local/')).toBe('https://example.com/apply')
  expect(normalizePdfExportHref('#simple-notes-internal', undefined, 'https://notes.local/')).toBeNull()
})
it('keeps blocks, tables, and images together when a page boundary would split them', () => {
  expect(pageRangesForRenderedDocument(300, 100, [{ top: 80, height: 50 }])).toEqual([
    { top: 0, height: 80 },
    { top: 80, height: 100 },
    { top: 180, height: 100 },
    { top: 280, height: 20 },
  ])
  expect(pageRangesForRenderedDocument(250, 100, [{ top: 0, height: 150 }])).toEqual([
    { top: 0, height: 100 },
    { top: 100, height: 100 },
    { top: 200, height: 50 },
  ])
})

it('keeps a large protected block from creating a disproportionate blank area', () => {
  expect(pageRangesForRenderedDocument(300, 100, [{ top: 20, height: 100 }])).toEqual([
    { top: 0, height: 100 },
    { top: 100, height: 100 },
    { top: 200, height: 100 },
  ])
})

it('moves a page boundary to a text line instead of dropping the whole paragraph', () => {
  expect(pageRangesForRenderedDocument(300, 100, [{ top: 94, height: 12 }])).toEqual([
    { top: 0, height: 94 },
    { top: 94, height: 100 },
    { top: 194, height: 100 },
    { top: 294, height: 6 },
  ])
})
it('reads the persisted rich-image path from an export clone', () => {
  const image = document.createElement('img')
  image.dataset.simpleNotesImagePath = 'assets/figure.png'
  expect(pdfAssetPathFromElement(image)).toBe('assets/figure.png')
  image.dataset.simpleNotesImagePath = ' '
  expect(pdfAssetPathFromElement(image)).toBeNull()
})
it('uses a compact but recognizable label for long external links', () => {
  expect(pdfLinkLabel('https://maker.haier.net/client/campusmobile/deliverfirst/apply?jobId=123')).toBe('maker.haier.net')
  expect(pdfLinkLabel('mailto:hello@example.com')).toBe('hello@example.com')
})