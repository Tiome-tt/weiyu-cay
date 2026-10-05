import { describe, expect, it } from 'vitest'
import { installBrowserDefaultGuards } from './browserDefaults'

describe('desktop browser defaults', () => {
  it('blocks native menus and browser accelerators without stopping application handlers', () => {
    const release = installBrowserDefaultGuards(document)
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    document.dispatchEvent(context)
    expect(context.defaultPrevented).toBe(true)
    for (const options of [{ key: 'f', ctrlKey: true }, { key: 'f', metaKey: true }, { key: 'r', ctrlKey: true }, { key: 'p', ctrlKey: true }, { key: 's', ctrlKey: true }, { key: 'F5' }, { key: 'F3' }]) {
      const event = new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true })
      document.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    const copy = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true })
    document.dispatchEvent(copy)
    expect(copy.defaultPrevented).toBe(false)
    release()
    const restored = new MouseEvent('contextmenu', { cancelable: true })
    document.dispatchEvent(restored)
    expect(restored.defaultPrevented).toBe(false)
  })
})
