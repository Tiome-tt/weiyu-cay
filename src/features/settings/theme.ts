import type { CSSProperties } from 'react'
import type { AppSettings, StickySettings } from '../../domain/ports'
import settingsDefaults from '../../shared/settings-defaults.json'

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = settingsDefaults as AppSettings
export const DEFAULT_NOTE_FONT_SIZE = 16

export const DEFAULT_STICKY_SETTINGS: Readonly<StickySettings> = {
  theme: DEFAULT_APP_SETTINGS.theme,
  stickyColorMode: DEFAULT_APP_SETTINGS.stickyColorMode,
  bodyFont: DEFAULT_APP_SETTINGS.bodyFont,
  codeFont: DEFAULT_APP_SETTINGS.codeFont,
  fontSize: DEFAULT_APP_SETTINGS.fontSize,
  lineHeight: DEFAULT_APP_SETTINGS.lineHeight,
  autosaveDelayMs: DEFAULT_APP_SETTINGS.autosaveDelayMs,
  imageSaveQuality: DEFAULT_APP_SETTINGS.imageSaveQuality,
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
    '--color-ai-keyword': '#315F8C',
    '--color-ai-concept': '#315F8C',
    '--color-ai-mechanism': '#196D70',
    '--color-ai-evidence': '#6F4F91',
    '--color-ai-conclusion': '#276B55',
    '--color-ai-action': '#8A5A19',
    '--color-ai-caveat': '#A44545',
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
    '--color-ai-keyword': '#315F8C',
    '--color-ai-concept': '#315F8C',
    '--color-ai-mechanism': '#196D70',
    '--color-ai-evidence': '#6F4F91',
    '--color-ai-conclusion': '#276B55',
    '--color-ai-action': '#8A5A19',
    '--color-ai-caveat': '#A44545',
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
    '--color-ai-keyword': '#315F8C',
    '--color-ai-concept': '#315F8C',
    '--color-ai-mechanism': '#196D70',
    '--color-ai-evidence': '#6F4F91',
    '--color-ai-conclusion': '#276B55',
    '--color-ai-action': '#8A5A19',
    '--color-ai-caveat': '#A44545',
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
    '--color-ai-keyword': '#9DCBF0',
    '--color-ai-concept': '#9DCBF0',
    '--color-ai-mechanism': '#78CFCE',
    '--color-ai-evidence': '#CEB0EC',
    '--color-ai-conclusion': '#86D2AC',
    '--color-ai-action': '#E5C184',
    '--color-ai-caveat': '#F0A7A0',
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
    searchShortcut: value.searchShortcut || "CommandOrControl+F",
    closeToTray: typeof value.closeToTray === 'boolean' ? value.closeToTray : true,
    closeBehaviorConfirmed: typeof value.closeBehaviorConfirmed === 'boolean' ? value.closeBehaviorConfirmed : false,
    dailyLyrics: value.dailyLyrics !== false,
    showMenuBarIcon: typeof value.showMenuBarIcon === 'boolean' ? value.showMenuBarIcon : true,
    deepseekModel: value.deepseekModel === 'deepseek-v4-pro' ? value.deepseekModel : 'deepseek-flash',
    imageSaveQuality: value.imageSaveQuality === 'webp-q85' || value.imageSaveQuality === 'original' ? value.imageSaveQuality : 'webp-q95',
    bodyFont: normalizeBodyFont(value.bodyFont),
    stickyColorMode: 'follow-theme',
    fontSize: clamp(value.fontSize, 12, 28),
    lineHeight: clamp(value.lineHeight, 1.2, 2.2),
    autosaveDelayMs: clamp(value.autosaveDelayMs, 150, 2_000),
  }
}

export function normalizeStickySettings(value: StickySettings): StickySettings {
  return {
    ...value,
    imageSaveQuality: value.imageSaveQuality === 'webp-q85' || value.imageSaveQuality === 'original' ? value.imageSaveQuality : 'webp-q95',
    bodyFont: normalizeBodyFont(value.bodyFont),
    stickyColorMode: 'follow-theme',
    fontSize: clamp(value.fontSize, 12, 28),
    lineHeight: clamp(value.lineHeight, 1.2, 2.2),
    autosaveDelayMs: clamp(value.autosaveDelayMs, 150, 2_000),
  }
}

export function themeVariables(settings: StickySettings, systemScheme: 'light' | 'dark' = 'light'): ThemeVariables {
  const normalized = normalizeStickySettings(settings)
  const palette = normalized.theme === 'system' ? systemScheme === 'dark' ? systemDarkPalette : whitePalette : normalized.theme === 'ocean' ? oceanPalette : normalized.theme === 'light' ? whitePalette : normalized.theme === 'night' ? systemDarkPalette : palettes[normalized.theme]
  return {
    ...palette,
    '--scrollbar-track': 'transparent',
    '--scrollbar-thumb': palette['--color-accent'],
    '--scrollbar-thumb-hover': palette['--color-accent-strong'],
    '--sticky-color': palette['--theme-note-accent'],
    '--body-font': normalized.bodyFont,
    '--code-font': normalized.codeFont,
    '--app-font-size': String(normalized.fontSize) + 'px',
    '--app-line-height': '1.4',
    '--note-font-size': String(DEFAULT_NOTE_FONT_SIZE) + 'px',
    '--note-line-height': String(normalized.lineHeight),
  }
}

export function themeStyle(settings: StickySettings, systemScheme: 'light' | 'dark' = 'light'): CSSProperties {
  return themeVariables(settings, systemScheme) as CSSProperties
}

const whitePalette = { ...palettes.system, '--color-canvas': '#FFFFFF', '--color-panel': '#FFFFFF', '--color-panel-warm': '#FAFBFC', '--color-accent-strong': '#43545F', '--color-accent-strong-hover': '#33434D', '--color-accent': '#788D9B', '--color-focus': '#43545F', '--color-accent-soft':'#F0F3F5', '--color-accent-border':'#D2DAE0', '--theme-note-accent':'#F4F6F8' }
const oceanPalette = { ...palettes.system, '--color-canvas': '#EAF2F9', '--color-surface': '#F8FBFE', '--color-panel': '#F0F6FB', '--color-panel-warm': '#E2EDF6', '--color-accent': '#619DCA', '--color-accent-strong': '#236B96', '--color-accent-strong-hover': '#19577F', '--color-focus': '#236B96', '--color-text': '#253C4C', '--color-heading': '#183044' }
const systemDarkPalette = { ...palettes.night, '--color-canvas':'#18191C', '--color-surface':'#202124', '--color-panel':'#232427', '--color-panel-warm':'#292A2E', '--color-border':'#484A50', '--color-border-soft':'#34363B', '--color-accent':'#9598A0', '--color-accent-strong':'#C5C7CE', '--color-accent-strong-hover':'#E0E1E6', '--color-on-accent':'#1C1D20', '--color-accent-soft':'#303238', '--color-accent-border':'#4B4D56', '--color-focus':'#B7BBC7', '--color-text':'#E1E2E6', '--color-heading':'#F3F3F5', '--color-muted':'#B1B2BB', '--color-muted-light':'#777983', '--theme-note-accent':'#292A2F', '--color-focus-soft':'rgb(183 187 199 / 18%)', '--color-accent-haze':'rgb(149 152 160 / 18%)' }

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizeBodyFont(value: string) {
  return value
}
