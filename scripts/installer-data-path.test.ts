import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('exposes initial data-path selection in both Windows installer formats', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))
  expect(config.bundle.windows.nsis.installerHooks).toBe('./windows/hooks.nsh')
  const hook = readFileSync('src-tauri/windows/hooks.nsh', 'utf8')
  expect(hook).toContain('Page custom CayDataPageCreate CayDataPageLeave')
  expect(hook).toContain('nsDialogs::SelectFolderDialog')
  expect(hook).toContain('InstallDataPath')
  expect(hook).not.toMatch(/RMDir\s+\/r/i)
  const wix = readFileSync('src-tauri/windows/main.wxs', 'utf8')
  expect(wix).toContain('Dialog Id="CayDataPathDlg"')
  expect(wix).toContain('Name="InstallDataPath"')
})
