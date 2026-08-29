export function tableMarkdown(rows = 3, columns = 3) {
  return tableMarkdownFromCells(Array.from({ length: rows }, (_, row) => Array.from({ length: columns }, (_, column) => row === 0 ? `列 ${column + 1}` : `内容 ${row}-${column + 1}`)))
}

export function tableMarkdownFromCells(cells: string[][]) {
  const normalized = cells.length === 0 ? [['']] : cells
  const columns = Math.max(1, ...normalized.map((row) => row.length))
  const header = Array.from({ length: columns }, (_, column) => normalized[0]?.[column]?.trim() || `列 ${column + 1}`)
  const divider = header.map(() => '---')
  const body = normalized.slice(1).map((row) => Array.from({ length: columns }, (_, column) => row[column]?.trim() ?? ''))
  return [formatRow(header), formatRow(divider), ...body.map(formatRow)].join('\n')
}

export function formatRow(cells: string[]) {
  return `| ${cells.map(escapeTableCell).join(' | ')} |`
}

function escapeTableCell(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
}

export const markdownSnippets = {
  link: '[链接文字](https://example.com)',
  image: '![图片说明](图片地址)',
  code: '```\n代码内容\n```',
  quote: '> 引用内容',
  task: '- [ ] 待办事项',
  divider: '---',
} as const
