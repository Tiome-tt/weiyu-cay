import type { AiSummaryEmphasis, AiSummaryProgress, AiSummaryResult } from '../../domain/ports'
import { noteContentHash } from './summaryHash'

export type { AiSummaryResult }

interface DeepSeekSummaryRequest {
  noteId?: string
  title: string
  markdown: string
  apiKey: string
  model?: string
  signal?: AbortSignal
  force?: boolean
  onProgress?(progress: AiSummaryProgress): void
}

const DEFAULT_MODEL = 'deepseek-flash'

const browserSummaryCache = new Map<string, AiSummaryResult>()

export async function requestDeepSeekSummary(input: DeepSeekSummaryRequest): Promise<AiSummaryResult> {
  const cacheKey = input.noteId
  if (cacheKey !== undefined && !input.force) {
    const cached = browserSummaryCache.get(cacheKey)
    if (cached !== undefined) {
      input.onProgress?.({ noteId: cacheKey, phase: 'complete', current: 1, total: 1, message: '已读取已保存的 AI 总结' })
      return cached
    }
  }
  input.onProgress?.({ noteId: cacheKey ?? input.title, phase: 'summary', current: 0, total: 1, message: '正在生成 AI 总结…' })
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: input.signal,
    body: JSON.stringify({
      model: input.model || DEFAULT_MODEL,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你是微屿的笔记整理助手。只根据用户提供的笔记内容总结，不补充笔记中没有的事实；无法确认的内容不要猜测。图表描述已经插入原文对应位置，必须把其中的有效信息和相邻正文一起综合到 summary、keyPoints、outline 中，不要单独输出图片说明字段。为避免输出被截断：summary 用一两句话表达核心论点，不要罗列主题名；keyPoints 从原始笔记中选全篇真正值得记住的判断、关键机制、可靠依据或必要限制，按重要性排序，写成可独立理解的完整要点，避免术语清单、泛泛事实和与 outline 重复；keyPoints 最多 6 条，outline 必须保留原文中的全部章节标题，outline 下的要点数量和详略由模型根据内容自行规划；内容较多时压缩表述，但不要遗漏章节，keywords 最多 8 个；每条要点尽量不超过 60 个中文字符。输出严格 JSON，字段为 summary、keyPoints、outline（对象数组，每项含 heading 和 points）、keywords。不要生成 emphasis；生成完成后会单独分析标签。',
        },
        {
          role: 'user',
          content: `笔记标题：${input.title}\n\n笔记内容：\n${input.markdown}`,
        },
      ],
    }),
  })

  if (!response.ok) {
    throw new Error(`DeepSeek request failed with status ${response.status}`)
  }

  const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> }
  const choice = payload.choices?.[0]
  if (choice?.finish_reason === 'length') throw new Error('DeepSeek summary was truncated by the output limit; please regenerate')
  const content = choice?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('DeepSeek returned an empty summary')
  }

  let result: AiSummaryResult
  try {
    result = normalizeSummary(parseJsonObject(content) as Partial<AiSummaryResult>)
  } catch {
    result = normalizeSummary({ summary: content.trim() })
  }
  result.emphasis = []
  result.annotationStatus = 'failed'
  result.sourceHash = await noteContentHash(input.markdown)
  if (cacheKey !== undefined) browserSummaryCache.set(cacheKey, result)
  input.onProgress?.({ noteId: cacheKey ?? input.title, phase: 'labels', current: 0, total: 1, message: '正在给总结标注重点…' })
  try {
    result = await requestDeepSeekRelabel({ noteId: cacheKey, summary: result, apiKey: input.apiKey, model: input.model, signal: input.signal })
  } catch {
    // The durable summary remains available even when the optional label pass fails.
  }
  if (cacheKey !== undefined) browserSummaryCache.set(cacheKey, result)
  return result
}

export async function requestDeepSeekRelabel(input: {
  noteId?: string
  summary: AiSummaryResult
  apiKey: string
  model?: string
  signal?: AbortSignal
}): Promise<AiSummaryResult> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + input.apiKey, 'Content-Type': 'application/json' },
    signal: input.signal,
    body: JSON.stringify({
      model: input.model || DEFAULT_MODEL,
      stream: false,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是微屿总结的语义标注器。只分析输入的已生成总结，不改写、不补充事实。只输出 JSON 对象，字段 emphasis 为数组，每项包含 kind、blockId、quote、occurrence（从 0 开始）。kind 仅允许 concept（定义是什么）、mechanism（如何工作、因果、流程或关键差异）、evidence（明确支撑说法的数据、公式、实验或实例）、conclusion（综合判断或答案，非普通事实）、action（笔记明确决定执行的事，不能自行提出建议）、caveat（明示的前提、例外、风险或代价）。blockId 仅允许 summary、keyPoints/序号、outline/序号/heading、outline/序号/points/序号，序号从 0 开始。quote 必须逐字出现在所指块中；同块重复时 occurrence 指定第几次。先比较整份总结的所有内容，按全篇价值排序，只挑选真正帮助读者记住或运用笔记的少数重点，通常约三到五处，内容简单可以更少，长文有独立重点时可以更多；不要按章节或类别凑数。数组顺序即重要性顺序。quote 要含足够上下文，能作为完整短句或关键分句独立理解；不要只标术语、孤立数字、章节标题或泛泛事实。summary 仅在包含其他区块没有的核心判断时可选。同一信息在多个区块重复时只留内容最完整的一处。量化成效属于 evidence，不属于 caveat；caveat 只用于明确前提、例外、风险或代价，action 只用于笔记明确提出的待做行动。不要跨块或重叠。允许 emphasis 为空数组。关键词只留在 keywords，不做正文语义标注。不要返回颜色、HTML 或 CSS。' },
        { role: 'user', content: JSON.stringify({ summary: input.summary.summary, keyPoints: input.summary.keyPoints, outline: input.summary.outline, keywords: input.summary.keywords }) },
      ],
    }),
  })
  if (!response.ok) throw new Error('DeepSeek annotation request failed with status ' + response.status)
  const payload = await response.json() as { choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }> }
  const choice = payload.choices?.[0]
  if (choice?.finish_reason === 'length') throw new Error('DeepSeek annotation was truncated by the output limit')
  const content = choice?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek returned empty annotations')
  let annotation: { emphasis?: AiSummaryEmphasis[] }
  try {
    annotation = parseJsonObject(content) as { emphasis?: AiSummaryEmphasis[] }
  } catch {
    throw new Error('DeepSeek returned invalid annotation JSON')
  }
  if (typeof annotation !== 'object' || annotation === null || !Array.isArray(annotation.emphasis)) throw new Error('DeepSeek returned invalid annotations')
  const result = normalizeSummary({ ...input.summary, emphasis: annotation.emphasis, annotationStatus: 'ready', annotationVersion: 2 })
  if (input.noteId !== undefined) browserSummaryCache.set(input.noteId, result)
  return result
}
function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  return JSON.parse(start >= 0 && end >= start ? trimmed.slice(start, end + 1) : trimmed) as unknown
}
function normalizeSummary(value: Partial<AiSummaryResult>): AiSummaryResult {
  const summary = typeof value.summary === 'string' && value.summary.trim().length > 0 ? value.summary.trim() : '暂无一句话总结。'
  const keyPoints = normalizeList(value.keyPoints, 6)
  const outline = Array.isArray(value.outline)
    ? value.outline.filter((item): item is { heading: string; points: string[] } => Boolean(item) && typeof item === 'object' && typeof item.heading === 'string').map((item) => ({ heading: item.heading.trim(), points: normalizeAllList(item.points) })).filter((item) => item.heading.length > 0)
    : []
  const normalized: AiSummaryResult = { summary, keyPoints, outline, todos: [], keywords: normalizeList(value.keywords, 8), emphasis: [] }
  const occupied = new Map<string, Array<[number, number]>>()
  const emphasis = (Array.isArray(value.emphasis) ? value.emphasis : []).flatMap((item): AiSummaryEmphasis[] => {
    if (typeof item !== 'object' || item === null || typeof item.kind !== 'string' || typeof item.quote !== 'string') return []
    if (!['concept', 'mechanism', 'evidence', 'conclusion', 'action', 'caveat'].includes(item.kind)) return []
    if (typeof item.blockId !== 'string' || !Number.isSafeInteger(item.occurrence) || (item.occurrence ?? -1) < 0) return []
    const block = summaryBlock(normalized, item.blockId)
    const quote = item.quote.trim()
    if (block === undefined || !quote || quote.length > 500) return []
    let start = -1
    let cursor = 0
    for (let index = 0; index <= (item.occurrence ?? 0); index += 1) {
      start = block.indexOf(quote, cursor)
      if (start < 0) return []
      cursor = start + quote.length
    }
    const end = start + quote.length
    const spans = occupied.get(item.blockId) ?? []
    if (spans.some(([left, right]) => start < right && end > left)) return []
    spans.push([start, end])
    occupied.set(item.blockId, spans)
    return [{ kind: item.kind as AiSummaryEmphasis['kind'], blockId: item.blockId, occurrence: item.occurrence, quote }]
  })
  return {
    summary,
    keyPoints,
    outline,
    todos: [],
    keywords: normalizeList(value.keywords, 8),
    emphasis,
    annotationStatus: value.annotationStatus,
    annotationVersion: value.annotationVersion,
    sourceHash: value.sourceHash,
  }
}
function summaryBlock(summary: AiSummaryResult, blockId: string): string | undefined {
  const parts = blockId.split('/')
  if (parts.length === 1 && parts[0] === 'summary') return summary.summary
  if (parts.length === 2 && parts[0] === 'keyPoints' && /^(0|[1-9]\d*)$/.test(parts[1])) return summary.keyPoints[Number(parts[1])]
  if (parts[0] !== 'outline' || !/^(0|[1-9]\d*)$/.test(parts[1] ?? '')) return undefined
  const item = summary.outline[Number(parts[1])]
  if (parts.length === 3 && parts[2] === 'heading') return item?.heading
  if (parts.length === 4 && parts[2] === 'points' && /^(0|[1-9]\d*)$/.test(parts[3])) return item?.points[Number(parts[3])]
  return undefined
}
function normalizeAllList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim())
    : []
}
function normalizeList(value: unknown, limit = 8) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, limit)
    : []
}
