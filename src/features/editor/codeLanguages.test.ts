import { describe, expect, it } from 'vitest'
import { CompletionContext } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { codeLanguage, completeCodeLanguage, replaceFenceLanguage } from './codeLanguages'
import { renderPreviewMarkdown } from './markdownPipeline'

describe('code languages', () => {
  it('recognizes aliases and produces Java keyword, string and comment tokens', () => {
    const language = codeLanguage('JAVA extra')!
    const classes: string[] = []
    highlightTree(language.parser.parse('public class Demo { String s = "<script>"; // comment\n}'), classHighlighter, (_from, _to, css) => classes.push(css))
    expect(classes.join(' ')).toContain('tok-keyword')
    expect(classes.join(' ')).toContain('tok-string')
    expect(classes.join(' ')).toContain('tok-comment')
    expect(codeLanguage('js')).toBe(codeLanguage('javascript'))
    expect(codeLanguage('unknown')).toBeNull()
  })
  it('suggests languages only on an opening fence', () => {
    const doc = '```ja\nbody\n```'
    const state = EditorState.create({ doc, extensions: markdown() })
    expect(completeCodeLanguage(new CompletionContext(state, 5, false))?.options.some((option) => option.label === 'java')).toBe(true)
    expect(completeCodeLanguage(new CompletionContext(state, 10, true))).toBeNull()
    expect(completeCodeLanguage(new CompletionContext(state, doc.length, true))).toBeNull()
  })
  it('preserves fence style, suffix metadata and surrounding block markers', () => {
    expect(replaceFenceLanguage('> ~~~~ java numbered', 'python')).toBe('> ~~~~ python numbered')
    expect(replaceFenceLanguage('```', 'java')).toBe('```java')
    expect(replaceFenceLanguage('```java numbered', '')).toBe('```text numbered')
  })
  it('highlights preview safely without changing code text', () => {
    const html = renderPreviewMarkdown('```java\npublic String s = "<script>";\n```')
    expect(html).toContain('tok-keyword')
    const container = document.createElement('div')
    container.innerHTML = html
    expect(container.querySelector('code')?.textContent).toBe('public String s = "<script>";\n')
    expect(html).not.toContain('<script>')
    expect(renderPreviewMarkdown('```unknown\npublic\n```')).not.toContain('tok-keyword')
  })
})
