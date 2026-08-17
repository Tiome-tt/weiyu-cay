import { useState, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from '../../shared/Icon'
import { mergeTags, normalizeTag, TagValidationError } from './query'

interface TagsEditorProps {
  tags: string[]
  onChange: (tags: string[]) => Promise<void>
}

export function TagsEditor({ tags, onChange }: TagsEditorProps) {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'status'; text: string } | null>(null)

  const persist = async (next: string[], clearInput = false) => {
    if (busy) return
    setBusy(true)
    setMessage(null)
    try {
      await onChange(next)
      if (clearInput) setInput('')
    } catch {
      setMessage({ kind: 'error', text: '无法更新标签，请重试。' })
    } finally {
      setBusy(false)
    }
  }

  const add = (event?: FormEvent) => {
    event?.preventDefault()
    try {
      const normalized = normalizeTag(input)
      const next = mergeTags(tags, [normalized.display])
      if (next.length === tags.length) {
        setMessage({ kind: 'status', text: '标签已存在。' })
        return
      }
      void persist(next, true)
    } catch (error: unknown) {
      if (!(error instanceof TagValidationError)) throw error
      setMessage({
        kind: 'error',
        text: error.reason === 'empty' ? '请输入标签。' : error.reason === 'too-long' ? '标签过长。' : '标签包含不支持的字符。',
      })
    }
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    add()
  }

  return (
    <div className="tags-editor" aria-label="笔记标签">
      <div className="tags-editor__chips">
        {tags.map((tag) => (
          <span className="tag-chip" key={normalizeTag(tag).normalized}>
            {tag}
            <button type="button" aria-label={`移除标签 ${tag}`} disabled={busy} onClick={() => void persist(tags.filter((item) => item !== tag))}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      <form className="tags-editor__form" onSubmit={add}>
        <input aria-label="添加标签" value={input} disabled={busy} onChange={(event) => setInput(event.target.value)} onKeyDown={handleKeyDown} />
        <button type="submit" aria-label="添加标签" disabled={busy}><Icon name="plus" size={13} /></button>
      </form>
      {message && <span className="tags-editor__message" role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</span>}
    </div>
  )
}
