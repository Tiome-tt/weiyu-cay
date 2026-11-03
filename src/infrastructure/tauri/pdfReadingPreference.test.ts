import { expect, it, vi } from 'vitest'
import { note } from '../../test/fakes'

const store = vi.hoisted(() => ({ set: vi.fn().mockResolvedValue(undefined), save: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/plugin-store', () => ({ LazyStore: class { set = store.set; save = store.save } }))
import { createTauriPorts } from './ports'

it('flushes PDF reading preferences to disk before the save resolves', async () => {
  const { system } = createTauriPorts()
  const key = `pdf-reading:${note('').id}` as const
  const position = { page: 4, scale: 3, scrollTop: 420, scrollLeft: 0 }
  await system.setWindowPreference(key, position)
  expect(store.set).toHaveBeenCalledWith(key, position)
  expect(store.save).toHaveBeenCalledOnce()
})
