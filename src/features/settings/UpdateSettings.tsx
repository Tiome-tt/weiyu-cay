import type { AvailableUpdate } from '../../domain/ports'
import { APP_NAME } from '../../shared/brand'

export type UpdateViewState =
  | { status: 'idle' | 'checking' | 'none' | 'check-error' }
  | { status: 'available' | 'installing' | 'installed' | 'install-error' | 'restarting' | 'restart-error'; update: AvailableUpdate }

export interface UpdateController {
  state: UpdateViewState
  check(): Promise<void>
  install(): Promise<void>
  restart(): Promise<void>
}

export function UpdateSettings({ controller }: { controller: UpdateController }) {
  const { state } = controller
  const busy = state.status === 'checking' || state.status === 'installing' || state.status === 'restarting'
  const update = 'update' in state ? state.update : null

  return (
    <div className="update-settings">
      {state.status === 'idle' && <p>更新只会在你检查时下载信息，不会在后台自动安装。</p>}
      {state.status === 'checking' && <p role="status">正在检查更新…</p>}
      {state.status === 'none' && <p role="status">{APP_NAME} 已是最新版本。</p>}
      {state.status === 'check-error' && <p role="alert">无法检查更新。你的笔记不会受到影响，请稍后重试。</p>}
      {state.status === 'available' && update !== null && (
        <div>
          <p role="status">版本 {update.version} 可以安装。</p>
          {update.notes && <p className="update-settings__notes">{update.notes}</p>}
          <button type="button" onClick={() => void controller.install()}>下载并安装 {update.version}</button>
        </div>
      )}
      {state.status === 'installing' && <p role="status">正在下载并验证更新…</p>}
      {state.status === 'install-error' && update !== null && (
        <div>
          <p role="alert">更新安装失败。你的笔记没有改变，可以重试。</p>
          <button type="button" onClick={() => void controller.install()}>重新安装 {update.version}</button>
        </div>
      )}
      {state.status === 'installed' && <div><p role="status">更新已安装，重启后完成。</p><button type="button" onClick={() => void controller.restart()}>重启以完成更新</button></div>}
      {state.status === 'restarting' && <p role="status">正在重新启动{APP_NAME}…</p>}
      {state.status === 'restart-error' && <div><p role="alert">更新已安装，但重启失败。请重试或手动重新启动{APP_NAME}。</p><button type="button" onClick={() => void controller.restart()}>重新尝试重启</button></div>}
      {(state.status === 'idle' || state.status === 'none' || state.status === 'check-error') && (
        <button type="button" disabled={busy} onClick={() => void controller.check()}>
          {state.status === 'check-error' ? '重新检查更新' : '检查更新'}
        </button>
      )}
    </div>
  )
}
