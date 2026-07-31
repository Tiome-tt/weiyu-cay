import { describe, expect, it } from 'vitest'
import { plainTextFromMarkdown, renderMarkdown } from './markdownPipeline'

describe('markdownPipeline', () => {
  it('removes executable HTML, event handlers, and unsafe URL protocols', () => {
    const source = [
      '# Safe heading',
      '<script>window.pwned = true</script>',
      '<img src="x" onerror="window.pwned = true">',
      '[unsafe](javascript:alert(1))',
      '[safe](https://example.com/docs)',
    ].join('\n\n')

    const html = renderMarkdown(source)

    expect(html).toContain('<h1>Safe heading</h1>')
    expect(html).toContain('href="https://example.com/docs"')
    expect(html).not.toMatch(/script|onerror|javascript:/i)
    expect(source).toContain('<script>window.pwned = true</script>')
  })

  it('preserves supported GFM tables, strikethrough, and task lists', () => {
    const html = renderMarkdown([
      '| Item | Done |',
      '| --- | --- |',
      '| ~~Draft~~ | yes |',
      '',
      '- [x] shipped',
    ].join('\n'))

    expect(html).toContain('<table>')
    expect(html).toContain('<del>Draft</del>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('checked')
  })

  it('extracts concise plain text without Markdown punctuation, URLs, or HTML content', () => {
    const text = plainTextFromMarkdown(
      '# Goal\n\nWrite **safe** [notes](https://example.com).\n\n<script>alert(1)</script>\n\n`const ready = true`',
    )

    expect(text).toBe('Goal Write safe notes. const ready = true')
    expect(text).not.toMatch(/https:|alert|[\#*`<>]/)
  })
})
