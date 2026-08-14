interface DirectoryRailProps {
  count: number
  onExpand: () => void
}

export function DirectoryRail({ count, onExpand }: DirectoryRailProps) {
  return (
    <button
      type="button"
      className="directory-rail"
      style={{ width: '30px' }}
      aria-label={`展开目录，${count} 篇笔记`}
      onClick={onExpand}
    >
      <span aria-hidden="true">目录 · {count}</span>
    </button>
  )
}
