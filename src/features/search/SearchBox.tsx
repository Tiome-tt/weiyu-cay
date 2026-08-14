import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { NoteId } from '../../domain/model'
import type { SearchPort, SearchResult } from '../../domain/ports'
import { parseSearchQuery } from './query'
import { SearchResults } from './SearchResults'

interface SearchBoxProps {
  search: SearchPort
  onSelect: (noteId: NoteId) => void
}

type SearchState = 'idle' | 'loading' | 'empty' | 'invalid' | 'error'

const SEARCH_DELAY_MS = 180

export function SearchBox({ search, onSelect }: SearchBoxProps) {
  const [input, setInput] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [state, setState] = useState<SearchState>('idle')
  const [guidance, setGuidance] = useState('')
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [retryRequest, setRetryRequest] = useState(0)
  const generation = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsId = useId()

  useEffect(() => () => { generation.current += 1 }, [])

  useEffect(() => {
    const request = ++generation.current
    const query = parseSearchQuery(input)
    if (input.length === 0) {
      setState('idle')
      setGuidance('')
      return
    }
    const timer = window.setTimeout(async () => {
      if (generation.current !== request) return
      if (query.kind === 'invalid') {
        setState('invalid')
        setGuidance(query.reason === 'empty-tag' ? '请在 # 后输入标签关键词' : '搜索内容无效或过长')
        return
      }
      if (query.value.length === 0) {
        setState('idle')
        setGuidance('')
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
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [input, retryRequest, search])

  const close = (restoreFocus = false) => {
    generation.current += 1
    setDismissed(true)
    setResults([])
    setState('idle')
    setActiveIndex(-1)
    if (restoreFocus) inputRef.current?.focus()
  }

  const select = (noteId: NoteId) => {
    close()
    onSelect(noteId)
  }

  const retry = () => {
    generation.current += 1
    setDismissed(false)
    setResults([])
    setState('idle')
    setActiveIndex(-1)
    setRetryRequest((current) => current + 1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      close(true)
      return
    }
    if (results.length === 0 || dismissed) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, results.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => current <= 0 ? results.length - 1 : current - 1)
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault()
      select(results[activeIndex].noteId)
    }
  }

  const open = !dismissed && (state !== 'idle' || results.length > 0)

  return (
    <div className="library-search" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        aria-label="搜索笔记"
        aria-autocomplete="list"
        aria-controls={resultsId}
        aria-expanded={open}
        aria-activedescendant={activeIndex >= 0 ? `${resultsId}-${activeIndex}` : undefined}
        placeholder="搜索标题、正文或 #标签"
        value={input}
        onChange={(event) => {
          generation.current += 1
          setInput(event.target.value)
          setResults([])
          setState('idle')
          setGuidance('')
          setDismissed(false)
          setActiveIndex(-1)
        }}
      />
      {open && results.length === 0 && (
        <div className="search-results search-results--message" id={resultsId}>
          <p role={state === 'error' ? 'alert' : 'status'}>
            {guidance || (state === 'loading' ? '正在搜索…' : state === 'empty' ? '没有匹配的笔记' : '搜索失败，请重试')}
          </p>
          {state === 'error' && <button type="button" onClick={retry}>重新搜索</button>}
        </div>
      )}
      {open && results.length > 0 && <SearchResults id={resultsId} results={results} activeIndex={activeIndex} onSelect={select} />}
    </div>
  )
}
