export const RICH_FONT_FAMILY_OPTIONS = [
  { value: 'body', label: '正文楷体', css: '"楷体", KaiTi, "STKaiti", "Segoe UI Variable", "PingFang SC", "Microsoft YaHei UI", sans-serif' },
  { value: 'sans', label: '无衬线', css: '"Microsoft YaHei UI", "PingFang SC", "Segoe UI Variable", sans-serif' },
  { value: 'serif', label: '宋体衬线', css: '"Noto Serif SC", "Songti SC", SimSun, serif' },
  { value: 'mono', label: '等宽', css: 'ui-monospace, SFMono-Regular, Consolas, monospace' },
] as const

export const RICH_FONT_SIZE_OPTIONS = [
  { value: 'small', label: '小号', css: '0.875em' },
  { value: 'normal', label: '标准', css: '1em' },
  { value: 'large', label: '大号', css: '1.25em' },
  { value: 'xlarge', label: '特大', css: '1.5em' },
] as const

export type RichFontFamily = typeof RICH_FONT_FAMILY_OPTIONS[number]['value']
export type RichFontSize = string

export const RICH_FONT_SIZE_SUGGESTIONS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72, 96] as const

const LEGACY_FONT_SIZE_POINTS: Readonly<Record<string, number>> = { small: 9, normal: 11, large: 14, xlarge: 17 }

export function richFontFamilyCss(value: unknown): string | undefined {
  return RICH_FONT_FAMILY_OPTIONS.find((option) => option.value === value)?.css
}

export function richFontSizePoints(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const legacy = LEGACY_FONT_SIZE_POINTS[value]
  if (legacy !== undefined) return legacy
  const points = Number(value)
  return Number.isInteger(points) && points >= 8 && points <= 96 ? points : undefined
}

export function richFontSizeCss(value: unknown): string | undefined {
  const points = richFontSizePoints(value)
  return points === undefined ? undefined : points + 'pt'
}

export function isRichFontFamily(value: unknown): value is RichFontFamily {
  return RICH_FONT_FAMILY_OPTIONS.some((option) => option.value === value)
}

export function isRichFontSize(value: unknown): value is RichFontSize {
  return richFontSizePoints(value) !== undefined
}