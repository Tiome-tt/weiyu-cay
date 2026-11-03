import {text as uiText} from '../../shared/i18n'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from '../../shared/Icon'
import { ErrorNotification } from '../../shared/notifications'
import { mergeTags, normalizeTag, TagValidationError } from './query'

interface TagsEditorProps {
  tags: string[]
  onChange: (tags: string[]) => Promise<void>
}

export function TagsEditor({ tags, onChange }: TagsEditorProps) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null)

  const persist = async (next: string[], clearInput = false) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await onChange(next)
      if (clearInput) setInput('')
    } catch {
      setMessage({ kind: 'error', text: uiText("无法更新标签，请重试。","Could not update tags. Try again.") })
    } finally {
      setBusy(false)
    }
  }

  const add = (event?: FormEvent) => {
    event?.preventDefault()
    if (!input.trim()) { setMessage(null); return }
    try {
      const normalized = normalizeTag(input)
      const next = mergeTags(tags, [normalized.display])
      if (next.length === tags.length) {
        setMessage({ kind: 'status', text: uiText("标签已存在。","This tag already exists.") })
        return
      }
      void persist(next, true)
    } catch (error: unknown) {
      if (!(error instanceof TagValidationError)) throw error
      setMessage({
        kind: 'error',
        text: error.reason === 'empty' ? uiText("请输入标签。","Enter a tag.") : error.reason === 'too-long' ? uiText("标签过长。","The tag is too long.") : uiText("标签包含不支持的字符。","The tag contains unsupported characters."),
      })
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setInput('')
      setEditing(false)
      setMessage(null)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    add()
  }

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (!editing) return
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setEditing(false)
      setMessage(null)
        setInput('')
      }
    }
    document.addEventListener('pointerdown', closeFromOutside)
    return () => document.removeEventListener('pointerdown', closeFromOutside)
  }, [editing])

  return (
    <div ref={rootRef} className="tags-editor" aria-label={uiText("笔记标签","Note tags")}>
      <div className="tags-editor__chips" role={tags.length ? 'list' : undefined} aria-label={tags.length ? uiText("笔记标签","Note tags") : undefined}>
        {tags.map((tag) => (
          <span className="tag-chip" role="listitem" key={normalizeTag(tag).normalized}>
            #{tag}
            <button type="button" aria-label={uiText(`移除标签 ${tag}`,`Remove tag ${tag}`)} disabled={busy} onClick={() => void persist(tags.filter((item) => item !== tag))}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      {editing && <form className="tags-editor__form" onSubmit={add}>
        <input ref={inputRef} aria-label={uiText("添加标签","Add tag")} value={input} disabled={busy} onChange={(event) => { setInput(event.target.value); setMessage(null) }} onKeyDown={handleKeyDown} placeholder={uiText("输入标签","Enter tag")} />
        <button type="submit" aria-label={uiText("确认添加标签","Confirm tag")} disabled={busy || !input.trim()}>✓</button>
      </form>}
      <button className="tags-editor__add" type="button" aria-label={uiText("添加标签","Add tag")} disabled={busy} onClick={() => setEditing(true)}><Icon name="plus" size={14} /><span>{uiText("添加标签","Add tag")}</span></button>
      <ErrorNotification error={message?.kind === 'error' ? message.text : null} />
      {message?.kind === 'status' && <span className="tags-editor__message" role="status">{message.text}</span>}
    </div>
  )
}
