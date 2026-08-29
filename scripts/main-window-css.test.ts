import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainWindowCss = readFileSync('src/styles/main-window.css', 'utf8')
const appCss = readFileSync('src/styles/app.css', 'utf8')
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

  it('gives every application scrollbar a warm sage treatment', () => {
    expect(tokensCss).toMatch(/--scrollbar-thumb:\s*color-mix\(/)
    expect(appCss).toMatch(/\.app-shell\s*,\s*\.app-shell \*\s*{[^}]*scrollbar-color:\s*var\(--scrollbar-thumb\)\s+var\(--scrollbar-track\)[^}]*scrollbar-width:\s*thin/s)
    expect(appCss).toMatch(/\.app-shell \*::-webkit-scrollbar\s*{[^}]*width:\s*8px[^}]*height:\s*8px/s)
    expect(appCss).toMatch(/\.app-shell \*::-webkit-scrollbar-thumb\s*{[^}]*background:\s*var\(--scrollbar-thumb\)[^}]*border:\s*2px solid var\(--scrollbar-track\)[^}]*border-radius:\s*999px/s)
    expect(appCss).toMatch(/\.app-shell \*::-webkit-scrollbar-thumb:hover\s*{[^}]*background:\s*var\(--scrollbar-thumb-hover\)/s)
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

  it('aligns title, source, and preview on one non-card 780px document measure', () => {
    expect(tokensCss).toMatch(/--document-measure:\s*780px/)

    const heading = cssRule('.main-window .editor-document-heading')
    const source = cssRule('.main-window .markdown-source .cm-content')
    const preview = cssRule('.main-window .markdown-preview__page')
    for (const rule of [heading, source, preview]) {
      expect(rule).toMatch(/width:\s*min\(100%,\s*var\(--document-measure\)\)/)
      expect(rule).toMatch(/margin(?:-inline)?:\s*(?:0\s+)?auto/)
    }

    const surface = cssRule('.main-window .editor-document')
    expect(surface).toMatch(/--document-inline-padding:\s*clamp\(24px,\s*4vw,\s*48px\)/)
    expect(surface).toMatch(/background:\s*color-mix\([^;]+var\(--color-surface\)[^;]+var\(--color-warm\)/)
    expect(surface).not.toMatch(/(?:border-radius|box-shadow):/)

    expect(cssRule('.main-window .markdown-source .cm-scroller')).toMatch(/scrollbar-gutter:\s*stable both-edges/)
    expect(cssRule('.main-window .markdown-preview')).toMatch(/scrollbar-gutter:\s*stable both-edges/)
  })

  it('keeps the block handle in a dedicated gutter outside the document text', () => {
    const handle = cssRule('.main-window .markdown-block-handle')
    expect(handle).toMatch(/left:\s*calc\([^;]*var\(--document-measure\)[^;]*var\(--document-inline-padding\)[^;]*var\(--document-gutter\)/)
    expect(handle).toMatch(/transform:\s*translateX\(-100%\)/)
    expect(mainWindowCss).toMatch(/--document-gutter:\s*\d+px/)

    expect(mainWindowCss).toMatch(
      /@media \(max-width:\s*720px\)[\s\S]*?\.main-window \.editor-document-heading,[\s\S]*?\.main-window \.markdown-source \.cm-content,[\s\S]*?\.main-window \.markdown-preview__page\s*{[^}]*padding-right:\s*32px;[^}]*padding-left:\s*32px;/,
    )
    expect(mainWindowCss).toMatch(
      /@media \(max-width:\s*720px\)[\s\S]*?\.main-window \.markdown-block-handle\s*{[^}]*left:\s*4px;[^}]*transform:\s*none;/,
    )
  })

  it('gives the title and last-edited metadata their own document header rhythm', () => {
    const heading = cssRule('.main-window .editor-document-heading')
    const meta = cssRule('.main-window .editor-document-heading__meta')
    expect(heading).toMatch(/padding-bottom:\s*clamp\(/)
    expect(heading).toMatch(/border-bottom:\s*1px solid/)
    expect(meta).toMatch(/margin-top:\s*\d+px/)
    expect(meta).toMatch(/color:\s*var\(--color-muted\)/)
    expect(meta).toMatch(/font-size:\s*\.\d+rem/)
  })

  it('starts editable and preview content on the same calm reading baseline', () => {
    const source = cssRule('.main-window .markdown-source .cm-content')
    const preview = cssRule('.main-window .markdown-preview__page')
    expect(source).toMatch(/min-width:\s*min\(100%,\s*var\(--document-measure\)\)/)
    expect(source).toMatch(/flex-grow:\s*0/)
    for (const rule of [source, preview]) {
      expect(rule).toMatch(/padding-top:\s*clamp\(18px,\s*2\.8vh,\s*26px\)/)
      expect(rule).toMatch(/padding-right:\s*var\(--document-inline-padding\)/)
      expect(rule).toMatch(/padding-left:\s*var\(--document-inline-padding\)/)
    }
  })

  it('styles live Markdown as document content with visible focus and bounded overflow', () => {
    expect(cssRule('.main-window .markdown-source .cm-live-strong')).toMatch(/font-weight:\s*7\d\d/)
    expect(cssRule('.main-window .markdown-source .cm-live-emphasis')).toMatch(/font-style:\s*italic/)
    expect(cssRule('.main-window .markdown-source .cm-live-strikethrough')).toMatch(/text-decoration:\s*line-through/)
    expect(cssRule('.main-window .markdown-source .cm-live-link')).toMatch(/color:\s*var\(--color-accent-strong\)/)
    expect(cssRule('.main-window .markdown-source .cm-live-list-marker')).toMatch(/display:\s*inline-block/)
    expect(cssRule('.main-window .markdown-source .cm-live-task-checkbox')).toMatch(/accent-color:\s*var\(--color-accent-strong\)/)
    expect(cssRule('.main-window .markdown-source .cm-live-divider')).toMatch(/border-top:\s*1px solid var\(--color-border\)/)
    expect(cssRule('.main-window .markdown-source .cm-live-image')).toMatch(/max-width:\s*100%/)
    expect(cssRule('.main-window .markdown-source .cm-live-image img')).toMatch(/max-width:\s*100%/)
    expect(cssRule('.main-window .markdown-source .cm-live-table')).toMatch(/overflow-x:\s*auto/)
    expect(cssRule('.main-window .markdown-source .cm-live-table table')).toMatch(/border-collapse:\s*collapse/)
    expect(cssRule('.main-window .markdown-source .cm-live-table-continuation')).toMatch(/height:\s*0/)
    expect(mainWindowCss).toMatch(/\.cm-live-(?:image|table):focus-visible[^}]*outline:/s)
  })

  it('keeps readable column widths and lets wide tables overflow horizontally', () => {
    const table = cssRule('.main-window .markdown-source .cm-live-table table')
    const cells = cssRule('.main-window .markdown-source .cm-live-table th,\n.main-window .markdown-source .cm-live-table td')

    expect(table).toMatch(/width:\s*100%/)
    expect(table).toMatch(/min-width:\s*100%/)
    expect(table).toMatch(/table-layout:\s*auto/)
    expect(table).not.toMatch(/min-width:\s*max-content/)
    expect(cells).toMatch(/min-width:\s*112px/)
    expect(cells).toMatch(/white-space:\s*nowrap/)
  })

  it('keeps the floating table toolbar from reserving a blank block above the table', () => {
    expect(mainWindowCss).not.toMatch(/\.main-window \.markdown-source \.cm-live-table--active\s*\{[^}]*padding-top:/s)
  })

  it('animates folder branches while collapsed content stays non-interactive', () => {
    const branch = cssRule('.main-window .folder-tree__list ul[data-folder-parent-id]')
    const notes = cssRule('.main-window .folder-tree__folder-notes')

    expect(branch).toMatch(/max-height:\s*\d+px/)
    expect(branch).toMatch(/transition:\s*max-height[^;]*opacity/)
    expect(notes).toMatch(/max-height:\s*\d+px/)
    expect(notes).toMatch(/transition:\s*max-height[^;]*opacity/)
    expect(mainWindowCss).toMatch(/\[data-collapsed="true"\][\s\S]*?max-height:\s*0[;\s\S]*?pointer-events:\s*none/)
  })

  it('keeps inline folder-note deletion available on hover or focus', () => {
    const inlineDelete = cssRule('.main-window .folder-tree__folder-notes .note-list__delete,\n.main-window .folder-tree__root-notes .note-list__delete')
    expect(inlineDelete).toMatch(/display:\s*block/)
    expect(inlineDelete).toMatch(/pointer-events:\s*none/)
    expect(mainWindowCss).toMatch(/\.folder-tree__folder-notes \.note-list__row:hover > \.note-list__delete[\s\S]*?pointer-events:\s*auto/s)
  })

  it('uses a compact right/down disclosure marker for expandable folders', () => {
    const disclosure = cssRule('.main-window .folder-tree__disclosure')
    expect(disclosure).toMatch(/border-right:/)
    expect(disclosure).toMatch(/border-bottom:/)
    expect(disclosure).toMatch(/transform:\s*rotate\(-45deg\)/)
    expect(mainWindowCss).toMatch(/\.folder-tree__disclosure\[data-expanded="true"\]\s*{[^}]*transform:\s*rotate\(45deg\)/s)
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
