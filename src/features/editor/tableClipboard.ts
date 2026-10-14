/** Parse clipboard TSV, including Excel-style quoted fields and empty trailing cells. */
export function parseTsv(source: string): string[][] {
  const rows: string[][] = [[]]
  let field = ''
  let quoted = false

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (quoted) {
        quoted = false
      } else if (field.length === 0) {
        quoted = true
      } else field += character
    } else if (character === '\t' && !quoted) {
      rows[rows.length - 1]?.push(field)
      field = ''
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1
      rows[rows.length - 1]?.push(field)
      rows.push([])
      field = ''
    } else {
      field += character
    }
  }

  rows[rows.length - 1]?.push(field)
  if (rows.length > 1 && rows[rows.length - 1]?.length === 1 && rows[rows.length - 1]?.[0] === '' && /(?:\r\n|\r|\n)$/.test(source)) {
    rows.pop()
  }
  return rows
}

export function serializeTsv(rows: readonly (readonly string[])[]): string {
  return rows.map(row => row.map(value => /[\t\r\n"]/.test(value)
    ? '"' + value.replace(/"/g, '""') + '"' : value).join('\t')).join('\n')
}
