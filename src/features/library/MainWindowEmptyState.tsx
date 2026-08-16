import { Icon } from '../../shared/Icon'

interface MainWindowEmptyStateProps {
  onCreateNote(): void
}

/** Quiet invitation shown only when the formal-note workspace has no open document. */
export function MainWindowEmptyState({ onCreateNote }: MainWindowEmptyStateProps) {
  return (
    <div className="main-window-empty-state">
      <svg
        aria-hidden="true"
        className="main-window-empty-state__island"
        data-testid="empty-island"
        fill="none"
        viewBox="0 0 176 112"
      >
        <path className="main-window-empty-state__star" d="m137 17 2.5 5.7 5.8 2.4-5.8 2.5-2.5 5.7-2.4-5.7-5.8-2.5 5.8-2.4Z" />
        <path className="main-window-empty-state__hill" d="M41 72c8-24 26-37 48-37 24 0 42 13 50 37" />
        <path className="main-window-empty-state__shore" d="M31 73c16-5 35-7 57-7 23 0 43 2 58 7-9 13-29 20-58 20-27 0-47-7-57-20Z" />
        <path className="main-window-empty-state__wave" d="M21 89c13-4 25-4 38 0s25 4 38 0 25-4 38 0 25 4 38 0" />
        <path className="main-window-empty-state__wave main-window-empty-state__wave--lower" d="M34 101c10-3 20-3 30 0s20 3 30 0 20-3 30 0 20 3 30 0" />
      </svg>
      <div className="main-window-empty-state__copy">
        <h2>每个念头，都是一座小岛。</h2>
        <p>写下此刻的念头，内容会自动保存在本地。</p>
      </div>
      <button type="button" className="main-window-empty-state__action" onClick={onCreateNote}>
        <Icon name="plus" size={17} />
        新建笔记
      </button>
    </div>
  )
}
