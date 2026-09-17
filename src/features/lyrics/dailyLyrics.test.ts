import { describe, expect, it } from 'vitest'
import { DAILY_LYRIC_LIBRARY, dailyLyricForDate } from './dailyLyrics'

describe('daily lyrics', () => {
  it('chooses a stable library entry for the same local date', () => {
    const first = dailyLyricForDate('2026-09-14')
    const second = dailyLyricForDate('2026-09-14')

    expect(first).toEqual(second)
    expect(DAILY_LYRIC_LIBRARY).toContainEqual(first)
  })

  it('changes the selection when the date hash moves to another entry', () => {
    const selections = new Set(
      Array.from({ length: DAILY_LYRIC_LIBRARY.length * 4 }, (_, index) =>
        dailyLyricForDate(`2026-09-${String(index + 1).padStart(2, '0')}`).text,
      ),
    )

    expect(selections.size).toBeGreaterThan(1)
  })
})