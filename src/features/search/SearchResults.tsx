import { SearchHighlight, matchingSentences } from './searchExcerpt'
import type { NoteId } from '../../domain/model'
import type { SearchResult } from '../../domain/ports'

interface SearchResultsProps {
  query: string
  id: string
  results: SearchResult[]
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  onSelect: (noteId: NoteId) => void
}

export function SearchResults({ query, id, results, activeIndex, onActiveIndexChange, onSelect }: SearchResultsProps) {
  return (
    <ul className="search-results" id={id} aria-label="搜索结果">
      {results.map((result, index) => (
        <li key={result.noteId}>
          <button id={`${id}-${index}`} type="button" data-active={index === activeIndex || undefined} onFocus={() => onActiveIndexChange(index)} onClick={() => onSelect(result.noteId)}>
            <strong><SearchHighlight text={result.title} query={query}/></strong>
            <span>{result.folderBreadcrumb.join(' / ') || '未分类'}</span>
            {result.tags.length > 0 && <span>{result.tags.map((tag) => `#${tag}`).join(' ')}</span>}
            {result.excerpt && <span><SearchHighlight text={matchingSentences(result.excerpt,query)} query={query}/></span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
