import { useEffect, useState } from 'react'
import { dailyLyricForDate, localDateKey } from './dailyLyrics'

export function DailyLyricDisplay({ enabled }: { enabled: boolean }) {
  const [dateKey, setDateKey] = useState(() => localDateKey())

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
  const lyric = dailyLyricForDate(dateKey)
  return (
    <div className="daily-lyric" data-testid="daily-lyric" role="note" aria-label="每日歌词">
      <span className="daily-lyric__text">“{lyric.text}”</span>
      <cite>—— {lyric.artist}《{lyric.title}》</cite>
    </div>
  )
}