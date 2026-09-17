export interface DailyLyricEntry {
  text: string
  artist: string
  title: string
}

export const DAILY_LYRIC_LIBRARY: readonly DailyLyricEntry[] = [
  // Use short excerpts from classical works in the public domain only.
  { text: '两岸猿声啼不住，轻舟已过万重山', artist: '李白', title: '早发白帝城' },
  { text: '海内存知己，天涯若比邻', artist: '王勃', title: '送杜少府之任蜀州' },
  { text: '会当凌绝顶，一览众山小', artist: '杜甫', title: '望岳' },
  { text: '大漠孤烟直，长河落日圆', artist: '王维', title: '使至塞上' },
  { text: '山重水复疑无路，柳暗花明又一村', artist: '陆游', title: '游山西村' },
  { text: '人生如梦，一尊还酹江月', artist: '苏轼', title: '念奴娇·赤壁怀古' },
  { text: '行到水穷处，坐看云起时', artist: '王维', title: '终南别业' },
  { text: '海上生明月，天涯共此时', artist: '张九龄', title: '望月怀远' },
]

export function localDateKey(date: Date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

export function dailyLyricForDate(date: Date | string = new Date()): DailyLyricEntry {
  const key = typeof date === 'string' ? date : localDateKey(date)
  let hash = 2166136261
  for (const character of key) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return DAILY_LYRIC_LIBRARY[(hash >>> 0) % DAILY_LYRIC_LIBRARY.length]
}