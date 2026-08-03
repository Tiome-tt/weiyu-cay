import type { CSSProperties } from 'react'
import type { AppSettings } from '../../domain/ports'

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  theme: 'forest',
  stickyColorMode: 'follow-theme',
  bodyFont: 'Inter, ui-sans-serif, system-ui, sans-serif',
  codeFont: 'ui-monospace, SFMono-Regular, Consolas, monospace',
  fontSize: 16,
  lineHeight: 1.6,
  shortcut: 'Ctrl+Shift+N',
  launchAtStartup: false,
  defaultEditorMode: 'source',
  autosaveDelayMs: 500,
  dataRoot: { mode: 'default' },
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

export function themeVariables(settings: AppSettings): ThemeVariables {
  const normalized = normalizeSettings(settings)
  const palette = palettes[normalized.theme]
  return {
    ...palette,
    '--sticky-color': palette['--theme-note-accent'],
    '--body-font': normalized.bodyFont,
    '--code-font': normalized.codeFont,
    '--body-font-size': `${normalized.fontSize}px`,
    '--body-line-height': String(normalized.lineHeight),
  }
}

export function themeStyle(settings: AppSettings): CSSProperties {
  return themeVariables(settings) as CSSProperties
}

function clamp(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value)) return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
