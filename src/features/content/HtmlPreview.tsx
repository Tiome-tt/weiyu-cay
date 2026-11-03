import {text as uiText} from '../../shared/i18n'
import { useEffect, useState } from 'react'
import type { NoteId } from '../../domain/model'
import { ErrorNotification } from '../../shared/notifications'

export function HtmlPreview({ noteId, revision, createPreview }: { noteId: NoteId; revision: number; createPreview?: (id: NoteId) => Promise<string> }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setUrl(null); setError(null)
    if (!createPreview) { setError(uiText("请重新启动更新后的桌面应用以预览 HTML。","Restart the updated desktop app to preview HTML.")); return }
    void createPreview(noteId).then(value => { if (active) setUrl(value) }, () => { if (active) setError(uiText("无法预览 HTML，文件可能超过 8 MiB；原文件仍可另存为。","Could not preview HTML. The file may exceed 8 MiB. You can still save a copy of the original.")) })
    return () => { active = false }
  }, [noteId, revision, createPreview])
  return <><ErrorNotification error={error}/>{url && <iframe className="html-preview" title={uiText("HTML 网页预览","HTML page preview")} sandbox="allow-scripts" referrerPolicy="no-referrer" src={url}/>}</>
}
