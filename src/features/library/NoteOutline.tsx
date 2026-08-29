interface NoteOutlineProps {
  markdown: string
  onNavigate(line: number, headingIndex: number): void
  onCollapse?(): void
}

export interface NoteHeading {
  line: number
  index: number
  level: number
  text: string
}

export function parseNoteHeadings(markdown: string): NoteHeading[] {
  return markdown.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (match === null) return []
    return [{ line: index + 1, index: 0, level: match[1].length, text: match[2].trim() }]
  }).map((heading, index) => ({ ...heading, index }))
}

export function NoteOutline({ markdown, onNavigate, onCollapse }: NoteOutlineProps) {
  const headings = parseNoteHeadings(markdown)
  return (
    <section className="note-outline" aria-label="笔记目录">
      <header className="library-pane__header library-pane__header--compact">
        <div><span className="library-pane__eyebrow">当前笔记</span><h2>目录</h2></div>
        {onCollapse && <button className="icon-button" type="button" aria-label="折叠目录" onClick={onCollapse}>‹</button>}
      </header>
      {headings.length === 0 ? <p className="library-status">这篇笔记还没有标题。</p> : (
        <nav className="note-outline__items" aria-label="标题层级">
          {headings.map((heading) => <button key={`${heading.line}-${heading.index}`} type="button" className={`note-outline__item note-outline__item--level-${heading.level}`} onClick={() => onNavigate(heading.line, heading.index)}>{heading.text}</button>)}
        </nav>
      )}
    </section>
  )
}
