import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { Folder, NoteId, NoteSummary } from '../../domain/model'
import { InternalLinkTree } from './InternalLinkTree'

interface InternalLinkDialogProps {
  currentNoteId: NoteId
  folders: Folder[]
  targets: NoteSummary[]
  onInsert(target: NoteSummary): boolean
  onCancel(): void
}

export function InternalLinkDialog({
  currentNoteId,
  folders,
  targets,
  onInsert,
  onCancel,
}: InternalLinkDialogProps) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<NoteId | ''>('')
  const searchRef = useRef<HTMLInputElement>(null)
  const availableTargets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN')
    return targets.filter((target) => (
      target.id !== currentNoteId
      && (normalizedQuery.length === 0 || target.title.toLocaleLowerCase('zh-CN').includes(normalizedQuery))
    ))
  }, [currentNoteId, query, targets])

  useEffect(() => searchRef.current?.focus(), [])
  useEffect(() => {
    if (availableTargets.some((target) => target.id === selectedId)) return
    setSelectedId(availableTargets[0]?.id ?? '')
  }, [availableTargets, selectedId])

  const insert = () => {
    const target = availableTargets.find((candidate) => candidate.id === selectedId)
    if (target !== undefined && onInsert(target)) onCancel()
  }

  const handleKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement && selectedId !== '') {
      event.preventDefault()
      insert()
    }
  }

  return (
    <div className="internal-link-dialog__backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onCancel()
    }}>
      <section
        className="internal-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="internal-link-dialog-title"
        onKeyDown={handleKeys}
      >
        <header>
          <div>
            <span className="library-pane__eyebrow">笔记引用</span>
            <h2 id="internal-link-dialog-title">插入内部链接</h2>
          </div>
          <button type="button" aria-label="关闭内部链接弹窗" onClick={onCancel}>×</button>
        </header>
        <div className="internal-link-dialog__body">
          <label>
            <span className="sr-only">筛选笔记</span>
            <input
              ref={searchRef}
              type="search"
              aria-label="筛选笔记"
              placeholder="搜索笔记标题"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {availableTargets.length > 0
            ? <InternalLinkTree folders={folders} targets={availableTargets} selectedId={selectedId} onSelect={setSelectedId} />
            : <p className="internal-link-tree__empty">没有可插入的其他笔记。</p>}
        </div>
        <footer>
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="internal-link-dialog__primary" disabled={selectedId === ''} onClick={insert}>插入链接</button>
        </footer>
      </section>
    </div>
  )
}