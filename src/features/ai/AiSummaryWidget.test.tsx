import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiSummaryWidget } from './AiSummaryWidget'

const requestSummary = vi.fn()

vi.mock('./deepSeekSummary', () => ({
  requestDeepSeekSummary: (...args: unknown[]) => requestSummary(...args),
}))

describe('AiSummaryWidget', () => {
  afterEach(() => cleanup())

  beforeEach(() => {
    requestSummary.mockReset()
  })

  it('allows selecting summary text while application chrome stays non-selectable', () => {
    const css = readFileSync('src/features/ai/ai-summary.css', 'utf8')
    expect(css).toMatch(/\.main-window \.ai-summary-widget__sections[\s\S]*?user-select:\s*text/)
    expect(css).toMatch(/\.main-window \.ai-summary-widget__sections[\s\S]*?-webkit-user-select:\s*text/)
  })
  it('animates emphasis visibility and respects reduced motion', () => {
    const css = readFileSync('src/features/ai/ai-summary.css', 'utf8')
    expect(css).toMatch(/\.ai-summary-widget__emphasis\s*\{[^}]*transition:/)
    expect(css).toMatch(/\.ai-summary-widget__sections--plain \.ai-summary-widget__emphasis/)
    expect(css).toMatch(/\.ai-summary-widget__emphasis--muted/)
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ai-summary-widget__emphasis/)
  })
  it('keeps the one-line summary card surface unchanged when emphasis is hidden', () => {
    const css = readFileSync('src/features/ai/ai-summary.css', 'utf8')
    const plainSummaryRule = css.match(/\.ai-summary-widget__sections--plain \.ai-summary-widget__summary\s*\{([^}]*)\}/)?.[1]
    expect(plainSummaryRule ?? '').not.toMatch(/(?:background|border-left(?:-color)?)\s*:/)
  })
  it('stays inside the editor surface and opens a compact summary panel', async () => {
    requestSummary.mockResolvedValue({
      summary: '这是一篇关于编辑器设计的笔记。',
      keyPoints: ['保留三栏结构', '面板不改变正文布局'],
      todos: ['配置 DeepSeek API'],
    })
    const user = userEvent.setup()

    render(<AiSummaryWidget title="设计笔记" markdown={'# 设计笔记\n\n正文'} apiKey="test-key" />)

    const widget = screen.getByTestId('ai-summary-widget')
    expect(widget.className).toContain('ai-summary-widget')
    expect(widget.getAttribute('data-boundary')).toBe('editor')
    expect(screen.getByRole('button', { name: '打开 AI 总结' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    expect(screen.getByRole('dialog', { name: 'AI 总结' })).toBeTruthy()
    expect(requestSummary).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '生成总结' }))
    await waitFor(() => expect(screen.getByText('一句话总结').closest('section')?.querySelector('p')?.textContent).toBe('这是一篇关于编辑器设计的笔记。'))
    expect(screen.queryByText('核心主题')).toBeNull()
    expect(screen.queryByText('待办事项')).toBeNull()
    expect(requestSummary).toHaveBeenCalledWith(expect.objectContaining({ title: '设计笔记', markdown: '# 设计笔记\n\n正文', apiKey: 'test-key' }))
  })

  it('renders cached semantic emphasis as selectable text without a new model request', async () => {
    const saved = {
      annotationVersion: 2,
      summary: '多头注意力带来不同视角。',
      keyPoints: ['Self-Attention 是关键句；但长序列开销较高，样本数为 128。'],
      outline: [],
      todos: [],
      keywords: ['Self-Attention'],
      emphasis: [
        { kind: 'conclusion', blockId: 'summary', quote: '不同视角', occurrence: 0 },
        { kind: 'mechanism', blockId: 'keyPoints/0', quote: 'Self-Attention 是关键句', occurrence: 0 },
        { kind: 'evidence', blockId: 'keyPoints/0', quote: '128', occurrence: 0 },
        { kind: 'caveat', blockId: 'keyPoints/0', quote: '长序列开销较高', occurrence: 0 },
      ],
    }
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue(saved),
      summarize: vi.fn(),
      saveDeepSeekApiKey: vi.fn(),
      clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="note-2" title="笔记" markdown="正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(container.querySelector('[data-emphasis="conclusion"]')?.textContent).toBe('不同视角'))
    expect(container.querySelector('span.ai-summary-widget__emphasis[data-emphasis="mechanism"]')?.textContent).toBe('Self-Attention 是关键句')
    expect(container.querySelector('span.ai-summary-widget__emphasis[data-emphasis="evidence"]')?.textContent).toBe('128')
    expect(container.querySelector('span.ai-summary-widget__emphasis[data-emphasis="caveat"]')?.textContent).toBe('长序列开销较高')
    expect(ai.summarize).not.toHaveBeenCalled()
  })
  it('keeps an old cached summary readable and offers manual focus relabeling', async () => {
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({
        summary: '旧版总结。', keyPoints: [], outline: [], keywords: [],
        annotationVersion: 1,
        emphasis: [{ kind: 'concept', blockId: 'summary', quote: '旧版', occurrence: 0 }],
      }),
      summarize: vi.fn(), relabel: vi.fn(), saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    render(<AiSummaryWidget noteId="legacy-focus" title="笔记" markdown="正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(screen.getByText('旧版标注尚未筛选重点，可点击重新标注。')).toBeTruthy())
    expect(screen.getByText('一句话总结').closest('section')?.querySelector('p')?.textContent).toBe('旧版总结。')
    expect(ai.relabel).not.toHaveBeenCalled()
  })
  it('renders labels again in outline headings and points when the same quote occurs earlier', async () => {
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({
        annotationVersion: 2,
        summary: '注意力机制是核心。',
        keyPoints: ['注意力机制是核心。'],
        outline: [{ heading: '注意力机制', points: ['注意力机制是核心。'] }],
        keywords: [],
        emphasis: [{ kind: 'conclusion', blockId: 'outline/0/points/0', quote: '注意力机制是核心', occurrence: 0 }, { kind: 'concept', blockId: 'outline/0/heading', quote: '注意力机制', occurrence: 0 }],
      }),
      summarize: vi.fn(), saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="outline-note" title="笔记" markdown="正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(container.querySelector('.ai-summary-widget__outline')).toBeTruthy())
    expect(container.querySelector('.ai-summary-widget__outline [data-emphasis]')).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: '筛选标注' }))
    await userEvent.setup().click(screen.getByRole('checkbox', { name: '在大纲显示标注' }))
    expect(container.querySelector('.ai-summary-widget__outline strong [data-emphasis="concept"]')).toBeTruthy()
    expect(container.querySelector('.ai-summary-widget__outline li [data-emphasis="conclusion"]')).toBeTruthy()
  })
  it('toggles emphasis presentation without removing summary text or calling the model', async () => {
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({ annotationVersion: 2, summary: '注意力关注不同关系。', keyPoints: [], outline: [], keywords: ['注意力'], emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '不同关系', occurrence: 0 }] }),
      summarize: vi.fn(),
      saveDeepSeekApiKey: vi.fn(),
      clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="view-note" title="笔记" markdown="正文" ai={ai} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(container.querySelector('[data-emphasis="conclusion"]')).toBeTruthy())
    const content = container.querySelector('.ai-summary-widget__summary p')?.textContent
    expect(screen.getByRole('button', { name: '隐藏重点标注' }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: '隐藏重点标注' }))
    expect(container.querySelector('.ai-summary-widget__sections--plain')).toBeTruthy()
    expect(container.querySelector('.ai-summary-widget__emphasis--muted')?.getAttribute('title')).toBeNull()
    expect(screen.getByRole('button', { name: '显示重点标注' }).getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('.ai-summary-widget__emphasis--muted')).toBeTruthy()
    expect(container.querySelector('.ai-summary-widget__summary p')?.textContent).toBe(content)
    await user.click(screen.getByRole('button', { name: '显示重点标注' }))
    expect(container.querySelector('.ai-summary-widget__sections--plain')).toBeNull()
    expect(ai.summarize).not.toHaveBeenCalled()
  })
  it('does not invent semantic labels for an older cached summary', async () => {
    const saved = {
      summary: 'Transformer 提高翻译质量，但长序列成本较高。',
      keyPoints: ['实验准确率达到 92%。'],
      outline: [],
      todos: [],
      keywords: ['Transformer'],
    }
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue(saved),
      summarize: vi.fn(),
      saveDeepSeekApiKey: vi.fn(),
      clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="legacy-note" title="笔记" markdown="正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(container.querySelector('.ai-summary-widget__summary p')?.textContent).toBe(saved.summary))
    expect(container.querySelector('[data-emphasis="conclusion"]')).toBeNull()
    expect(container.querySelector('[data-emphasis="mechanism"]')).toBeNull()
    expect(container.querySelector('[data-emphasis="evidence"]')).toBeNull()
    expect(container.querySelector('[data-emphasis="caveat"]')).toBeNull()
    expect(ai.summarize).not.toHaveBeenCalled()
  })
  it('filters six location-bound labels without a request and keeps copied text clean', async () => {
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({
        annotationVersion: 2,
        summary: '缓存失效导致错误，已决定周五修复。',
        keyPoints: [], outline: [], keywords: [],
        emphasis: [
          { kind: 'mechanism', blockId: 'summary', quote: '缓存失效导致错误', occurrence: 0 },
          { kind: 'action', blockId: 'summary', quote: '周五修复', occurrence: 0 },
        ],
      }),
      summarize: vi.fn(), relabel: vi.fn(), saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="filters" title="笔记" markdown="正文" ai={ai} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(container.querySelector('[data-emphasis="mechanism"]')).toBeTruthy())
    expect(container.querySelector('.ai-summary-widget__summary p')?.textContent).toBe('缓存失效导致错误，已决定周五修复。')
    await user.click(screen.getByRole('button', { name: '筛选标注' }))
    await user.click(screen.getByRole('checkbox', { name: '机制' }))
    expect(container.querySelector('[data-emphasis="mechanism"]')).toBeNull()
    expect(container.querySelector('[data-emphasis="action"]')).toBeTruthy()
    expect(ai.summarize).not.toHaveBeenCalled()
    expect(ai.relabel).not.toHaveBeenCalled()
  })
  it('relabels a saved summary without regenerating or waiting for images', async () => {
    const saved = { summary: '旧总结。', keyPoints: [], outline: [], keywords: [], emphasis: [] }
    const relabeled = { ...saved, annotationVersion: 2, emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '旧总结', occurrence: 0 }] }
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue(saved),
      summarize: vi.fn(), relabel: vi.fn().mockResolvedValue(relabeled),
      saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    const waitForImages = vi.fn()
    const { container } = render(<AiSummaryWidget noteId="relabel" title="笔记" markdown="正文" ai={ai} waitForImages={waitForImages} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(screen.getByText('旧总结。')).toBeTruthy())
    await user.click(screen.getByRole('button', { name: '重新标注' }))
    await waitFor(() => expect(container.querySelector('[data-emphasis="conclusion"]')).toBeTruthy())
    expect(ai.relabel).toHaveBeenCalledWith({ noteId: 'relabel', model: undefined })
    expect(ai.summarize).not.toHaveBeenCalled()
    expect(waitForImages).not.toHaveBeenCalled()
  })
  it('warns when the saved summary describes an older version of the note without a model request', async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).buffer)
    vi.stubGlobal('crypto', { subtle: { digest } })
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({
        summary: '旧版摘要。', keyPoints: [], outline: [], keywords: [], emphasis: [], sourceHash: 'f'.repeat(64),
      }),
      summarize: vi.fn(), relabel: vi.fn(), saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    render(<AiSummaryWidget noteId="stale" title="笔记" markdown="新版正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(screen.getByText('笔记已修改，此总结可能过期。')).toBeTruthy())
    expect(ai.summarize).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it('shows ranked whole-note focus and keeps the outline calm until requested', async () => {
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue({
        summary: '模型训练与部署的关键取舍。',
        keyPoints: ['量化使内存占用降低三成。补充背景。'],
        outline: [{ heading: '量化实验', points: ['背景信息。实验中内存占用降低三成，但依赖特定硬件。后续实验。'] }],
        keywords: [], annotationVersion: 2,
        emphasis: [
          { kind: 'evidence', blockId: 'keyPoints/0', quote: '量化使内存占用降低三成。', occurrence: 0 },
          { kind: 'caveat', blockId: 'outline/0/points/0', quote: '依赖特定硬件', occurrence: 0 },
        ],
      }),
      summarize: vi.fn(), relabel: vi.fn(), saveDeepSeekApiKey: vi.fn(), clearDeepSeekApiKey: vi.fn(),
    }
    const { container } = render(<AiSummaryWidget noteId="ranked-note" title="笔记" markdown="正文" ai={ai} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(screen.getByText('重点速览')).toBeTruthy())
    const focus = container.querySelector('.ai-summary-widget__focus')
    expect(focus?.textContent).toContain('量化使内存占用降低三成。')
    expect(focus?.textContent).not.toContain('补充背景')
    expect(focus?.textContent).toContain('实验中内存占用降低三成，但依赖特定硬件。')
    expect(focus?.textContent).not.toContain('背景信息')
    expect(focus?.textContent).not.toContain('后续实验')
    expect(focus?.textContent).not.toContain('依据')
    expect(focus?.textContent).not.toContain('限制')
    expect(container.querySelector('.ai-summary-widget__outline [data-emphasis]')).toBeNull()
    expect(container.querySelector('.ai-summary-widget__key-points')?.hasAttribute('open')).toBe(false)
    await user.click(screen.getByRole('button', { name: '筛选标注' }))
    await user.click(screen.getByRole('checkbox', { name: '在大纲显示标注' }))
    expect(container.querySelector('.ai-summary-widget__outline [data-emphasis="caveat"]')).toBeTruthy()
    expect(ai.summarize).not.toHaveBeenCalled()
    expect(ai.relabel).not.toHaveBeenCalled()
  })
  it('waits for images before requesting a summary', async () => {
    requestSummary.mockResolvedValue({ summary: '图片已纳入总结。', keyPoints: [], todos: [] })
    let release!: () => void
    const waitForImages = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const user = userEvent.setup()

    render(<AiSummaryWidget title="图表笔记" markdown="正文" apiKey="test-key" waitForImages={waitForImages} />)
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))
    expect(waitForImages).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: '生成总结' }))
    await waitFor(() => expect(waitForImages).toHaveBeenCalledOnce())
    expect(requestSummary).not.toHaveBeenCalled()
    expect(screen.getByText('正在等待图片加载完成…')).toBeTruthy()

    release()
    await waitFor(() => expect(requestSummary).toHaveBeenCalledOnce())
  })
  it('opens a saved summary without a model request', async () => {
    const saved = { summary: '上次保存的总结', keyPoints: [], outline: [], todos: [], keywords: [] }
    const ai = {
      getCredentialStatus: vi.fn().mockResolvedValue({ configured: true, storage: 'encrypted-file' }),
      getCachedSummary: vi.fn().mockResolvedValue(saved),
      summarize: vi.fn(),
      saveDeepSeekApiKey: vi.fn(),
      clearDeepSeekApiKey: vi.fn(),
    }
    render(<AiSummaryWidget noteId="note-1" title="笔记" markdown="正文" ai={ai} />)
    await userEvent.setup().click(screen.getByRole('button', { name: '打开 AI 总结' }))
    await waitFor(() => expect(screen.getByText('上次保存的总结')).toBeTruthy())
    expect(screen.queryByText('待办事项')).toBeNull()
    expect(ai.summarize).not.toHaveBeenCalled()
  })
  it('shows the settings action when DeepSeek is not configured', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()

    render(<AiSummaryWidget title="笔记" markdown="正文" onOpenSettings={onOpenSettings} />)
    await user.click(screen.getByRole('button', { name: '打开 AI 总结' }))

    expect(screen.getByText('还没有配置 DeepSeek API Key')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })
})
