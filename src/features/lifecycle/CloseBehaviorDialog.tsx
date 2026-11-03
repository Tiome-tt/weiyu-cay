import {text as uiText} from '../../shared/i18n'
import { useEffect, useRef, useState } from 'react'
import { ErrorNotification } from '../../shared/notifications'

export type CloseBehaviorChoice = 'hide' | 'exit'

interface CloseBehaviorDialogProps {
  busy: boolean
  error: string | null
  onCancel(): void
  onChoose(choice: CloseBehaviorChoice, remember: boolean): void
  trayAvailable?: boolean
}

export function CloseBehaviorDialog({ busy, error, onCancel, onChoose, trayAvailable = true }: CloseBehaviorDialogProps) {
  const [remember, setRemember] = useState(true)
  const rememberRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const exitRef = useRef<HTMLButtonElement>(null)
  const hideRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    queueMicrotask(() => hideRef.current?.focus())
  }, [])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [busy, onCancel])

  const focusable = () => [rememberRef.current, cancelRef.current, exitRef.current, hideRef.current]
    .filter((element): element is HTMLInputElement | HTMLButtonElement => element !== null && !element.disabled)

  return (
    <div className="close-behavior-backdrop" role="presentation" onMouseDown={() => !busy && onCancel()}>
      <section
        className="close-behavior-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="close-behavior-heading"
        aria-describedby="close-behavior-description"
        aria-busy={busy || undefined}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const elements = focusable()
          const current = elements.indexOf(document.activeElement as HTMLInputElement | HTMLButtonElement)
          if (current === -1) return
          event.preventDefault()
          const next = event.shiftKey
            ? (current - 1 + elements.length) % elements.length
            : (current + 1) % elements.length
          elements[next]?.focus()
        }}
      >
        <div className="close-behavior-dialog__copy">
          <h1 id="close-behavior-heading">{uiText("关闭窗口？","Close window?")}</h1>
          <p id="close-behavior-description">{uiText("微屿将继续在后台运行，可从系统托盘再次打开。","Cay will keep running in the background. Reopen it from the system tray.")}</p>
        </div>
        <label className="close-behavior-dialog__remember">
          <input ref={rememberRef} aria-label={uiText("记住我的选择","Remember my choice")} type="checkbox" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} />
          <span>{uiText("记住我的选择","Remember my choice")}</span>
        </label>
        {!trayAvailable && <p className="close-behavior-dialog__error" role="alert">{uiText("系统托盘暂不可用，窗口不会被隐藏。你可以取消或安全退出微屿。","The system tray is unavailable. The window will stay visible. Cancel or quit Cay safely.")}</p>}
        <ErrorNotification error={error} />
        <footer>
          <button ref={cancelRef} className="close-behavior-dialog__quiet" type="button" disabled={busy} onClick={onCancel}>{uiText("取消","Cancel")}</button>
          <button ref={exitRef} type="button" disabled={busy} onClick={() => onChoose('exit', remember)}>{uiText("退出微屿","Quit Cay")}</button>
          <button ref={hideRef} aria-label={uiText("隐藏到托盘","Hide to tray")} className="close-behavior-dialog__primary" type="button" disabled={busy || !trayAvailable} onClick={() => onChoose('hide', remember)}>
            {busy ? uiText("正在保存选择…","Saving choice…") : uiText("隐藏到托盘","Hide to tray")}
          </button>
        </footer>
      </section>
    </div>
  )
}
