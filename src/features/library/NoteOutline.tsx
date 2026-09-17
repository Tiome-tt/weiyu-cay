import { useMemo, useState } from 'react'
import { extractMarkdownHeadings } from '../editor/markdownPipeline'
import { Icon } from '../../shared/Icon'

interface NoteOutlineProps {
  markdown: string
  onNavigate(line: number, headingIndex: number): void
  onCollapse?(): void
}

export const parseNoteHeadings = extractMarkdownHeadings

export function NoteOutline({ markdown, onNavigate, onCollapse }: NoteOutlineProps) {
  const headings = useMemo(() => parseNoteHeadings(markdown), [markdown])
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(() => new Set())
  const collapsibleKeys = new Set(
    headings
      .slice(0, -1)
      .filter((heading, index) => headings[index + 1] !== undefined && headings[index + 1].level > heading.level)
      .map(headingKey),
  )
  const visibleHeadings: Array<{ heading: (typeof headings)[number]; key: string; collapsed: boolean; hasChildren: boolean }> = []
  let hiddenBelowLevel: number | null = null
  for (const heading of headings) {
    if (hiddenBelowLevel !== null) {
      if (heading.level > hiddenBelowLevel) continue
      hiddenBelowLevel = null
    }
    const key = headingKey(heading)
    const collapsed = collapsedKeys.has(key)
    visibleHeadings.push({ heading, key, collapsed, hasChildren: collapsibleKeys.has(key) })
    if (collapsed) hiddenBelowLevel = heading.level
  }
  const toggleHeading = (key: string) => {
    setCollapsedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <section className="note-outline" aria-label="笔记目录">
      <header className="library-pane__header library-pane__header--compact">
        <div><span className="library-pane__eyebrow">当前笔记</span><h2>目录</h2></div>
        {onCollapse && <button className="icon-button" type="button" aria-label="折叠目录" onClick={onCollapse}>‹</button>}
      </header>
      {headings.length === 0 ? <p className="library-status">这篇笔记还没有标题。</p> : (
        <nav className="note-outline__items" aria-label="标题层级">
          {visibleHeadings.map(({ heading, key, collapsed, hasChildren }) => {
            const label = heading.text || '无标题'
            const action = collapsed ? '展开' : '折叠'
            return (
              <div key={key} className={'note-outline__row note-outline__row--level-' + heading.level}>
                <button
                  type="button"
                  className={'note-outline__item note-outline__item--level-' + heading.level}
                  onClick={() => onNavigate(heading.line, heading.index)}
                >
                  {heading.text}
                </button>
                {hasChildren && (
                  <button
                    type="button"
                    className="note-outline__toggle"
                    aria-label={action + '“' + label + '”下级标题'}
                    aria-expanded={!collapsed}
                    title={action + '下级标题'}
                    onClick={() => toggleHeading(key)}
                  >
                    <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={13} />
                  </button>
                )}
              </div>
            )
          })}
        </nav>
      )}
    </section>
  )
}

function headingKey(heading: { line: number; index: number }) {
  return String(heading.line) + ':' + String(heading.index)
}
