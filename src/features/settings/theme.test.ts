import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, DEFAULT_STICKY_SETTINGS, normalizeSettings, normalizeStickySettings, themeVariables } from './theme'

describe('settings theme', () => {
  it('matches the canonical Rust settings defaults', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      theme: 'forest',
      stickyColorMode: 'follow-theme',
      bodyFont: 'KaiTi, STKaiti, serif',
      codeFont: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 16,
      lineHeight: 1.6,
      shortcut: 'CommandOrControl+Shift+D',
      launchAtStartup: false,
      defaultEditorMode: 'source',
      autosaveDelayMs: 500,
      dataRoot: { mode: 'default' },
    })
  })
  it('uses one sticky-note color derived from the forest theme', () => {
    const vars = themeVariables({ ...DEFAULT_APP_SETTINGS, theme: 'forest' })
    expect(vars['--sticky-color']).toBe(vars['--theme-note-accent'])
    expect(Object.keys(vars).some((key) => key.includes('per-note'))).toBe(false)
  })
  it('migrates the previous system default font to the new KaiTi default', () => {
    expect(normalizeSettings({ ...DEFAULT_APP_SETTINGS, bodyFont: 'system-ui, sans-serif' }).bodyFont).toBe('KaiTi, STKaiti, serif')
    expect(normalizeStickySettings({ ...DEFAULT_STICKY_SETTINGS, bodyFont: 'system-ui, sans-serif' }).bodyFont).toBe('KaiTi, STKaiti, serif')
  })

  it('provides distinct complete forest, sand, and system palettes', () => {
    const palettes = (['forest', 'sand', 'system'] as const).map((theme) =>
      themeVariables({ ...DEFAULT_APP_SETTINGS, theme }),
    )
    expect(new Set(palettes.map((palette) => palette['--color-canvas'])).size).toBe(3)
    for (const palette of palettes) {
      expect(palette['--color-text']).toMatch(/^#/)
      expect(palette['--theme-note-accent']).toMatch(/^#/)
    }
  })

  it('maps system theme to the live light or dark system palette', () => {
    const settings = { ...DEFAULT_APP_SETTINGS, theme: 'system' as const }
    expect(themeVariables(settings, 'light')['--color-canvas']).toBe('#edf0f2')
    expect(themeVariables(settings, 'dark')['--color-canvas']).toBe('#101B18')
    expect(themeVariables(settings, 'dark')['--sticky-color']).toBe(themeVariables(settings, 'dark')['--theme-note-accent'])
  })

  it('maps forest, night, and system-dark to the approved tidal paper palette', () => {
    expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'forest' })).toMatchObject({
      '--color-surface': '#F8FAF7',
      '--color-panel-warm': '#EAF0EB',
      '--color-accent-strong': '#2F7866',
      '--color-warm': '#D59A5E',
    })
    expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'night' })).toMatchObject({
      '--color-canvas': '#101B18',
      '--color-surface': '#172621',
      '--color-heading': '#F1F6F3',
    })
    expect(themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'system' }, 'dark')).toMatchObject({
      '--color-surface': '#172621',
    })
  })

  it('provides every main-window color token for each palette', () => {
    const requiredTokens = [
      '--color-canvas', '--color-surface', '--color-panel', '--color-panel-warm',
      '--color-accent', '--color-accent-strong', '--color-accent-strong-hover', '--color-on-accent',
      '--color-accent-soft', '--color-accent-border',
      '--color-accent-haze', '--color-warm', '--color-text', '--color-heading', '--color-muted',
      '--color-muted-light', '--color-error', '--color-on-error', '--color-focus', '--color-focus-soft', '--color-border',
      '--color-border-soft', '--theme-note-accent',
    ]
    for (const theme of ['forest', 'sand', 'night', 'system'] as const) {
      const palette = themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme }, 'dark')
      for (const token of requiredTokens) expect(palette[token]).toBeTruthy()
    }
  })

  it('keeps primary and destructive action text legible in night and system-dark themes', () => {
    const darkPalettes = [
      themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'night' }),
      themeVariables({ ...DEFAULT_STICKY_SETTINGS, theme: 'system' }, 'dark'),
    ]

    for (const palette of darkPalettes) {
      expect(contrastRatio(palette['--color-on-accent'], palette['--color-accent-strong'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(palette['--color-on-accent'], palette['--color-accent-strong-hover'])).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(palette['--color-on-error'], palette['--color-error'])).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('normalizes unsafe numeric values and keeps the sticky color shared', () => {
    expect(normalizeSettings({ ...DEFAULT_APP_SETTINGS, fontSize: 100, lineHeight: 0, autosaveDelayMs: 10 })).toMatchObject({
      fontSize: 28,
      lineHeight: 1.2,
      autosaveDelayMs: 150,
      stickyColorMode: 'follow-theme',
    })
  })
})

function contrastRatio(first: string, second: string) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string) {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}
