import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { NoteId } from '../../domain/model'
import type { SearchPort, SearchResult } from '../../domain/ports'
import { parseSearchQuery } from './query'

interface SearchBarProps {
  search: SearchPort
  onSelect: (noteId: NoteId) => void
}

export function SearchBar({ search, onSelect }: SearchBarProps) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'empty' | 'error'>('idle')
  const [guidance, setGuidance] = useState('使用 #标签 搜索笔记标签')
  const generation = useRef(0)

  useEffect(() => () => { generation.current += 1 }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const request = ++generation.current
    const query = parseSearchQuery(input)
    if (query.kind === 'invalid') {
      setResults([])
      setState('idle')
      setGuidance(query.reason === 'empty-tag' ? '请在 # 后输入标签关键词' : '搜索内容无效或过长')
      return
    }
    if (query.kind === 'text') {
      setResults([])
      setState('idle')
      setGuidance('当前支持 #标签 搜索；正文搜索将在后续版本提供')
      return
    }
    setState('loading')
    setGuidance('')
    try {
      const next = await search.search(query, 50)
      if (generation.current !== request) return
      setResults(next)
      setState(next.length === 0 ? 'empty' : 'idle')
    } catch {
      if (generation.current !== request) return
      setState('error')
    }
  }

  return (
    <div className="library-search">
      <form onSubmit={(event) => void submit(event)}>
        <input
          type="search"
          aria-label="搜索笔记"
          placeholder="#标签"
          value={input}
          onChange={(event) => {
            generation.current += 1
            setInput(event.target.value)
            setState('idle')
            setGuidance('使用 #标签 搜索笔记标签')
          }}
        />
        <button type="submit">搜索</button>
      </form>
      {(guidance || state !== 'idle') && (
        <p role={state === 'error' ? 'alert' : 'status'}>
          {guidance || (state === 'loading' ? '正在搜索…' : state === 'empty' ? '没有匹配的标签' : '搜索失败，请重试')}
        </p>
      )}
      {results.length > 0 && (
        <ul className="search-results" aria-label="标签搜索结果">
          {results.map((result) => (
            <li key={result.noteId}>
              <button type="button" onClick={() => onSelect(result.noteId)}>
                <strong>{result.title}</strong>
                <span>{result.folderBreadcrumb.join(' / ') || '未分类'}</span>
                <span>{result.tags.map((tag) => `#${tag}`).join(' ')}</span>
                {result.excerpt && <span>{result.excerpt}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
