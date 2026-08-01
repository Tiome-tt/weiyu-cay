import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { NoteId } from '../../domain/model'
import type { SearchPort, SearchResult } from '../../domain/ports'
import { parseSearchQuery } from './query'
import { SearchResults } from './SearchResults'

interface SearchBoxProps {
  search: SearchPort
  onSelect: (noteId: NoteId) => void
}

type SearchState = 'idle' | 'loading' | 'empty' | 'error'

const DEFAULT_GUIDANCE = '输入文字搜索标题和正文，或使用 #标签 搜索标签'

export function SearchBox({ search, onSelect }: SearchBoxProps) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [state, setState] = useState<SearchState>('idle')
  const [guidance, setGuidance] = useState(DEFAULT_GUIDANCE)
  const generation = useRef(0)

  useEffect(() => () => { generation.current += 1 }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const request = ++generation.current
    const query = parseSearchQuery(input)
    setResults([])
    if (query.kind === 'invalid') {
      setState('idle')
      setGuidance(query.reason === 'empty-tag' ? '请在 # 后输入标签关键词' : '搜索内容无效或过长')
      return
    }
    if (query.value.length === 0) {
      setState('idle')
      setGuidance(DEFAULT_GUIDANCE)
      return
    }
    setState('loading')
    setGuidance('')
    try {
      const next = await search.search(query, 100)
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
          placeholder="搜索标题、正文或 #标签"
          value={input}
          onChange={(event) => {
            generation.current += 1
            setInput(event.target.value)
            setResults([])
            setState('idle')
            setGuidance(DEFAULT_GUIDANCE)
          }}
        />
        <button type="submit">搜索</button>
      </form>
      {(guidance || state !== 'idle') && (
        <p role={state === 'error' ? 'alert' : 'status'}>
          {guidance || (state === 'loading' ? '正在搜索…' : state === 'empty' ? '没有匹配的笔记' : '搜索失败，请重试')}
        </p>
      )}
      {results.length > 0 && <SearchResults results={results} onSelect={onSelect} />}
    </div>
  )
}
