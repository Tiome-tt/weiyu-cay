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
    '--color-canvas': '#EEF4EE',
    '--color-surface': '#F8FAF7',
    '--color-panel': '#F3F7F3',
    '--color-panel-warm': '#EAF0EB',
    '--color-accent': '#58A38E',
    '--color-accent-strong': '#2F7866',
    '--color-accent-strong-hover': '#286858',
    '--color-on-accent': '#FFFFFF',
    '--color-accent-soft': '#DCEDE5',
    '--color-accent-border': '#9CC9B9',
    '--color-accent-haze': 'rgb(88 163 142 / 20%)',
    '--color-warm': '#D59A5E',
    '--color-text': '#263A33',
    '--color-heading': '#172621',
    '--color-muted': '#61756D',
    '--color-muted-light': '#84958E',
    '--color-error': '#A94F45',
    '--color-on-error': '#FFFFFF',
    '--color-focus': '#2F7866',
    '--color-focus-soft': 'rgb(47 120 102 / 18%)',
    '--color-border': '#C9D8CF',
    '--color-border-soft': '#DCE7E0',
    '--theme-note-accent': '#D7E9DF',
  },
  sand: {
    '--color-canvas': '#F3E8D3',
    '--color-surface': '#FFFAF0',
    '--color-panel': '#FAF1DF',
    '--color-panel-warm': '#EDDEC4',
    '--color-accent': '#D7AD72',
    '--color-accent-strong': '#946B35',
    '--color-accent-strong-hover': '#805A2B',
    '--color-on-accent': '#FFFFFF',
    '--color-accent-soft': '#F5E4C8',
    '--color-accent-border': '#DFBF8C',
    '--color-accent-haze': 'rgb(215 173 114 / 24%)',
    '--color-warm': '#D59A5E',
    '--color-text': '#463B2E',
    '--color-heading': '#30271E',
    '--color-muted': '#756959',
    '--color-muted-light': '#988B78',
    '--color-error': '#A94F45',
    '--color-on-error': '#FFFFFF',
    '--color-focus': '#946B35',
    '--color-focus-soft': 'rgb(148 107 53 / 18%)',
    '--color-border': '#D9C7AA',
    '--color-border-soft': '#E6D6BD',
    '--theme-note-accent': '#F6DFB5',
  },
  system: {
    '--color-canvas': '#edf0f2',
    '--color-surface': '#FFFFFF',
    '--color-panel': '#F7F8F9',
    '--color-panel-warm': '#E9EDF0',
    '--color-accent': '#91B6C4',
    '--color-accent-strong': '#47788A',
    '--color-accent-strong-hover': '#3C6979',
    '--color-on-accent': '#FFFFFF',
    '--color-accent-soft': '#DCEBF0',
    '--color-accent-border': '#B3D0DA',
    '--color-accent-haze': 'rgb(145 182 196 / 24%)',
    '--color-warm': '#D59A5E',
    '--color-text': '#343B40',
    '--color-heading': '#20272B',
    '--color-muted': '#687178',
    '--color-muted-light': '#8B959A',
    '--color-error': '#A94F45',
    '--color-on-error': '#FFFFFF',
    '--color-focus': '#47788A',
    '--color-focus-soft': 'rgb(71 120 138 / 18%)',
    '--color-border': '#C7D0D4',
    '--color-border-soft': '#DCE2E5',
    '--theme-note-accent': '#DEEDF1',
  },
  night: {
    '--color-canvas': '#101B18',
    '--color-surface': '#172621',
    '--color-panel': '#14221E',
    '--color-panel-warm': '#1D302A',
    '--color-accent': '#58A38E',
    '--color-accent-strong': '#75BEA8',
    '--color-accent-strong-hover': '#69B09B',
    '--color-on-accent': '#172621',
    '--color-accent-soft': '#203C34',
    '--color-accent-border': '#3A6559',
    '--color-accent-haze': 'rgb(88 163 142 / 22%)',
    '--color-warm': '#D59A5E',
    '--color-text': '#D8E6DE',
    '--color-heading': '#F1F6F3',
    '--color-muted': '#ABC0B6',
    '--color-muted-light': '#8DA59A',
    '--color-error': '#E89C8E',
    '--color-on-error': '#172621',
    '--color-focus': '#8BCFBB',
    '--color-focus-soft': 'rgb(139 207 187 / 22%)',
    '--color-border': '#315349',
    '--color-border-soft': '#29443C',
    '--theme-note-accent': '#24483E',
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

const systemDarkPalette = palettes.night

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
