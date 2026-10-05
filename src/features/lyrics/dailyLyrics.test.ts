import { describe, expect, it } from 'vitest'
import { DAILY_LYRIC_LIBRARY, MAX_DAILY_LYRIC_LENGTH, MAX_DAILY_LYRIC_DISPLAY_LENGTH, dailyLyricDisplayText, dailyLyricForDate, loadExpandedDailyLyrics } from './dailyLyrics'

describe('daily lyrics', () => {
  it('ships the expanded local library', async () => {
    await loadExpandedDailyLyrics()
    expect(DAILY_LYRIC_LIBRARY).toHaveLength(1939)
    expect(DAILY_LYRIC_LIBRARY.every((entry) => entry.text && entry.artist && entry.title)).toBe(true)
    expect(DAILY_LYRIC_LIBRARY.every((entry) => entry.text.length <= MAX_DAILY_LYRIC_LENGTH)).toBe(true)
  })

  it('includes attribution in the length budget and chooses a complete short entry for narrow windows', async () => {
    await loadExpandedDailyLyrics()
    expect(DAILY_LYRIC_LIBRARY.every((entry) => dailyLyricDisplayText(entry).length <= MAX_DAILY_LYRIC_DISPLAY_LENGTH)).toBe(true)
    for (const budget of [19, 26, 32, 40, 48]) {
      const selected = dailyLyricForDate('2026-09-28', budget)
      expect(dailyLyricDisplayText(selected).length).toBeLessThanOrEqual(budget)
      expect(dailyLyricForDate('2026-09-28', budget)).toEqual(selected)
    }
  })

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