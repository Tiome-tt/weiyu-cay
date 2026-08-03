import { describe, expect, it } from 'vitest'
import { DEFAULT_APP_SETTINGS, normalizeSettings, themeVariables } from './theme'

describe('settings theme', () => {
  it('matches the canonical Rust settings defaults', () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      theme: 'forest',
      stickyColorMode: 'follow-theme',
      bodyFont: 'system-ui, sans-serif',
      codeFont: 'ui-monospace, SFMono-Regular, Consolas, monospace',
      fontSize: 16,
      lineHeight: 1.6,
      shortcut: 'CommandOrControl+Shift+Space',
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
    expect(themeVariables(settings, 'dark')['--color-canvas']).toBe('#202729')
    expect(themeVariables(settings, 'dark')['--sticky-color']).toBe(themeVariables(settings, 'dark')['--theme-note-accent'])
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
