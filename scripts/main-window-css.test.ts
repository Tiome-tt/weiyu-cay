import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainWindowCss = readFileSync('src/styles/main-window.css', 'utf8')
const tokensCss = readFileSync('src/styles/tokens.css', 'utf8')

describe('main window layout contracts', () => {
  it('reserves the flexible editor track for the document and keeps the toolbar slim', () => {
    expect(mainWindowCss).toMatch(/\.main-window \.editor-pane\s*{[^}]*grid-template-areas:\s*"toolbar"\s*"notices"\s*"document"\s*"backlinks"/s)
    expect(mainWindowCss).toMatch(/grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto/)
    expect(mainWindowCss).toMatch(/\.main-window \.editor-document\s*{[^}]*grid-area:\s*document/s)
    expect(mainWindowCss).toMatch(/\.main-window \.editor-toolbar\s*{[^}]*height:\s*44px/s)
    expect(mainWindowCss).not.toContain('.editor-toolbar__secondary')
    expect(mainWindowCss).toMatch(/\.main-window \.editor-actions-menu__popover\s*{[^}]*position:\s*absolute[^}]*max-height:/s)
    expect(mainWindowCss).not.toMatch(/scrollbar-width:\s*none/)
  })

  it('keeps the more-actions popover inside the 420px editor boundary even with save status present', () => {
    const anchor = cssRule('.main-window .editor-actions-menu')
    const popover = cssRule('.main-window .editor-actions-menu__popover')
    expect(anchor).toMatch(/position:\s*static/)

    const rightInset = pixels(popover, /right:\s*(\d+)px/, 'right inset')
    const widthCap = pixels(popover, /width:\s*min\((\d+)px/, 'width cap')
    const horizontalAllowance = pixels(popover, /calc\(100%\s*-\s*(\d+)px\)/, 'horizontal allowance')
    const editorWidth = 420
    const usedWidth = Math.min(widthCap, editorWidth - horizontalAllowance)
    const leftEdge = editorWidth - rightInset - usedWidth

    expect(leftEdge).toBeGreaterThanOrEqual(0)
    expect(leftEdge + usedWidth).toBeLessThanOrEqual(editorWidth)
    expect(mainWindowCss).toMatch(/\.main-window \.editor-toolbar\s*{[^}]*position:\s*relative/s)
    expect(mainWindowCss).toMatch(/\.main-window \.split-pane__pane\s*{[^}]*overflow:\s*hidden/s)
  })

  it('uses a light-theme timestamp color with at least 4.5 to 1 contrast', () => {
    const foreground = token('--color-muted')
    const background = token('--color-panel')
    expect(mainWindowCss).toMatch(/\.main-window \.note-card time\s*{[^}]*color:\s*var\(--color-muted\)/s)
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
  })
})

function token(name: string) {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(tokensCss)
  if (match === null) throw new Error(`missing token ${name}`)
  return match[1]
}

function cssRule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(mainWindowCss)
  if (match === null) throw new Error(`missing rule ${selector}`)
  return match[1]
}

function pixels(rule: string, pattern: RegExp, label: string) {
  const match = pattern.exec(rule)
  if (match === null) throw new Error(`missing ${label}`)
  return Number(match[1])
}

function contrast(foreground: string, background: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
    const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722
  }
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}
