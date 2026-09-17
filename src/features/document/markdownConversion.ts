import type { RichDocument, RichMark, RichNode } from '../../domain/content'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const INLINE_TOKEN = new RegExp(`(\\[\\[[^\\]\\n|]+\\|${UUID}\\]\\]|==[^=\\n]+==|\\*\\*[^*\\n]+\\*\\*|~~[^~\\n]+~~|\\x60[^\\x60\\n]+\\x60|\\$\\$[^$\\n]+\\$\\$|\\$[^$\\n]+\\$|\\[[^\\]\\n]+\\]\\((?:https?:\\/\\/|mailto:)[^)\\s]+\\))`, 'gi')

function text(value: string, marks?: RichMark[]): RichNode {
  return { type: 'text', text: value, ...(marks?.length ? { marks } : {}) }
}

function inlineContent(source: string): RichNode[] {
  const nodes: RichNode[] = []
  let cursor = 0
  for (const match of source.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0
    if (index > cursor) nodes.push(text(source.slice(cursor, index)))
    const token = match[0]
    const internal = token.match(new RegExp(`^\\[\\[([^|]+)\\|(${UUID})\\]\\]$`, 'i'))
    const link = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)$/i)
    if (internal) {
      nodes.push({ type: 'internalLink', attrs: { label: internal[1], noteId: internal[2].toLowerCase() } })
    } else if (link) {
      nodes.push(text(link[1], [{ type: 'link', attrs: { href: link[2] } }]))
    } else if (token.startsWith('==')) {
      nodes.push(text(token.slice(2, -2), [{ type: 'highlight', attrs: { color: 'yellow' } }]))
    } else if (token.startsWith('**')) {
      nodes.push(text(token.slice(2, -2), [{ type: 'bold' }]))
    } else if (token.startsWith('~~')) {
      nodes.push(text(token.slice(2, -2), [{ type: 'strike' }]))
    } else if (token.startsWith('$$')) {
      nodes.push({ type: 'math', attrs: { latex: token.slice(2, -2) } })
    } else if (token.startsWith('$')) {
      nodes.push({ type: 'math', attrs: { latex: token.slice(1, -1) } })
    } else {
      nodes.push(text(token.slice(1, -1), [{ type: 'code' }]))
    }
    cursor = index + token.length
  }
  if (cursor < source.length) nodes.push(text(source.slice(cursor)))
  return nodes
}

function isKnownBlockStart(line: string): boolean {
  return /^(?:#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+|\$\$|[-*_](?:\s*[-*_]){2,}\s*$)/.test(line)
}

/**
 * Create an independent rich-document body from Markdown. Unsupported block
 * syntax is represented verbatim so conversion can never silently lose it.
 */
export function markdownToRichDocument(markdown: string): RichDocument {
  const source = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const content: RichNode[] = []

  for (let index = 0; index < lines.length;) {
    const line = lines[index]
    if (!line.trim()) { index += 1; continue }

    const singleLineMath = line.match(/^\$\$(.+)\$\$\s*$/)
    if (singleLineMath) {
      content.push({ type: 'mathBlock', attrs: { latex: singleLineMath[1].trim() } })
      index += 1
      continue
    }
    if (line.trim() === '$$') {
      const start = index
      index += 1
      const body: string[] = []
      while (index < lines.length && lines[index].trim() !== '$$') body.push(lines[index++])
      if (index >= lines.length) {
        content.push({ type: 'rawMarkdown', attrs: { source: lines.slice(start).join('\n') } })
        break
      }
      content.push({ type: 'mathBlock', attrs: { latex: body.join('\n').trim() } })
      index += 1
      continue
    }
    const fence = line.match(/^```\s*([^\s`]*)\s*$/)
    if (fence) {
      const start = index
      index += 1
      const body: string[] = []
      while (index < lines.length && !/^```\s*$/.test(lines[index])) body.push(lines[index++])
      if (index >= lines.length) {
        content.push({ type: 'rawMarkdown', attrs: { source: lines.slice(start).join('\n') } })
        break
      }
      index += 1
      content.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        ...(body.length ? { content: [text(body.join('\n'))] } : {}),
      })
      continue
    }

    if (/^:::+/.test(line) || /^\s*<[/!?A-Za-z]/.test(line) || /^\[\^[^\]]+\]:/.test(line)) {
      const raw: string[] = [line]
      index += 1
      if (/^:::+/.test(line)) {
        while (index < lines.length) {
          raw.push(lines[index])
          const closed = /^:::+\s*$/.test(lines[index])
          index += 1
          if (closed) break
        }
      } else {
        while (index < lines.length && lines[index].trim()) raw.push(lines[index++])
      }
      content.push({ type: 'rawMarkdown', attrs: { source: raw.join('\n') } })
      continue
    }

    const managedImage = line.match(new RegExp(`^!\\[([^\\]]*)\\]\\((assets\\/screenshot-${UUID}\\.(?:png|jpe?g|gif|webp))\\)$`, 'i'))
    if (managedImage) {
      content.push({ type: 'image', attrs: { alt: managedImage[1], src: managedImage[2] } })
      index += 1
      continue
    }
    if (/^!\[[^\]\n]*\]\([^)]+\)\s*$/.test(line)) {
      content.push({ type: 'rawMarkdown', attrs: { source: line } })
      index += 1
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      content.push({ type: 'heading', attrs: { level: heading[1].length }, content: inlineContent(heading[2]) })
      index += 1
      continue
    }

    if (/^[-*_](?:\s*[-*_]){2,}\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) quoted.push(lines[index++].replace(/^>\s?/, ''))
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineContent(quoted.join('\n')) }] })
      continue
    }

    const task = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      const items: RichNode[] = []
      while (index < lines.length) {
        const item = lines[index].match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/)
        if (!item) break
        items.push({ type: 'taskItem', attrs: { checked: item[1].toLowerCase() === 'x' }, content: [{ type: 'paragraph', content: inlineContent(item[2]) }] })
        index += 1
      }
      content.push({ type: 'taskList', content: items })
      continue
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/)
    if (bullet) {
      const items: RichNode[] = []
      while (index < lines.length) {
        const item = lines[index].match(/^[-*+]\s+(.*)$/)
        if (!item) break
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineContent(item[1]) }] })
        index += 1
      }
      content.push({ type: 'bulletList', content: items })
      continue
    }

    const ordered = line.match(/^(\d+)[.)]\s+(.*)$/)
    if (ordered) {
      const items: RichNode[] = []
      const start = Number(ordered[1])
      while (index < lines.length) {
        const item = lines[index].match(/^\d+[.)]\s+(.*)$/)
        if (!item) break
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineContent(item[1]) }] })
        index += 1
      }
      content.push({ type: 'orderedList', ...(start !== 1 ? { attrs: { start } } : {}), content: items })
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length && lines[index].trim() && !isKnownBlockStart(lines[index]) && !/^:::+|^\s*<|^\[\^/.test(lines[index])) {
      paragraph.push(lines[index++])
    }
    content.push({ type: 'paragraph', content: inlineContent(paragraph.join(' ')) })
  }

  return { schemaVersion: 1, root: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } }
}
