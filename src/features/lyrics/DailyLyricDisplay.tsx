import { useEffect, useState } from 'react'
import { dailyLyricForDate, loadExpandedDailyLyrics, localDateKey } from './dailyLyrics'

export function DailyLyricDisplay({ enabled }: { enabled: boolean }) {
  const [dateKey, setDateKey] = useState(() => localDateKey())
  const [libraryLoaded, setLibraryLoaded] = useState(false)

  useEffect(() => {
    if (!enabled) return
    let active = true
    void loadExpandedDailyLyrics().then(
      () => { if (active) setLibraryLoaded(true) },
      () => { if (active) setLibraryLoaded(true) },
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
  if (!libraryLoaded) return <div className="daily-lyric" data-testid="daily-lyric" role="note" aria-label="每日歌词" aria-busy="true" />
  const lyric = dailyLyricForDate(dateKey)
  return (
    <div className="daily-lyric" data-testid="daily-lyric" role="note" aria-label="每日歌词" title={`“${lyric.text}” —— ${lyric.artist}《${lyric.title}》`}>
      <span className="daily-lyric__text">“{lyric.text}”</span>
      <cite>—— {lyric.artist}《{lyric.title}》</cite>
    </div>
  )
}
