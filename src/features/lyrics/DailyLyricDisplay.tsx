import { useEffect, useRef, useState } from 'react'
import { dailyLyricForDate, loadExpandedDailyLyrics, localDateKey, MAX_DAILY_LYRIC_DISPLAY_LENGTH } from './dailyLyrics'

export function DailyLyricDisplay({ enabled }: { enabled: boolean }) {
  const container = useRef<HTMLDivElement>(null)
  const [displayBudget, setDisplayBudget] = useState(MAX_DAILY_LYRIC_DISPLAY_LENGTH)
  useEffect(() => {
    const element = container.current
    if (!enabled || element === null || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const size = Number.parseFloat(getComputedStyle(element).fontSize)
      if (element.clientWidth > 0 && size > 0) {
        // Budget every displayed character as a full-width glyph, including attribution.
        setDisplayBudget(Math.max(19, Math.floor((element.clientWidth - 24) / size)))
      }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [enabled])
  const [dateKey, setDateKey] = useState(() => localDateKey())
  const [, setLibraryLoaded] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void loadExpandedDailyLyrics().then(
      () => { if (active) setLibraryLoaded(true) },
      () => undefined,
    )
    return () => { active = false }
  }, [enabled])

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDateKey((current) => {
        const next = localDateKey()
        return current === next ? current : next
      })
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!enabled) return null
  const lyric = dailyLyricForDate(dateKey, displayBudget)
  return (
    <div ref={container} className="daily-lyric" data-testid="daily-lyric" role="note" aria-label="每日歌词">
      <span className="daily-lyric__text">“{lyric.text}”</span>
      <cite>—— {lyric.artist}《{lyric.title}》</cite>
    </div>
  )
}