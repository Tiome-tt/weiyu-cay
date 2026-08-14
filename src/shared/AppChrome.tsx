import type { ReactNode } from 'react'
import type { WindowChromePort } from '../domain/ports'
import { Icon, type IconName } from './Icon'

interface AppChromeProps {
  children: ReactNode
  windowChrome: WindowChromePort
}

interface WindowControl {
  icon: IconName
  label: string
  run(): Promise<void>
}

/** Frameless main-window shell. Product branding belongs in the toolbar below this row. */
export function AppChrome({ children, windowChrome }: AppChromeProps) {
  const controls: WindowControl[] = [
    { icon: 'minimize', label: '最小化窗口', run: () => windowChrome.minimize() },
    { icon: 'maximize', label: '最大化或还原窗口', run: () => windowChrome.toggleMaximize() },
    { icon: 'close', label: '关闭窗口', run: () => windowChrome.requestClose() },
  ]
  const orderedControls = windowChrome.platform === 'macos'
    ? [controls[2], controls[0], controls[1]]
    : controls
  const controlGroup = <WindowControls controls={orderedControls} />

  return (
    <div className={`window-chrome window-chrome--${windowChrome.platform}`}>
      <header className="window-titlebar" data-testid="window-titlebar">
        {windowChrome.platform === 'macos' ? controlGroup : null}
        <div
          className="window-drag-region"
          data-tauri-drag-region=""
          data-testid="window-drag-region"
        />
        {windowChrome.platform === 'windows' ? controlGroup : null}
      </header>
      <div className="window-chrome__content">{children}</div>
    </div>
  )
}

function WindowControls({ controls }: { controls: WindowControl[] }) {
  return (
    <div className="window-controls" data-testid="window-controls">
      {controls.map((control) => (
        <button
          aria-label={control.label}
          className={control.icon === 'close' ? 'window-control window-control--close' : 'window-control'}
          key={control.label}
          onClick={() => ignoreWindowOperationFailure(control.run())}
          onPointerDown={(event) => event.stopPropagation()}
          title={control.label}
          type="button"
        >
          <Icon name={control.icon} size={16} />
        </button>
      ))}
    </div>
  )
}

function ignoreWindowOperationFailure(operation: Promise<void>) {
  void operation.catch(() => undefined)
}
