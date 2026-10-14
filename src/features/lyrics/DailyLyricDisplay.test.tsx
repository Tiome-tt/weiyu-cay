import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DailyLyricDisplay } from './DailyLyricDisplay'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('keeps the same poem when width or font metrics change', async () => {
  let measure: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { measure = callback } observe() {} disconnect() {} })
  render(<DailyLyricDisplay enabled />)
  await waitFor(() => expect(screen.getByTestId('daily-lyric')).toHaveTextContent('《'))
  await act(async () => { await import('./dailyLyricsExpanded.json') })
  const before = screen.getByTestId('daily-lyric').textContent
  Object.defineProperty(screen.getByTestId('daily-lyric'), 'clientWidth', { value: 200, configurable: true })
  act(() => measure?.())
  expect(screen.getByTestId('daily-lyric').textContent).toBe(before)
})
it('refreshes at the next local day and keeps the poem within the day', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 9, 12, 23, 59, 30))
  render(<DailyLyricDisplay enabled />)
  await act(async () => { await import('./dailyLyricsExpanded.json') })
  const before = screen.getByTestId('daily-lyric').textContent
  act(() => vi.advanceTimersByTime(60_000))
  const next = screen.getByTestId('daily-lyric').textContent
  expect(next).not.toBe(before)
  act(() => vi.advanceTimersByTime(60_000))
  expect(screen.getByTestId('daily-lyric').textContent).toBe(next)
})
