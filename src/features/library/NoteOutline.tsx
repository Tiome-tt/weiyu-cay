import {text as uiText} from '../../shared/i18n'
import { useEffect, useMemo, useState } from 'react'
import { extractMarkdownHeadings } from '../editor/markdownPipeline'
import { Icon } from '../../shared/Icon'

interface NoteOutlineProps {
  markdown: string
  onNavigate(line: number, headingIndex: number): void
  onCollapse?(): void
  collapsedKeys?: readonly string[]
  onCollapsedKeysChange?(keys: string[]): void
}

export const parseNoteHeadings = extractMarkdownHeadings

export function NoteOutline({ markdown, onNavigate, onCollapse, collapsedKeys: initialCollapsedKeys, onCollapsedKeysChange }: NoteOutlineProps) {
  const headings = useMemo(() => parseNoteHeadings(markdown), [markdown])
  const [collapsedKeySet, setCollapsedKeySet] = useState<Set<string>>(() => new Set(initialCollapsedKeys ?? []))
  useEffect(() => {
    setCollapsedKeySet(new Set(initialCollapsedKeys ?? []))
  }, [initialCollapsedKeys])
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
    const collapsed = collapsedKeySet.has(key)
    visibleHeadings.push({ heading, key, collapsed, hasChildren: collapsibleKeys.has(key) })
    if (collapsed) hiddenBelowLevel = heading.level
  }
  const toggleHeading = (key: string) => {
    setCollapsedKeySet((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      onCollapsedKeysChange?.([...next])
      return next
    })
  }

  return (
    <section className="note-outline" aria-label={uiText("笔记目录","Note outline")}>
      <header className="library-pane__header library-pane__header--compact">
        <div><span className="library-pane__eyebrow">{uiText("当前笔记","Current note")}</span><h2>{uiText("目录","Outline")}</h2></div>
        {onCollapse && <button className="icon-button" type="button" aria-label={uiText("折叠目录","Collapse outline")} onClick={onCollapse}>‹</button>}
      </header>
      {headings.length === 0 ? <p className="library-status">{uiText("这篇笔记还没有标题。","This note has no headings yet.")}</p> : (
        <nav className="note-outline__items" aria-label={uiText("标题层级","Heading level")}>
          {visibleHeadings.map(({ heading, key, collapsed, hasChildren }) => {
            const label = heading.text || uiText("无标题","Untitled")
            const action = collapsed ? uiText("展开","Expand") : uiText("折叠","Collapse")
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
                    aria-label={action + '“' + label + uiText("”下级标题","” subheadings")}
                    aria-expanded={!collapsed}
                    title={action + uiText("下级标题","Subheadings")}
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
