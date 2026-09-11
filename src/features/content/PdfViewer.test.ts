import { describe, expect, it } from 'vitest'
import { adjustPdfScale, PDF_SCALE_STEPS } from './PdfViewer'

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

