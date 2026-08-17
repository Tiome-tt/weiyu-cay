interface DirectoryRailProps {
  count: number | null
  onExpand: () => void
}

export function DirectoryRail({ count, onExpand }: DirectoryRailProps) {
  const label = count === null ? '展开目录' : `展开目录，${count} 篇笔记`
  return (
    <button
      type="button"
      className="directory-rail"
      style={{ width: '30px' }}
      aria-label={label}
      onClick={onExpand}
    >
      <span aria-hidden="true">{count === null ? '目录' : `目录 · ${count}`}</span>
    </button>
  )
}
