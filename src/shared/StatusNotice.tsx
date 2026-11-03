import {text as uiText} from './i18n'
import { ErrorNotification } from './notifications'

export type StatusNoticeState =
  | { status: 'idle' }
  | { status: 'status' | 'success'; message: string }
  | { status: 'error'; message: string; retry?: () => void; retryLabel?: string; busy?: boolean }

interface StatusNoticeProps {
  state: StatusNoticeState
  className?: string
}

export function StatusNotice({ state, className }: StatusNoticeProps) {
  if (state.status === 'idle') return null
  if (state.status === 'error') {
    if (!state.retry) return <ErrorNotification error={state.message} />
    return (
      <span className={className}>
        <ErrorNotification error={state.message} />
        <button type="button" aria-label={state.retryLabel ?? uiText("重试保存","Retry save")} disabled={state.busy} onClick={state.retry}>{uiText("重试","Retry")}</button>
      </span>
    )
  }
  return (
    <span className={className} role="status" aria-live="polite">
      {state.message}
    </span>
  )
}
