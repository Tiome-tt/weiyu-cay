interface DirectoryRailProps {
  onExpand: () => void
}

export function DirectoryRail({ onExpand }: DirectoryRailProps) {
  return (
    <button
      type="button"
      className="directory-rail"
      style={{ width: '30px' }}
      aria-label="展开目录"
      onClick={onExpand}
    >
      <span aria-hidden="true">目录</span>
    </button>
  )
}
