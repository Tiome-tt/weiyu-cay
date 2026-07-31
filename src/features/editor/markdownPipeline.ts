import rehypeSanitize from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'

interface MarkdownNode {
  type?: unknown
  value?: unknown
  alt?: unknown
  children?: unknown
}

const parser = unified().use(remarkParse).use(remarkGfm)
const renderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSanitize)
  .use(rehypeStringify)

export function renderMarkdown(markdown: string): string {
  return String(renderer.processSync(markdown))
}

export function plainTextFromMarkdown(markdown: string): string {
  const fragments: string[] = []
  collectText(parser.parse(markdown) as MarkdownNode, fragments)
  return fragments.join(' ').replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim()
}

function collectText(node: MarkdownNode, fragments: string[]) {
  if (node.type === 'html' || node.type === 'definition' || node.type === 'yaml') return
  if (
    (node.type === 'text' || node.type === 'code' || node.type === 'inlineCode') &&
    typeof node.value === 'string'
  ) {
    fragments.push(node.value)
    return
  }
  if (node.type === 'image' && typeof node.alt === 'string') {
    fragments.push(node.alt)
    return
  }
  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) collectText(child as MarkdownNode, fragments)
  }
}
