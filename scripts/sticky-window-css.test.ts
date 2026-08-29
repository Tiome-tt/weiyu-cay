import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appCss = readFileSync('src/styles/app.css', 'utf8')

describe('sticky window visual contracts', () => {
  it('uses a clean surface without a decorative left rail', () => {
    const stickyWindow = cssRule('.sticky-window')
    expect(stickyWindow).not.toMatch(/linear-gradient\(90deg/)
    expect(stickyWindow).toMatch(/background:\s*color-mix\(/)
  })
})

function cssRule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(appCss)
  if (match === null) throw new Error(`missing rule ${selector}`)
  return match[1]
}
