import html2canvas from 'html2canvas'
import { jsPDF } from 'jspdf'
import type { NoteId } from '../../domain/model'
import type { FilePort, ImageReadPort } from '../../domain/ports'
import type { NoteDocument } from '../../domain/model'
import { prepareMarkdownPrint } from './markdownPrint'
import { printableClone } from './printDocument'

export const PDF_PAGE_WIDTH_PT = 595.28
export const PDF_PAGE_HEIGHT_PT = 841.89
export const PDF_PAGE_MARGIN_PT = 36
export const PDF_EXPORT_BACKGROUND = '#ffffff'
export const PDF_EXPORT_TEXT_COLOR = '#1f2933'
export const PDF_EXPORT_HEADING_COLOR = '#111827'
export const PDF_EXPORT_SCALE = 2
export const PDF_EXPORT_INLINE_CSS = '.pdf-export-surface mark { display: inline !important; background: transparent !important; box-decoration-break: initial; -webkit-box-decoration-break: initial; overflow-wrap: anywhere !important; word-break: normal !important; white-space: normal !important; } .pdf-export-highlight { position: absolute !important; z-index: 0 !important; background: #fff0ad !important; border-radius: 1px; pointer-events: none; }'
export const PDF_EXPORT_TABLE_CSS = '.pdf-export-surface table { width: 100% !important; max-width: 100% !important; table-layout: fixed !important; border-collapse: collapse !important; } .pdf-export-surface th, .pdf-export-surface td { min-width: 0 !important; max-width: none !important; padding: 6px 8px !important; vertical-align: top !important; white-space: normal !important; overflow-wrap: anywhere !important; word-break: break-word !important; } .pdf-export-surface a { overflow-wrap: anywhere !important; word-break: break-word !important; } .pdf-export-surface img { display: block !important; max-width: 100% !important; height: auto !important; margin-right: auto !important; margin-left: auto !important; } .pdf-export-surface figure.rich-document__image-node { display: block !important; max-width: 100% !important; margin-right: auto !important; margin-left: auto !important; } .pdf-export-surface figure.rich-document__image-node > img { margin-right: auto !important; margin-left: auto !important; } .pdf-export-surface thead { display: table-header-group !important; } .pdf-export-surface tr, .pdf-export-surface img { break-inside: avoid !important; page-break-inside: avoid !important; }'
export interface PdfExportLinkRect {
  href: string
  left: number
  top: number
  width: number
  height: number
}

export interface PdfProtectedRange {
  top: number
  height: number
}

export interface PdfPageRange {
  top: number
  height: number
}

export interface PdfLinkSegment {
  href: string
  x: number
  y: number
  width: number
  height: number
}

export function pdfLinkSegmentsForPage(
  rect: PdfExportLinkRect,
  pageTop: number,
  pageHeight: number,
  pointsPerPixel: number,
): PdfLinkSegment[] {
  if (
    !Number.isFinite(pageTop)
    || !Number.isFinite(pageHeight)
    || pageHeight <= 0
    || !Number.isFinite(pointsPerPixel)
    || pointsPerPixel <= 0
    || rect.width <= 0
    || rect.height <= 0
  ) return []
  const top = Math.max(rect.top, pageTop)
  const bottom = Math.min(rect.top + rect.height, pageTop + pageHeight)
  if (bottom <= top) return []
  return [{
    href: rect.href,
    x: rect.left * pointsPerPixel,
    y: (top - pageTop) * pointsPerPixel,
    width: rect.width * pointsPerPixel,
    height: (bottom - top) * pointsPerPixel,
  }]
}

export function pageCountForRenderedHeight(height: number, pageHeight: number): number {
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) return 0
  return Math.max(1, Math.ceil(height / pageHeight))
}

export function pageRangesForRenderedDocument(
  height: number,
  pageHeight: number,
  protectedRanges: readonly PdfProtectedRange[] = [],
): PdfPageRange[] {
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(pageHeight) || pageHeight <= 0) return []
  const ranges: PdfPageRange[] = []
  let top = 0
  while (top < height) {
    let bottom = Math.min(height, top + pageHeight)
    const maxAvoidedGap = Math.max(24, pageHeight * 0.25)
    const crossingRange = protectedRanges
      .filter((range) => Number.isFinite(range.top) && Number.isFinite(range.height) && range.top > top && range.height > 0 && range.top < bottom && range.top + range.height > bottom)
      .sort((left, right) => left.top - right.top)
      .find((range) => bottom - range.top <= maxAvoidedGap && range.height <= pageHeight * 0.85)
    if (crossingRange) bottom = crossingRange.top
    if (bottom <= top) bottom = Math.min(height, top + pageHeight)
    ranges.push({ top, height: bottom - top })
    top = bottom
  }
  return ranges
}
export function normalizePdfExportHref(
  rawHref: string | undefined,
  advertisedHref: string | undefined,
  baseHref: string,
): string | null {
  const advertised = advertisedHref?.trim() ?? ''
  const candidate = advertised || rawHref?.trim() || ''
  if (candidate === '' || (advertised === '' && !/^(?:https?:|mailto:|tel:)/iu.test(candidate))) return null
  let href: URL
  try {
    href = new URL(candidate, baseHref)
  } catch {
    return null
  }
  return ['http:', 'https:', 'mailto:', 'tel:'].includes(href.protocol) ? href.href : null
}
export function pdfLinkLabel(href: string): string {
  try {
    const url = new URL(href)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host
    if (url.protocol === 'mailto:') return url.pathname
  } catch {
    return href
  }
  return href
}
function safeTitle(title: string): string {
  return title.trim() || '未命名文档'
}

function collectPdfLinkRects(root: HTMLElement): PdfExportLinkRect[] {
  const rootRect = root.getBoundingClientRect()
  return [...root.querySelectorAll<HTMLAnchorElement>('a[href]')].flatMap((anchor) => {
    const normalizedHref = normalizePdfExportHref(
      anchor.getAttribute('href') ?? undefined,
      anchor.dataset.simpleNotesExternalLink,
      document.baseURI,
    )
    if (normalizedHref === null) return []
    const rects = [...anchor.getClientRects()]
    const visibleRects = rects.length > 0 ? rects : [anchor.getBoundingClientRect()]
    return visibleRects
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        href: normalizedHref,
        left: rect.left - rootRect.left,
        top: rect.top - rootRect.top,
        width: rect.width,
        height: rect.height,
      }))
  })
}
export function pdfAssetPathFromElement(element: HTMLElement): string | null {
  const path = element.dataset.simpleNotesImagePath?.trim() ?? ''
  return path === '' ? null : path
}

type PdfImageLoader = (relativePath: string) => Promise<{ mediaType: string; bytes: Uint8Array }>

function collectPdfAvoidRanges(root: HTMLElement): PdfProtectedRange[] {
  const rootRect = root.getBoundingClientRect()
  const ranges: PdfProtectedRange[] = []
  const addRect = (rect: DOMRect) => {
    const top = rect.top - rootRect.top
    if (top >= 0 && rect.height > 0) ranges.push({ top, height: rect.height })
  }

  for (const element of root.querySelectorAll<HTMLElement>('figure,tr,img')) addRect(element.getBoundingClientRect())

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const line = document.createRange()
  let node = walker.nextNode()
  while (node !== null) {
    if ((node.textContent ?? '').trim() !== '') {
      line.selectNodeContents(node)
      for (const rect of line.getClientRects()) addRect(rect)
    }
    node = walker.nextNode()
  }
  return ranges
}

function applyPdfHighlightOverlays(root: HTMLElement): void {
  const rootRect = root.getBoundingClientRect()
  for (const mark of root.querySelectorAll<HTMLElement>('mark')) {
    const rects = [...mark.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
    mark.style.setProperty('background', 'transparent', 'important')
    for (const rect of rects) {
      const overlay = document.createElement('span')
      overlay.className = 'pdf-export-highlight'
      overlay.setAttribute('aria-hidden', 'true')
      overlay.style.left = `${rect.left - rootRect.left}px`
      overlay.style.top = `${rect.top - rootRect.top}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height}px`
      root.append(overlay)
    }
  }
}

function compactPdfExportLinks(root: HTMLElement): void {
  for (const anchor of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const normalizedHref = normalizePdfExportHref(
      anchor.getAttribute('href') ?? undefined,
      anchor.dataset.simpleNotesExternalLink,
      document.baseURI,
    )
    if (normalizedHref === null) continue
    const label = anchor.textContent?.trim() ?? ''
    if (/^(?:https?|mailto|tel):/iu.test(label) || label === anchor.getAttribute('href')?.trim()) {
      anchor.textContent = pdfLinkLabel(normalizedHref)
      anchor.dataset.simpleNotesExternalLink = normalizedHref
      anchor.setAttribute('href', normalizedHref)
    }
  }
}
async function hydratePdfImages(root: HTMLElement, loadImage: PdfImageLoader | undefined): Promise<string[]> {
  if (!loadImage) return []
  const objectUrls: string[] = []
  await Promise.all([...root.querySelectorAll<HTMLImageElement>('img')].map(async (image) => {
    const relativePath = pdfAssetPathFromElement(image)
    if (relativePath === null) return
    try {
      const { mediaType, bytes } = await loadImage(relativePath)
      const objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mediaType }))
      image.src = objectUrl
      objectUrls.push(objectUrl)
    } catch {
      // Keep the existing source (if any); a failed asset must not abort the whole export.
    }
  }))
  return objectUrls
}

async function renderPdfBytes(source: HTMLElement, title: string, loadImage?: PdfImageLoader): Promise<Uint8Array> {
  const mount = document.createElement('div')
  mount.className = 'pdf-export-surface'
  mount.style.cssText = 'position:absolute;left:-8192px;top:0;width:794px;padding:68px;box-sizing:border-box;background:' + PDF_EXPORT_BACKGROUND + ';color:' + PDF_EXPORT_TEXT_COLOR + ';z-index:0;pointer-events:none;'
  const heading = document.createElement('h1')
  heading.textContent = safeTitle(title)
  heading.style.cssText = 'margin:0 0 28px;font:700 30px/1.25 "Microsoft YaHei",sans-serif;'
  const clone = printableClone(source)
  clone.style.cssText = 'position:relative;z-index:1;width:100%;min-height:0;height:auto;max-height:none;overflow:visible;overflow-wrap:normal;word-break:normal;box-sizing:border-box;color:' + PDF_EXPORT_TEXT_COLOR + ';'
  const printStyle = document.createElement('style')
  printStyle.textContent = '.pdf-export-surface { background: ' + PDF_EXPORT_BACKGROUND + ' !important; color: ' + PDF_EXPORT_TEXT_COLOR + ' !important; } .pdf-export-surface :is(p,li,td,th,blockquote,pre,code) { color: ' + PDF_EXPORT_TEXT_COLOR + ' !important; } .pdf-export-surface :is(h1,h2,h3,h4,h5,h6) { color: ' + PDF_EXPORT_HEADING_COLOR + ' !important; } .pdf-export-surface a { color: #075985 !important; } .pdf-export-surface th { background: #f3f4f6 !important; }' + PDF_EXPORT_INLINE_CSS + PDF_EXPORT_TABLE_CSS
  mount.append(printStyle, heading, clone)
  compactPdfExportLinks(mount)
  document.body.append(mount)

  const hydratedObjectUrls: string[] = []

  try {
    hydratedObjectUrls.push(...await hydratePdfImages(mount, loadImage))
    await Promise.all([...mount.querySelectorAll<HTMLImageElement>('img')].map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          let settled = false
          const finish = () => {
            if (settled) return
            settled = true
            image.removeEventListener('load', finish)
            image.removeEventListener('error', finish)
            resolve()
          }
          image.addEventListener('load', finish, { once: true })
          image.addEventListener('error', finish, { once: true })
          window.setTimeout(finish, 5000)
        })
      }
      await image.decode().catch(() => undefined)
    }))
    applyPdfHighlightOverlays(mount)
    const canvas = await html2canvas(mount, {
      backgroundColor: PDF_EXPORT_BACKGROUND,
      scale: PDF_EXPORT_SCALE,
      useCORS: false,
      logging: false,
      scrollX: 0,
      scrollY: 0,
      windowWidth: mount.scrollWidth,
      windowHeight: mount.scrollHeight,
    })
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true })
    const mountWidth = Math.max(1, mount.getBoundingClientRect().width)
    const canvasPixelsPerCssPixel = canvas.width / mountWidth
    const linkRects = collectPdfLinkRects(mount).map((rect) => ({
      ...rect,
      left: rect.left * canvasPixelsPerCssPixel,
      top: rect.top * canvasPixelsPerCssPixel,
      width: rect.width * canvasPixelsPerCssPixel,
      height: rect.height * canvasPixelsPerCssPixel,
    }))
    const imageWidth = PDF_PAGE_WIDTH_PT - PDF_PAGE_MARGIN_PT * 2
    const imagePageHeight = PDF_PAGE_HEIGHT_PT - PDF_PAGE_MARGIN_PT * 2
    const sourcePageHeight = Math.max(1, Math.floor(canvas.width * imagePageHeight / imageWidth))
    const avoidRanges = collectPdfAvoidRanges(mount).map((range) => ({
      top: range.top * canvasPixelsPerCssPixel,
      height: range.height * canvasPixelsPerCssPixel,
    }))
    const pages = pageRangesForRenderedDocument(canvas.height, sourcePageHeight, avoidRanges)

    for (const [page, pageRange] of pages.entries()) {
      if (page > 0) pdf.addPage()
      const sourceY = pageRange.top
      const sliceHeight = pageRange.height
      const slice = document.createElement('canvas')
      slice.width = canvas.width
      slice.height = sliceHeight
      const context = slice.getContext('2d')
      if (!context) throw new Error('PDF canvas unavailable')
      context.drawImage(canvas, 0, sourceY, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)
      const renderedHeight = sliceHeight * imageWidth / canvas.width
      pdf.addImage(slice.toDataURL('image/png'), 'PNG', PDF_PAGE_MARGIN_PT, PDF_PAGE_MARGIN_PT, imageWidth, renderedHeight, undefined, 'FAST')
      const pointsPerCanvasPixel = imageWidth / canvas.width
      for (const link of linkRects) {
        for (const segment of pdfLinkSegmentsForPage(link, sourceY, sliceHeight, pointsPerCanvasPixel)) {
          pdf.link(
            PDF_PAGE_MARGIN_PT + segment.x,
            PDF_PAGE_MARGIN_PT + segment.y,
            segment.width,
            segment.height,
            { url: segment.href },
          )
        }
      }
    }
    return new Uint8Array(pdf.output('arraybuffer'))
  } finally {
    hydratedObjectUrls.forEach((objectUrl) => URL.revokeObjectURL(objectUrl))
    mount.remove()
  }
}

export async function exportElementToPdf(
  source: HTMLElement,
  title: string,
  save: (bytes: Uint8Array) => Promise<boolean>,
  loadImage?: PdfImageLoader,
): Promise<boolean> {
  return save(await renderPdfBytes(source, title, loadImage))
}

export async function exportMarkdownDocumentToPdf(
  note: NoteDocument,
  reader: ImageReadPort | undefined,
  files: Pick<FilePort, 'savePdfExport'>,
): Promise<boolean> {
  const snapshot = await prepareMarkdownPrint(note, reader)
  try {
    if (!files.savePdfExport) throw new Error('Direct PDF export is unavailable')
    return await exportElementToPdf(snapshot.element, note.title, (bytes) => files.savePdfExport!(note.id, bytes, note.title))
  } finally {
    snapshot.dispose()
  }
}

export async function exportTypedDocumentToPdf(
  noteId: NoteId,
  title: string,
  source: HTMLElement,
  files: Pick<FilePort, 'savePdfExport'>,
  assetReader?: import('../document/extensions').RichAssetReader,
): Promise<boolean> {
  if (!files.savePdfExport) throw new Error('Direct PDF export is unavailable')
  const loadImage: PdfImageLoader | undefined = assetReader
    ? (relativePath) => assetReader.readImage({ noteId, relativePath })
    : undefined
  return exportElementToPdf(source, title, (bytes) => files.savePdfExport!(noteId, bytes, title), loadImage)
}