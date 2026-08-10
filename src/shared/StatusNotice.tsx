export type StatusNoticeState =
  | { status: 'idle' }
  | { status: 'status' | 'success'; message: string }
  | { status: 'error'; message: string; retry?: () => void; retryLabel?: string }

interface StatusNoticeProps {
  state: StatusNoticeState
  className?: string
}

export function StatusNotice({ state, className }: StatusNoticeProps) {
  if (state.status === 'idle') return null
  if (state.status === 'error') {
    return (
      <span className={className} role="alert">
        <span>{state.message}</span>
        {state.retry && (
          <button type="button" aria-label={state.retryLabel ?? '重试保存'} onClick={state.retry}>
            重试
          </button>
        )}
      </span>
    )
  }
  return (
    <span className={className} role="status" aria-live="polite">
      {state.message}
    </span>
  )
}
