import { describe, expect, it } from 'vitest'
import tauriConfig from '../../../src-tauri/tauri.conf.json'
import mainCapability from '../../../src-tauri/capabilities/default.json'
import temporaryCapability from '../../../src-tauri/capabilities/temporary.json'

const MAIN_WINDOW_PERMISSIONS = [
  'core:window:allow-close',
  'core:window:allow-minimize',
  'core:window:allow-toggle-maximize',
  'core:window:allow-start-dragging',
] as const

describe('frameless window capabilities', () => {
  it('authorizes every native operation required by the frameless main window', () => {
    expect(tauriConfig.app.windows[0]).toMatchObject({ decorations: false })
    expect(mainCapability.windows).toEqual(['main'])
    expect(mainCapability.permissions).toEqual(expect.arrayContaining([...MAIN_WINDOW_PERMISSIONS]))
  })

  it('does not grant main-window control permissions to temporary windows', () => {
    expect(temporaryCapability.windows).toEqual(['temporary-*'])
    expect(temporaryCapability.permissions).toContain('core:window:allow-start-dragging')
    for (const permission of [
      'core:window:allow-close',
      'core:window:allow-minimize',
      'core:window:allow-toggle-maximize',
    ]) {
      expect(temporaryCapability.permissions).not.toContain(permission)
    }
  })
})
