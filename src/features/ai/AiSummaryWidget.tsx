import {text as uiText} from '../../shared/i18n'
import { ErrorNotification } from '../../shared/notifications'
import { useEffect, useState, type ReactNode } from 'react'
import type { AiPort, AiSummaryEmphasisKind, AiSummaryProgress, AiSummaryResult } from '../../domain/ports'
import { Icon } from '../../shared/Icon'
import { requestDeepSeekRelabel, requestDeepSeekSummary } from './deepSeekSummary'
import { noteContentHash } from './summaryHash'
import './ai-summary.css'

const ANNOTATION_KINDS = ['concept', 'mechanism', 'evidence', 'conclusion', 'action', 'caveat'] as const
const ANNOTATION_LABELS: Record<AiSummaryEmphasisKind, string> = {
  concept: uiText("概念","Concept"),
  mechanism: uiText("机制","Mechanism"),
  evidence: uiText("依据","Evidence"),
  conclusion: uiText("结论","Conclusion"),
  action: uiText("行动","Action"),
  caveat: uiText("限制","Limitation"),
}
interface AiSummaryWidgetProps {
  noteId?: string
  title: string
  markdown: string
  ai?: AiPort
  /** Kept for isolated renderer tests and non-Tauri previews. */
  apiKey?: string
  model?: string
  onOpenSettings?(): void
  waitForImages?(): Promise<void>
  unsupported?: boolean
}

export function AiSummaryWidget(props:AiSummaryWidgetProps) {
  return props.unsupported ? <UnavailableSummary/> : <NoteAiSummaryWidget {...props}/>
}
function UnavailableSummary(){
  const [open,setOpen]=useState(false)
  useEffect(()=>{
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false)}
    window.addEventListener('keydown',close)
    return ()=>window.removeEventListener('keydown',close)
  },[])
  return <aside className={`ai-summary-widget${open?' ai-summary-widget--open':''}`} data-boundary="editor">
    {!open ? <button className="ai-summary-widget__rail" type="button" aria-label={uiText("打开 AI 总结","Open AI summary")} onClick={()=>setOpen(true)}><Icon name="ai-fusion" size={24}/><span>{uiText("AI 总结","AI summary")}</span></button> : <section className="ai-summary-widget__panel" role="dialog" aria-label={uiText("AI 总结","AI summary")} aria-modal="false"><header className="ai-summary-widget__header"><div className="ai-summary-widget__title"><Icon name="ai-fusion" size={22}/><strong>{uiText("AI 总结","AI summary")}</strong></div><div className="ai-summary-widget__header-actions"><button type="button" aria-label={uiText("关闭 AI 总结","Close AI summary")} onClick={()=>setOpen(false)}><Icon name="close" size={15}/></button></div></header><div className="ai-summary-widget__empty"><p>{uiText("暂不支持该格式文件进行AI总结。","AI summaries are not yet supported for this file format.")}</p></div></section>}
  </aside>
}
function NoteAiSummaryWidget({ noteId, title, markdown, ai, apiKey, model, onOpenSettings, waitForImages }: AiSummaryWidgetProps) {
  const effectiveNoteId = noteId ?? title
  const [open, setOpen] = useState(false)
  const [showEmphasis, setShowEmphasis] = useState(true)
  const [filterOpen, setFilterOpen] = useState(false)
  const [showOutlineEmphasis, setShowOutlineEmphasis] = useState(false)
  const [visibleKinds, setVisibleKinds] = useState<ReadonlySet<AiSummaryEmphasisKind>>(() => new Set(ANNOTATION_KINDS))
  const [busy, setBusy] = useState(false)
  const [cacheLoading, setCacheLoading] = useState(false)
  const [configured, setConfigured] = useState(Boolean(apiKey))
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<AiSummaryResult | null>(null)
  const [stale, setStale] = useState(false)
  const [progress, setProgress] = useState<AiSummaryProgress | null>(null)

  useEffect(() => {
    let active = true
    if (ai === undefined) {
      setConfigured(Boolean(apiKey))
      return () => { active = false }
    }
    void ai.getCredentialStatus().then((status) => {
      if (active) setConfigured(status.configured)
    }).catch(() => {
      if (active) setConfigured(false)
    })
    return () => { active = false }
  }, [ai, apiKey])

  useEffect(() => {
    setOpen(false)
    setBusy(false)
    setCacheLoading(false)
    setError(null)
    setSummary(null)
    setProgress(null)
  }, [effectiveNoteId])

  useEffect(() => {
    if (!open || ai === undefined) return undefined
    let active = true
    setCacheLoading(true)
    void ai.getCachedSummary(effectiveNoteId).then((cached) => {
      if (active) setSummary(cached)
    }).catch(() => {
      if (active) setError(uiText("无法读取已保存的总结，请关闭面板后重试。","Could not read the saved summary. Close the panel and try again."))
    }).finally(() => {
      if (active) setCacheLoading(false)
    })
    return () => { active = false }
  }, [ai, effectiveNoteId, open])
  useEffect(() => {
    if (ai?.subscribeSummaryProgress === undefined) return undefined
    let active = true
    let stop: (() => void) | undefined
    void ai.subscribeSummaryProgress((next) => {
      if (active && next.noteId === effectiveNoteId) setProgress(next)
    }).then((unsubscribe) => {
      if (active) stop = unsubscribe
      else unsubscribe()
    }).catch(() => undefined)
    return () => {
      active = false
      stop?.()
    }
  }, [ai, effectiveNoteId])

  useEffect(() => {
    if (!open) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [open])

  useEffect(() => {
    let active = true
    if (!summary?.sourceHash) {
      setStale(false)
      return () => { active = false }
    }
    void noteContentHash(markdown).then((hash) => {
      if (active) setStale(hash !== undefined && hash !== summary.sourceHash)
    })
    return () => { active = false }
  }, [markdown, summary])
  const generate = async (force = false) => {
    if (!configured) return
    setBusy(true)
    setError(null)
    try {
      if (waitForImages !== undefined) {
        setProgress({ noteId: effectiveNoteId, phase: 'images', current: 0, total: 1, message: uiText("正在等待图片加载完成…","Waiting for images to load…") })
        await waitForImages()
      }
      const next = ai === undefined
        ? await requestDeepSeekSummary({ noteId: effectiveNoteId, title, markdown, apiKey: apiKey ?? '', model, force, onProgress: setProgress })
        : await ai.summarize({ noteId: effectiveNoteId, title, markdown, model, force })
      setSummary(next)
    } catch (error: unknown) {
      const diagnostic = typeof error === 'object' && error !== null && 'diagnostic' in error && typeof error.diagnostic === 'string' ? error.diagnostic : error instanceof Error ? error.message : undefined
      if (import.meta.env.DEV && diagnostic !== undefined) console.error('[AI summary] generation failed', diagnostic)
      setError(uiText("总结生成失败，请检查 API 设置或网络连接。","Could not generate a summary. Check your API settings or network connection."))
    } finally {
      setBusy(false)
    }
  }

  const relabel = async () => {
    if (!configured || summary === null) return
    setBusy(true)
    setError(null)
    setProgress({ noteId: effectiveNoteId, phase: 'labels', current: 0, total: 1, message: uiText("正在重新标注已保存的总结…","Annotating the saved summary…") })
    try {
      const next = ai?.relabel !== undefined
        ? await ai.relabel({ noteId: effectiveNoteId, model })
        : await requestDeepSeekRelabel({ noteId: effectiveNoteId, summary, apiKey: apiKey ?? '', model })
      setSummary(next)
    } catch {
      setError(uiText("重新标注失败，已保存的总结仍可阅读。","Annotation failed. Your saved summary is still available."))
    } finally {
      setBusy(false)
    }
  }

  const toggleKind = (kind: AiSummaryEmphasisKind) => {
    setVisibleKinds((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }
  const openPanel = () => {
    setOpen(true)
  }

  return (
    <aside className={`ai-summary-widget${open ? ' ai-summary-widget--open' : ''}`} data-testid="ai-summary-widget" data-boundary="editor">
      {!open && (
        <button className="ai-summary-widget__rail" type="button" aria-label={uiText("打开 AI 总结","Open AI summary")} onClick={openPanel}>
          <Icon name="ai-fusion" size={24} />
          <span>{uiText("AI 总结","AI summary")}</span>
        </button>
      )}
      {open && (
        <section className="ai-summary-widget__panel" role="dialog" aria-label={uiText("AI 总结","AI summary")} aria-modal="false">
          <header className="ai-summary-widget__header">
            <div className="ai-summary-widget__title"><Icon name="ai-fusion" size={22} /><strong>{uiText("AI 总结","AI summary")}</strong><span className="ai-summary-widget__model">{model === 'deepseek-v4-pro' ? 'V4 Pro' : 'V4.1 Flash'}</span></div>
            <div className="ai-summary-widget__header-actions">
              <button type="button" className="ai-summary-widget__filter-toggle" aria-label={uiText("筛选标注","Filter annotations")} title={uiText("筛选标注","Filter annotations")} aria-expanded={filterOpen} onClick={() => setFilterOpen((current) => !current)}>☷</button>
              <button type="button" className="ai-summary-widget__view-toggle" aria-label={showEmphasis ? uiText("隐藏重点标注","Hide highlights") : uiText("显示重点标注","Show highlights")} title={showEmphasis ? uiText("隐藏重点标注","Hide highlights") : uiText("显示重点标注","Show highlights")} aria-pressed={showEmphasis} onClick={() => setShowEmphasis((current) => !current)}><Icon name="preview" size={17} /></button>
              <button type="button" aria-label={uiText("折叠 AI 总结","Collapse AI summary")} title={uiText("折叠","Collapse")} onClick={() => setOpen(false)}><Icon name="chevron-right" size={15} /></button>
              <button type="button" aria-label={uiText("关闭 AI 总结","Close AI summary")} title={uiText("关闭","Close")} onClick={() => setOpen(false)}><Icon name="close" size={15} /></button>
            </div>
          </header>
          {!configured && summary === null && !cacheLoading ? (
            <div className="ai-summary-widget__empty">
              <p>{uiText("还没有配置 DeepSeek API Key","No DeepSeek API key configured")}</p>
              <span>{uiText("请在 AI 设置中填写 API Key。","Enter your API key in AI settings.")}</span>
              {onOpenSettings && <button type="button" onClick={onOpenSettings}>{uiText("打开设置","Open settings")}</button>}
            </div>
          ) : (
            <div className="ai-summary-widget__body">
              {cacheLoading && <p role="status">{uiText("正在读取已保存的总结…","Reading saved summary…")}</p>}
              {busy && <ProgressStatus progress={progress} />}
              <ErrorNotification error={error} />
              {summary && filterOpen && <fieldset className="ai-summary-widget__filters"><legend>{uiText("显示的标注类别","Visible annotation categories")}</legend>{ANNOTATION_KINDS.map((kind) => <label key={kind}><input type="checkbox" checked={visibleKinds.has(kind)} onChange={() => toggleKind(kind)} />{ANNOTATION_LABELS[kind]}</label>)}<label className="ai-summary-widget__outline-option"><input type="checkbox" checked={showOutlineEmphasis} onChange={() => setShowOutlineEmphasis((current) => !current)} />{uiText("在大纲显示标注","Show annotations in the outline")}</label></fieldset>}
              {stale && summary && <p className="ai-summary-widget__stale-warning" role="status">{uiText("笔记已修改，此总结可能过期。","This note has changed. The summary may be out of date.")}</p>}
              {summary && (summary.annotationVersion ?? 0) < 2 && (summary.emphasis?.length ?? 0) > 0 && !busy && <p className="ai-summary-widget__annotation-warning" role="status">{uiText("旧版标注尚未筛选重点，可点击重新标注。","These older annotations have not been filtered. Reannotate to update them.")}</p>}
              {summary?.annotationStatus === 'failed' && !busy && <p className="ai-summary-widget__annotation-warning" role="status">{uiText("总结已保存，重点标注未完成。可以单独重试。","The summary was saved, but highlighting is incomplete. You can retry it separately.")}</p>}
              {summary && !busy && <SummarySections summary={summary} showEmphasis={showEmphasis} visibleKinds={visibleKinds} showOutlineEmphasis={showOutlineEmphasis} />}
              {!busy && !cacheLoading && configured && <div className="ai-summary-widget__actions">{summary && <button type="button" onClick={() => void relabel()}>{uiText("重新标注","Reannotate")}</button>}<button className="ai-summary-widget__regenerate" type="button" onClick={() => void generate(summary !== null)}>{summary ? uiText("重新生成","Regenerate") : uiText("生成总结","Generate summary")}</button></div>}
            </div>
          )}
        </section>
      )}
    </aside>
  )
}

function ProgressStatus({ progress }: { progress: AiSummaryProgress | null }) {
  const percentage = progress === null
    ? 8
    : progress.phase === 'complete'
      ? 100
      : progress.total > 0
        ? Math.max(8, Math.min(95, Math.round((progress.current / progress.total) * 90) + 5))
        : 15
  return (
    <div className="ai-summary-widget__progress" role="status" aria-live="polite">
      <div className="ai-summary-widget__progress-track"><span style={{ width: `${percentage}%` }} /></div>
      <p><span className="ai-summary-widget__loader" aria-hidden="true" />{progress?.message ?? uiText("正在分析笔记内容…","Analyzing note…")}</p>
    </div>
  )
}
type EmphasisSpan = { start: number; end: number; kind: AiSummaryEmphasisKind }
type FocusItem = { blockId: string; text: string; kind: AiSummaryEmphasisKind }

function summaryBlock(summary: AiSummaryResult, blockId: string): string | undefined {
  const parts = blockId.split('/')
  if (parts.length === 1 && parts[0] === 'summary') return summary.summary
  if (parts.length === 2 && parts[0] === 'keyPoints') return summary.keyPoints[Number(parts[1])]
  if (parts.length === 3 && parts[0] === 'outline' && parts[2] === 'heading') return summary.outline?.[Number(parts[1])]?.heading
  if (parts.length === 4 && parts[0] === 'outline' && parts[2] === 'points') return summary.outline?.[Number(parts[1])]?.points[Number(parts[3])]
  return undefined
}

function quoteStart(text: string, quote: string, occurrence: number): number {
  if (!quote || !Number.isSafeInteger(occurrence) || occurrence < 0) return -1
  let start = -1
  let cursor = 0
  for (let index = 0; index <= occurrence; index += 1) {
    start = text.indexOf(quote, cursor)
    if (start < 0) return -1
    cursor = start + quote.length
  }
  return start
}

function focusSentence(text: string, start: number, quoteLength: number): string {
  // Presentation-only excerpting: preserve the source sentence, never invent or truncate its content.
  const separators = ['。', '！', '？', '；', '\n']
  const leading = Math.max(...separators.map((separator) => text.lastIndexOf(separator, start - 1)))
  const quoteEnd = start + quoteLength
  let trailing = separators.some((separator) => text.slice(0, quoteEnd).endsWith(separator)) ? quoteEnd : text.length
  if (trailing === text.length) {
    for (const separator of separators) {
      const next = text.indexOf(separator, quoteEnd)
      if (next >= 0 && next < trailing) trailing = next + separator.length
    }
  }
  return text.slice(leading + 1, trailing).trim()
}
function SummarySections({ summary, showEmphasis, visibleKinds, showOutlineEmphasis }: {
  summary: AiSummaryResult
  showEmphasis: boolean
  visibleKinds: ReadonlySet<AiSummaryEmphasisKind>
  showOutlineEmphasis: boolean
}) {
  const outline = summary.outline ?? []
  const keywords = summary.keywords ?? []
  const emphasis = summary.emphasis ?? []
  const focusItems: FocusItem[] = []
  if ((summary.annotationVersion ?? 0) >= 2) {
    const seen = new Set<string>()
    for (const item of emphasis) {
      if (!item?.blockId || !ANNOTATION_KINDS.includes(item.kind) || typeof item.quote !== 'string') continue
      const text = summaryBlock(summary, item.blockId)
      const quote = item.quote.trim()
      const start = text ? quoteStart(text, quote, item.occurrence ?? -1) : -1
      if (!text || start < 0 || seen.has(item.blockId)) continue
      seen.add(item.blockId)
      focusItems.push({ blockId: item.blockId, text: focusSentence(text, start, quote.length), kind: item.kind })
    }
  }
  const renderText = (text: string, blockId: string, allowHighlight = true) => {
    if (!allowHighlight) return text
    const candidates: EmphasisSpan[] = []
    for (const item of emphasis) {
      if (!item || !ANNOTATION_KINDS.includes(item.kind) || item.blockId !== blockId || typeof item.quote !== 'string') continue
      const quote = item.quote.trim()
      const start = quoteStart(text, quote, item.occurrence ?? -1)
      if (start >= 0) candidates.push({ start, end: start + quote.length, kind: item.kind })
    }
    candidates.sort((a, b) => a.start - b.start || b.end - a.end)
    const output: ReactNode[] = []
    let cursor = 0
    for (const item of candidates) {
      if (item.start < cursor) continue
      if (item.start > cursor) output.push(text.slice(cursor, item.start))
      const active = showEmphasis && (summary.annotationVersion ?? 0) >= 2 && visibleKinds.has(item.kind)
      const label = ANNOTATION_LABELS[item.kind]
      const segment = text.slice(item.start, item.end)
      output.push(<span key={item.kind + '-' + item.start} className={'ai-summary-widget__emphasis ai-summary-widget__emphasis--' + item.kind + (active ? '' : ' ai-summary-widget__emphasis--muted')} data-emphasis={active ? item.kind : undefined} title={active ? label : undefined} role="text" aria-label={active ? label + '：' + segment : undefined}>{segment}</span>)
      cursor = item.end
    }
    if (cursor < text.length) output.push(text.slice(cursor))
    return output.length > 0 ? output : text
  }
  return (
    <div className={'ai-summary-widget__sections' + (showEmphasis ? '' : ' ai-summary-widget__sections--plain')}>
      <section className="ai-summary-widget__summary"><h3><span aria-hidden="true">▤</span>{uiText("一句话总结","One-sentence summary")}</h3><p>{renderText(summary.summary, 'summary')}</p></section>
      {focusItems.length > 0 && <section className="ai-summary-widget__focus" aria-label={uiText("重点速览","At a glance")}><h3><span aria-hidden="true">✦</span>{uiText("重点速览","At a glance")}</h3><ol>{focusItems.map((item) => {
        const active = showEmphasis && (summary.annotationVersion ?? 0) >= 2 && visibleKinds.has(item.kind)
        return <li key={item.blockId} className={'ai-summary-widget__focus-item ai-summary-widget__focus-item--' + item.kind + (active ? '' : ' ai-summary-widget__focus-item--muted')} data-emphasis={active ? item.kind : undefined} title={active ? ANNOTATION_LABELS[item.kind] : undefined} aria-label={active ? ANNOTATION_LABELS[item.kind] + "： " + item.text : undefined}>{item.text}</li>
      })}</ol></section>}
      {summary.keyPoints.length > 0 && <details className="ai-summary-widget__key-points" open={focusItems.length === 0}><summary><span aria-hidden="true">☷</span>{focusItems.length > 0 ? uiText("更多要点","More key points") : uiText("关键要点","Key points")}</summary><ol>{summary.keyPoints.map((item, index) => <li key={index + '-' + item}>{renderText(item, 'keyPoints/' + index)}</li>)}</ol></details>}
      {outline.length > 0 && <details><summary><span aria-hidden="true">☰</span>{uiText("章节大纲","Outline")}</summary><div className="ai-summary-widget__outline">{outline.map((item, index) => <div key={index + '-' + item.heading}><strong>{renderText(item.heading, 'outline/' + index + '/heading', showOutlineEmphasis)}</strong>{item.points.length > 0 && <ul>{item.points.map((point, pointIndex) => <li key={pointIndex + '-' + point}>{renderText(point, 'outline/' + index + '/points/' + pointIndex, showOutlineEmphasis)}</li>)}</ul>}</div>)}</div></details>}
      {keywords.length > 0 && <section><h3><span aria-hidden="true">#</span>{uiText("关键词","Keywords")}</h3><div className="ai-summary-widget__chips ai-summary-widget__chips--quiet">{keywords.map((item) => <span key={item}>{item}</span>)}</div></section>}
    </div>
  )
}
