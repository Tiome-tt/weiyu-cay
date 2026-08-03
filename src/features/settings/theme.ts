import type { CSSProperties } from 'react'
import type { AppSettings, StickySettings } from '../../domain/ports'
import settingsDefaults from '../../shared/settings-defaults.json'

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = settingsDefaults as AppSettings
export const DEFAULT_STICKY_SETTINGS: Readonly<StickySettings> = {
  theme: DEFAULT_APP_SETTINGS.theme,
  stickyColorMode: DEFAULT_APP_SETTINGS.stickyColorMode,
  bodyFont: DEFAULT_APP_SETTINGS.bodyFont,
  codeFont: DEFAULT_APP_SETTINGS.codeFont,
  fontSize: DEFAULT_APP_SETTINGS.fontSize,
  lineHeight: DEFAULT_APP_SETTINGS.lineHeight,
  autosaveDelayMs: DEFAULT_APP_SETTINGS.autosaveDelayMs,
}

const palettes = {
  forest: {
    '--color-canvas': '#f7f1e5',
    '--color-surface': '#fffdf8',
    '--color-panel': '#fbf8f0',
    '--color-panel-warm': '#f2eadb',
    '--color-accent': '#8dc9ac',
    '--color-accent-strong': '#4d9272',
    '--color-accent-soft': '#dceee3',
    '--color-accent-border': '#afd4bd',
    '--color-accent-haze': 'rgb(141 201 172 / 24%)',
    '--color-text': '#403b34',
    '--color-heading': '#292f29',
    '--color-muted': '#6d6a60',
    '--color-border-soft': '#e6ddcf',
    '--theme-note-accent': '#e5f0d6',
  },
  sand: {
    '--color-canvas': '#f3e8d3',
    '--color-surface': '#fffaf0',
    '--color-panel': '#faf1df',
    '--color-panel-warm': '#eddec4',
    '--color-accent': '#d7ad72',
    '--color-accent-strong': '#946b35',
    '--color-accent-soft': '#f5e4c8',
    '--color-accent-border': '#dfbf8c',
    '--color-accent-haze': 'rgb(215 173 114 / 24%)',
    '--color-text': '#463b2e',
    '--color-heading': '#30271e',
    '--color-muted': '#756959',
    '--color-border-soft': '#e6d6bd',
    '--theme-note-accent': '#f6dfb5',
  },
  system: {
    '--color-canvas': '#edf0f2',
    '--color-surface': '#ffffff',
    '--color-panel': '#f7f8f9',
    '--color-panel-warm': '#e9edf0',
    '--color-accent': '#91b6c4',
    '--color-accent-strong': '#47788a',
    '--color-accent-soft': '#dcebf0',
    '--color-accent-border': '#b3d0da',
    '--color-accent-haze': 'rgb(145 182 196 / 24%)',
    '--color-text': '#343b40',
    '--color-heading': '#20272b',
    '--color-muted': '#687178',
    '--color-border-soft': '#dce2e5',
    '--theme-note-accent': '#deedf1',
  },
} as const

export type ThemeVariables = Record<string, string>

export function normalizeSettings(value: AppSettings): AppSettings {
  return {
    ...value,
    stickyColorMode: 'follow-theme',
    fontSize: clamp(value.fontSize, 12, 28),
    lineHeight: clamp(value.lineHeight, 1.2, 2.2),
    autosaveDelayMs: clamp(value.autosaveDelayMs, 150, 2_000),
  }
}

export function normalizeStickySettings(value: StickySettings): StickySettings {
  return {
    ...value,
    stickyColorMode: 'follow-theme',
    fontSize: clamp(value.fontSize, 12, 28),
    lineHeight: clamp(value.lineHeight, 1.2, 2.2),
    autosaveDelayMs: clamp(value.autosaveDelayMs, 150, 2_000),
  }
}

export function themeVariables(settings: StickySettings, systemScheme: 'light' | 'dark' = 'light'): ThemeVariables {
  const normalized = normalizeStickySettings(settings)
  const palette = normalized.theme === 'system' && systemScheme === 'dark' ? systemDarkPalette : palettes[normalized.theme]
  return {
    ...palette,
    '--sticky-color': palette['--theme-note-accent'],
    '--body-font': normalized.bodyFont,
    '--code-font': normalized.codeFont,
    '--body-font-size': `${normalized.fontSize}px`,
    '--body-line-height': String(normalized.lineHeight),
  }
}

export function themeStyle(settings: StickySettings, systemScheme: 'light' | 'dark' = 'light'): CSSProperties {
  return themeVariables(settings, systemScheme) as CSSProperties
}

const systemDarkPalette = {
  '--color-canvas': '#202729', '--color-surface': '#293033', '--color-panel': '#252c2e',
  '--color-panel-warm': '#333d40', '--color-accent': '#78aeba', '--color-accent-strong': '#9ac8d2',
  '--color-accent-soft': '#324a50', '--color-accent-border': '#496b73', '--color-accent-haze': 'rgb(120 174 186 / 18%)',
  '--color-text': '#e4e9e8', '--color-heading': '#f5f8f7', '--color-muted': '#b5c0bf',
  '--color-border-soft': '#414b4e', '--theme-note-accent': '#354d51',
} as const

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
