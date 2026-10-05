/** Excerpts use actual matching sentences, in document order, never arbitrary text. */
export function matchingSentences(text: string, query: string): string {
 const needle=query.trim().replace(/^#/, '').toLocaleLowerCase()
 if(!needle)return ''
 return (text.match(/[^。！？.!?\n]+[。！？.!?]?/gu)??[]).map(part=>part.trim().replace(/^(?:…\s*)+/,'')).filter(part=>part.toLocaleLowerCase().includes(needle)).slice(0,3).join(' … ')
}
export function SearchHighlight({text,query}:{text:string;query:string}) {
 const needle=query.trim().replace(/^#/, '')
 if(!needle)return <>{text}</>
 const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
 return <>{text.split(new RegExp('('+escaped+')','gi')).map((part,index)=>part.toLocaleLowerCase()===needle.toLocaleLowerCase()?<mark key={index} className="search-match">{part}</mark>:part)}</>
}
