import type { NoteId } from '../../domain/model'
import type { SearchPort } from '../../domain/ports'
import { APP_NAME } from '../../shared/brand'
import { AppIcon } from '../../shared/AppIcon'
import { Icon } from '../../shared/Icon'
import { SearchBox } from '../search/SearchBox'

export type ToolbarSaveState = 'hidden' | 'dirty' | 'saving' | 'saved' | 'error'

export interface GlobalToolbarProps {
  search: SearchPort
  saveState: ToolbarSaveState
  updateAttention: 'none' | 'available' | 'restart-required'
  onSelectResult(noteId: NoteId): void
  onCreateNote(trigger: HTMLButtonElement): void
  onOpenSettings(): void
}

const SAVE_LABELS: Record<Exclude<ToolbarSaveState, 'hidden'>, string> = {
  dirty: '待保存',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败',
}

export function GlobalToolbar({ search, saveState, updateAttention, onSelectResult, onCreateNote, onOpenSettings }: GlobalToolbarProps) {
  return (
    <header className="global-toolbar" role="toolbar" aria-label="全局应用栏">
      <div className="global-toolbar__brand" data-testid="global-toolbar-brand">
        <AppIcon size={26} />
        <strong>{APP_NAME}</strong>
      </div>
      <div className="global-toolbar__search" data-testid="global-toolbar-search">
        <SearchBox search={search} onSelect={onSelectResult} />
      </div>
      <div className="global-toolbar__actions" data-testid="global-toolbar-actions">
        {saveState !== 'hidden' && (
          <span className={`global-toolbar__save global-toolbar__save--${saveState}`} role="status" aria-label="保存状态">
            {SAVE_LABELS[saveState]}
          </span>
        )}
        {updateAttention !== 'none' && (
          <button
            type="button"
            className="global-toolbar__icon-button global-toolbar__update-attention"
            aria-label={updateAttention === 'available' ? '有可用更新，打开设置' : '更新已安装，需要重启，打开设置'}
            title={updateAttention === 'available' ? '有可用更新' : '需要重启以完成更新'}
            onClick={onOpenSettings}
          >
            <span className="global-toolbar__attention-mark" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="global-toolbar__icon-button" aria-label="打开设置" title="设置" onClick={onOpenSettings}>
          <Icon name="settings" size={18} />
        </button>
        <button
          type="button"
          className="global-toolbar__create"
          aria-label="新建笔记"
          onClick={(event) => onCreateNote(event.currentTarget)}
        >
          <Icon name="plus" size={17} />
          <span>新建笔记</span>
        </button>
      </div>
    </header>
  )
}
