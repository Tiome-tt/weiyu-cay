import { syntaxTree, StreamLanguage, type Language } from '@codemirror/language'
import { javascriptLanguage, typescriptLanguage } from '@codemirror/lang-javascript'
import { cssLanguage } from '@codemirror/lang-css'
import { htmlLanguage } from '@codemirror/lang-html'
import { java, c, cpp, csharp, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { python } from '@codemirror/legacy-modes/mode/python'
import { go } from '@codemirror/legacy-modes/mode/go'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'

export const codeLanguages = [
  { id: 'java', label: 'Java', language: StreamLanguage.define(java), aliases: [] },
  { id: 'javascript', label: 'JavaScript', language: javascriptLanguage, aliases: ['js', 'jsx'] },
  { id: 'typescript', label: 'TypeScript', language: typescriptLanguage, aliases: ['ts', 'tsx'] },
  { id: 'python', label: 'Python', language: StreamLanguage.define(python), aliases: ['py'] },
  { id: 'c', label: 'C', language: StreamLanguage.define(c), aliases: [] },
  { id: 'cpp', label: 'C++', language: StreamLanguage.define(cpp), aliases: ['c++'] },
  { id: 'csharp', label: 'C#', language: StreamLanguage.define(csharp), aliases: ['cs', 'c#'] },
  { id: 'kotlin', label: 'Kotlin', language: StreamLanguage.define(kotlin), aliases: ['kt'] },
  { id: 'go', label: 'Go', language: StreamLanguage.define(go), aliases: ['golang'] },
  { id: 'rust', label: 'Rust', language: StreamLanguage.define(rust), aliases: ['rs'] },
  { id: 'html', label: 'HTML', language: htmlLanguage, aliases: [] },
  { id: 'css', label: 'CSS', language: cssLanguage, aliases: [] },
  { id: 'json', label: 'JSON', language: javascriptLanguage, aliases: ['jsonc'] },
  { id: 'sql', label: 'SQL', language: StreamLanguage.define(standardSQL), aliases: [] },
  { id: 'bash', label: 'Shell / Bash', language: StreamLanguage.define(shell), aliases: ['sh', 'shell', 'zsh'] },
  { id: 'yaml', label: 'YAML', language: StreamLanguage.define(yaml), aliases: ['yml'] },
] as const

export function codeLanguage(info: string): Language | null {
  const id = info.trim().split(/\s+/)[0].toLowerCase()
  return codeLanguages.find((entry) => entry.id === id || (entry.aliases as readonly string[]).includes(id))?.language ?? null
}

export function replaceFenceLanguage(line: string, language: string): string {
  return line.replace(/(`{3,}|~{3,})(\s*)([^\s]*)(.*)$/, (_all, fence: string, space: string, _old: string, suffix: string) => `${fence}${space}${language || (suffix.trim() ? 'text' : '')}${suffix}`)
}

export function completeCodeLanguage(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos)
  let node = syntaxTree(context.state).resolveInner(context.pos, -1)
  while (node.parent !== null && node.name !== 'FencedCode') node = node.parent
  if (node.name !== 'FencedCode' || context.state.doc.lineAt(node.from).number !== line.number) return null
  const prefix = context.state.doc.sliceString(line.from, context.pos)
  const match = /(?:`{3,}|~{3,})\s*([\w+#-]*)$/.exec(prefix)
  if (match === null) return null
  return {
    from: context.pos - match[1].length,
    options: codeLanguages.map(({ id, label }) => ({ label: id, displayLabel: label, type: 'type' })),
    validFor: /^[\w+#-]*$/,
  }
}
