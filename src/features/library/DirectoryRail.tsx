import {text as uiText} from '../../shared/i18n'
interface DirectoryRailProps {
  onExpand: () => void
}

export function DirectoryRail({ onExpand }: DirectoryRailProps) {
  return (
    <button
      type="button"
      className="directory-rail"
      style={{ width: '30px' }}
      aria-label={uiText("展开目录","Expand outline")}
      onClick={onExpand}
    >
      <span aria-hidden="true">{uiText("目录","Outline")}</span>
    </button>
  )
}
