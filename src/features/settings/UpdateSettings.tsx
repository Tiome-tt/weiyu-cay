import {text as uiText} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
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
      {state.status === 'idle' && <p>{uiText("更新只会在你检查时下载信息，不会在后台自动安装。","Update information is downloaded only when you check. Updates are not installed automatically.")}</p>}
      {state.status === 'checking' && <p role="status">{uiText("正在检查更新…","Checking for updates…")}</p>}
      {state.status === 'none' && <p role="status">{APP_NAME}{uiText(" 已是最新版本。"," You are up to date.")}</p>}
      <ErrorNotification error={state.status === 'check-error' ? uiText("无法检查更新。你的笔记不会受到影响，请稍后重试。","Could not check for updates. Your notes are unaffected. Try again later.") : null} />
      {state.status === 'available' && update !== null && (
        <div>
          <p role="status">{uiText("版本 ","Version ")}{update.version}{uiText(" 可以安装。"," is available to install.")}</p>
          {update.notes && <p className="update-settings__notes">{update.notes}</p>}
          <button type="button" onClick={() => void controller.install()}>{uiText("下载并安装 ","Download and install ")}{update.version}</button>
        </div>
      )}
      {state.status === 'installing' && <p role="status">{uiText("正在下载并验证更新…","Downloading and verifying update…")}</p>}
      {state.status === 'install-error' && update !== null && (
        <div>
          <ErrorNotification error={uiText("更新安装失败。你的笔记没有改变，可以重试。","Update installation failed. Your notes are unchanged. You can retry.")} />
          <button type="button" onClick={() => void controller.install()}>{uiText("重新安装 ","Retry installation ")}{update.version}</button>
        </div>
      )}
      {state.status === 'installed' && <div><p role="status">{uiText("更新已安装，重启后完成。","Update installed. Restart to finish.")}</p><button type="button" onClick={() => void controller.restart()}>{uiText("重启以完成更新","Restart to finish updating")}</button></div>}
      {state.status === 'restarting' && <p role="status">{uiText("正在重新启动","Restarting")}{APP_NAME}…</p>}
      {state.status === 'restart-error' && <div><ErrorNotification error={uiText(`更新已安装，但重启失败。请重试或手动重新启动${APP_NAME}。`,`The update was installed, but restart failed. Retry or manually restart ${APP_NAME}.`)} /><button type="button" onClick={() => void controller.restart()}>{uiText("重新尝试重启","Retry restart")}</button></div>}
      {(state.status === 'idle' || state.status === 'none' || state.status === 'check-error') && (
        <button type="button" disabled={busy} onClick={() => void controller.check()}>
          {state.status === 'check-error' ? uiText("重新检查更新","Check again") : uiText("检查更新","Check for updates")}
        </button>
      )}
    </div>
  )
}
