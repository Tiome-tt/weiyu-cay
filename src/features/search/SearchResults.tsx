import type { NoteId } from '../../domain/model'
import type { SearchResult } from '../../domain/ports'

interface SearchResultsProps {
  results: SearchResult[]
  onSelect: (noteId: NoteId) => void
}

export function SearchResults({ results, onSelect }: SearchResultsProps) {
  return (
    <ul className="search-results" aria-label="搜索结果">
      {results.map((result) => (
        <li key={result.noteId}>
          <button type="button" onClick={() => onSelect(result.noteId)}>
            <strong>{result.title}</strong>
            <span>{result.folderBreadcrumb.join(' / ') || '未分类'}</span>
            {result.tags.length > 0 && <span>{result.tags.map((tag) => `#${tag}`).join(' ')}</span>}
            {result.excerpt && <span>{result.excerpt}</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}
