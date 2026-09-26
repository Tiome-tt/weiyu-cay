import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDeepSeekRelabel, requestDeepSeekSummary } from './deepSeekSummary'

function completion(value: object) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
describe('requestDeepSeekSummary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('requests structured summary output from DeepSeek', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ summary: '摘要', keyPoints: ['要点'], todos: ['待办'] }))
      .mockResolvedValueOnce(completion({ emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '摘要', occurrence: 0 }] }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestDeepSeekSummary({ title: '标题', markdown: '正文', apiKey: 'secret', model: 'deepseek-flash' })).resolves.toMatchObject({
      summary: '摘要', keyPoints: ['要点'], outline: [], todos: [], keywords: [], emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '摘要', occurrence: 0 }], annotationStatus: 'ready', annotationVersion: 2,
    })
    const requestBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as { messages: Array<{ content: string }> }
    expect(requestBody.messages[0].content).not.toContain('todos')
    expect(requestBody.messages[0].content).toContain('从原始笔记中选')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions', expect.objectContaining({
      method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
    }))
  })
  it('keeps only second-pass labels that quote the generated summary exactly', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ summary: '多头注意力关注不同关系。', keyPoints: ['但长序列开销较高。'] }))
      .mockResolvedValueOnce(completion({ emphasis: [
        { kind: 'conclusion', blockId: 'summary', quote: '关注不同关系', occurrence: 0 },
        { kind: 'caveat', blockId: 'keyPoints/0', quote: '长序列开销较高', occurrence: 0 },
        { kind: 'evidence', blockId: 'summary', quote: '虚构数字', occurrence: 0 },
      ] }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestDeepSeekSummary({ title: '标题', markdown: '正文', apiKey: 'secret' })).resolves.toMatchObject({
      emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '关注不同关系', occurrence: 0 }, { kind: 'caveat', blockId: 'keyPoints/0', quote: '长序列开销较高', occurrence: 0 }],
    })
  })
  it('accepts an exact label from an outline heading and requests distinct label meanings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ summary: '全文摘要。', outline: [{ heading: '参数高效微调', points: ['方法概述。'] }] }))
      .mockResolvedValueOnce(completion({ emphasis: [{ kind: 'concept', blockId: 'outline/0/heading', quote: '参数高效微调', occurrence: 0 }] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestDeepSeekSummary({ title: '标题', markdown: '正文', apiKey: 'secret' })
    expect(result.emphasis).toEqual([{ kind: 'concept', blockId: 'outline/0/heading', quote: '参数高效微调', occurrence: 0 }])
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body) as { messages: Array<{ content: string }> }
    expect(body.messages[0].content).toContain('outline/序号/heading')
    expect(body.messages[0].content).toContain('综合判断')
    expect(body.messages[0].content).toContain('按全篇价值排序')
    expect(body.messages[0].content).toContain('量化成效属于 evidence')
    expect(body.messages[0].content).toContain('如何工作、因果')
  })
  it('asks the model to label the completed summary in a second request without resending the note', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ summary: '多头注意力关注不同关系。', keyPoints: ['但长序列开销较高。'], keywords: ['注意力'] }))
      .mockResolvedValueOnce(completion({ emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '关注不同关系', occurrence: 0 }, { kind: 'caveat', blockId: 'keyPoints/0', quote: '长序列开销较高', occurrence: 0 }, { kind: 'concept', blockId: 'summary', quote: '注意力', occurrence: 0 }, { kind: 'evidence', quote: '不存在' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestDeepSeekSummary({ title: '标题', markdown: '原始笔记不应再次发送', apiKey: 'secret' })
    expect(result.emphasis).toEqual([{ kind: 'conclusion', blockId: 'summary', quote: '关注不同关系', occurrence: 0 }, { kind: 'caveat', blockId: 'keyPoints/0', quote: '长序列开销较高', occurrence: 0 }, { kind: 'concept', blockId: 'summary', quote: '注意力', occurrence: 0 }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as { body: string }).body) as { messages: Array<{ content: string }> }
    expect(secondBody.messages[1].content).toContain('多头注意力关注不同关系')
    expect(secondBody.messages[1].content).not.toContain('原始笔记不应再次发送')
  })
  it('reuses a cached note summary until force regeneration', async () => {
    let requests = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      requests += 1
      return Promise.resolve(completion(requests % 2 === 1
        ? { summary: '首次摘要' }
        : { emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '首次摘要', occurrence: 0 }] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestDeepSeekSummary({ noteId: 'note-cache-test', title: '标题', markdown: '正文', apiKey: 'secret' })).resolves.toMatchObject({ summary: '首次摘要' })
    await expect(requestDeepSeekSummary({ noteId: 'note-cache-test', title: '标题', markdown: '正文已修改', apiKey: 'secret' })).resolves.toMatchObject({ summary: '首次摘要' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(requestDeepSeekSummary({ noteId: 'note-cache-test', title: '标题', markdown: '正文', apiKey: 'secret', force: true })).resolves.toMatchObject({ summary: '首次摘要' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('accepts fenced annotation JSON from the second model response', async () => {
    const fenced = new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"emphasis":[{"kind":"conclusion","blockId":"summary","quote":"有效结论","occurrence":0}]}\n```' } }] }), { status: 200 })
    const fetchMock = vi.fn().mockResolvedValueOnce(completion({ summary: '有效结论。' })).mockResolvedValueOnce(fenced)
    vi.stubGlobal('fetch', fetchMock)
    await expect(requestDeepSeekSummary({ title: '标题', markdown: '正文', apiKey: 'secret' })).resolves.toMatchObject({
      emphasis: [{ kind: 'conclusion', blockId: 'summary', quote: '有效结论', occurrence: 0 }],
    })
  })
  it('keeps a cached summary when its annotation request fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(completion({ summary: '可重试摘要' }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = { noteId: 'label-retry-note', title: '标题', markdown: '正文', apiKey: 'secret' }
    await expect(requestDeepSeekSummary(request)).resolves.toMatchObject({ summary: '可重试摘要', annotationStatus: 'failed' })
    await expect(requestDeepSeekSummary(request)).resolves.toMatchObject({ summary: '可重试摘要' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('relabels only the saved summary, never the original note', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion({ emphasis: [
      { kind: 'action', blockId: 'summary', quote: '周五修复', occurrence: 0 },
    ] }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await requestDeepSeekRelabel({
      noteId: 'relabel-test', apiKey: 'secret', summary: {
        summary: '周五修复。', keyPoints: [], outline: [], todos: [], keywords: [], emphasis: [],
      },
    })
    expect(result.emphasis).toEqual([{ kind: 'action', blockId: 'summary', quote: '周五修复', occurrence: 0 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body)
    expect(body.messages[1].content).toContain('周五修复')
    expect(body.messages[1].content).not.toContain('原始笔记')
  })
  it('returns a safe error for non-success responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))

    await expect(requestDeepSeekSummary({ title: '标题', markdown: '正文', apiKey: 'secret' })).rejects.toThrow('DeepSeek request failed')
  })
})
