import {text} from '../../shared/i18n'
import type { NoteId } from '../../domain/model'
import type { SearchPort } from '../../domain/ports'
import { APP_NAME } from '../../shared/brand'
import { AppIcon } from '../../shared/AppIcon'
import { Icon } from '../../shared/Icon'
import { SearchBox } from '../search/SearchBox'

export type ToolbarSaveState = 'hidden' | 'dirty' | 'saving' | 'saved' | 'error'

export interface GlobalToolbarProps {
  compact?: boolean
  search: SearchPort
  searchDismissSignal: number
  saveState: ToolbarSaveState
  updateAttention: 'none' | 'available' | 'restart-required'
  onSelectResult(noteId: NoteId): void
  onOpenSettings(): void
}

const SAVE_LABELS: Record<Exclude<ToolbarSaveState, 'hidden'>, string> = {
  dirty: text('待保存','Unsaved'),
  saving: text('保存中…','Saving…'),
  saved: text('已保存','Saved'),
  error: text('保存失败','Save failed'),
}

export function GlobalToolbar({ compact = false, search, searchDismissSignal, saveState, updateAttention, onSelectResult, onOpenSettings }: GlobalToolbarProps) {
  return (
    <header className={compact ? "global-toolbar global-toolbar--compact" : "global-toolbar"} role="toolbar" aria-label={text('全局应用栏','Application toolbar')}>
      {!compact && <div className="global-toolbar__brand" data-testid="global-toolbar-brand">
        <AppIcon size={26} />
        <strong>{APP_NAME}</strong>
      </div>}
      {!compact && <div className="global-toolbar__search" data-testid="global-toolbar-search">
        <SearchBox search={search} onSelect={onSelectResult} dismissSignal={searchDismissSignal} />
      </div>}
      <div className="global-toolbar__actions" data-testid="global-toolbar-actions">
        {!compact && saveState !== 'hidden' && (
                    <div aria-label={text('全局保存状态','Global save status')} className={'global-toolbar__save global-toolbar__save--' + saveState}>
            <span role="status" aria-label={text('保存状态','Save status')}>{SAVE_LABELS[saveState]}</span>
          </div>
        )}
        {updateAttention !== 'none' && (
          <button
            type="button"
            className="global-toolbar__icon-button global-toolbar__update-attention"
            aria-label={updateAttention === 'available' ? text('有可用更新，打开设置','Update available; open settings') : text('更新已安装，需要重启，打开设置','Update installed; restart required; open settings')}
            title={updateAttention === 'available' ? text('有可用更新','Update available') : text('需要重启以完成更新','Restart to finish updating')}
            onClick={onOpenSettings}
          >
            <span className="global-toolbar__attention-mark" aria-hidden="true" />
          </button>
        )}
        <button type="button" className="global-toolbar__icon-button" aria-label={text('打开设置','Open settings')} title={text('设置','Settings')} onClick={onOpenSettings}>
          <Icon name="settings" size={18} />
        </button>
      </div>
    </header>
  )
}
