import type { ReactNode } from 'react'

export type IconName =
  | 'search'
  | 'settings'
  | 'plus'
  | 'folder'
  | 'note'
  | 'inbox'
  | 'trash'
  | 'more'
  | 'source'
  | 'split'
  | 'preview'
  | 'collapse'
  | 'expand'
  | 'chevron-down'
  | 'chevron-right'
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'star'
  | 'ai-fusion'
  | 'file'
  | 'file-pdf'
  | 'file-word'
  | 'file-excel'
  | 'file-powerpoint'
  | 'file-image'
  | 'file-text'
  | 'file-markdown'
  | 'file-document'
  | 'undo'
  | 'redo'
  | 'brush'
  | 'format'
  | 'keyboard'
  | 'monitor'

interface IconProps {
  name: IconName
  size?: number
  decorative?: boolean
}

const ICON_LABELS: Record<IconName, string> = {
  search: '搜索',
  settings: '设置',
  plus: '新建',
  folder: '文件夹',
  note: '笔记',
  inbox: '收集箱',
  trash: '回收站',
  more: '更多操作',
  source: '源码视图',
  split: '分栏视图',
  preview: '预览视图',
  collapse: '折叠',
  expand: '展开',
  'chevron-down': '折叠下级标题',
  'chevron-right': '展开下级标题',
  minimize: '最小化',
  maximize: '最大化',
  restore: '还原',
  close: '关闭',
  star: '星标',
  'ai-fusion': '微屿 AI 总结',
  file: '附件',
  'file-pdf': 'PDF 文件',
  'file-word': 'Word 文档',
  'file-excel': 'Excel 工作簿',
  'file-powerpoint': 'PowerPoint 演示文稿',
  'file-image': '图片',
  'file-text': '文本文件',
  'file-markdown': 'Markdown 笔记',
  'file-document': '富文档笔记',
  undo: '撤销', redo: '重做', brush: '格式刷', format: '格式工具',
  keyboard: '按键',
  monitor: '系统',
}

function PageGlyph({ children }: { children: ReactNode }) {
  return <><path d="M6 3.5h8l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19Z" fill="currentColor" fillOpacity=".07" /><path d="M14 3.5v2.8a1.2 1.2 0 0 0 1.2 1.2H18" /><path d="M14 3.5v4h4Z" fill="currentColor" fillOpacity=".16" stroke="none" />{children}</>
}

function glyphFor(name: IconName): ReactNode {
  switch (name) {
    case 'search':
      return <><circle cx="10.5" cy="10.5" r="6" fill="currentColor" fillOpacity=".07" /><path d="m15 15 4.5 4.5M7.8 8.4a3.5 3.5 0 0 1 2.7-1.4" /></>
    case 'settings':
      return <><path d="m10 3.5-.6 2.4-2 .9L5.1 6 3.5 9l1.8 1.6v2.8L3.5 15l1.6 3 2.3-.8 2 .9.6 2.4h4l.6-2.4 2-.9 2.3.8 1.6-3-1.8-1.6v-2.8L20.5 9l-1.6-3-2.3.8-2-.9-.6-2.4Z" fill="currentColor" fillOpacity=".07" /><circle cx="12" cy="12" r="3" /></>
    case 'plus':
      return <path d="M12 5v14M5 12h14" />
    case 'monitor':
      return <><rect x="3.5" y="4" width="17" height="12" rx="2" fill="currentColor" fillOpacity=".07"/><path d="M12 16v4m-4 0h8"/></>
    case 'keyboard':
      return <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M7 10h.01M11 10h.01M15 10h.01M18 10h.01M7 13h.01M11 13h.01M15 13h.01M8 16h8" /></>
    case 'undo':
      return <><path d="M8 5 4 9l4 4M4 9h10a5 5 0 0 1 0 10h-3" /></>
    case 'redo':
      return <><path d="m16 5 4 4-4 4M20 9H10a5 5 0 0 0 0 10h3" /></>
    case 'brush':
      return <><path d="m11 4 8 8-4 4-8-8Z" fill="currentColor" fillOpacity=".1" /><path d="m9 6 8 8M8 12l-3 3c-1 1-.2 3-2 4 3 .5 5-.5 6-2l1-3" /></>
    case 'format':
      return <><path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 4v4M16 10v4M10 16v4" /></>
    case 'folder':
      return <><path d="M3.5 8V6.8A1.8 1.8 0 0 1 5.3 5h4.2l2 2H18a2 2 0 0 1 2 2" /><path d="M3.5 9h17l-1.3 8.3A2 2 0 0 1 17.2 19H5.5a2 2 0 0 1-2-2Z" fill="currentColor" fillOpacity=".1" /><path d="M6.5 12h5" /></>
    case 'note':
      return <PageGlyph><path d="M9 11h6M9 14h6M9 17h3.5" /></PageGlyph>
    case 'inbox':
      return <><path d="m5 8-2 7v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3l-2-7" fill="currentColor" fillOpacity=".09" /><path d="M3 15h5l1.5 2h5l1.5-2h5M12 3.5v8M9 8.5l3 3 3-3" /></>
    case 'trash':
      return <><path d="m6 7 .9 11.2a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 7" fill="currentColor" fillOpacity=".08" /><path d="M4.5 7h15M9 7V4h6v3M10 11v5M14 11v5" /></>
    case 'more':
      return <><circle cx="6" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r=".75" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r=".75" fill="currentColor" stroke="none" /></>
    case 'source':
      return <><path d="m9 6-5 6 5 6M15 6l5 6-5 6" /><path d="m13.5 4-3 16" /></>
    case 'split':
      return <><rect x="4" y="5" width="16" height="14" rx="1.5" /><path d="M12 5v14M7 9h2M15 9h2M7 12h2M15 12h2M7 15h2" /></>
    case 'preview':
      return <><path d="M3.5 12s3-5 8.5-5 8.5 5 8.5 5-3 5-8.5 5-8.5-5-8.5-5Z" /><circle cx="12" cy="12" r="2.25" /></>
    case 'collapse':
      return <><path d="M4 5v14M16 7l-4 5 4 5" /></>
    case 'expand':
      return <><path d="M20 5v14M8 7l4 5-4 5" /></>
    case 'chevron-down':
      return <path d="m6 9 6 6 6-6" />
    case 'chevron-right':
      return <path d="m9 6 6 6-6 6" />
    case 'minimize':
      return <path d="M6 12h12" />
    case 'maximize':
      return <rect x="5.5" y="5.5" width="13" height="13" rx="1.25" />
    case 'restore':
      return <><rect x="8.5" y="5.5" width="10" height="10" rx="1.25" /><path d="M5.5 8.5v10h10" /></>
    case 'close':
      return <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    case 'star':
      return <path d="m12 3.75 2.55 5.16 5.7.83-4.13 4.03.98 5.69L12 16.77l-5.1 2.69.98-5.69-4.13-4.03 5.7-.83Z" />
    case 'ai-fusion':
      return <><rect x="3.5" y="8" width="15" height="11.5" rx="3.5" fill="currentColor" fillOpacity=".07" /><path d="M11 8V5M3.5 13.75H2M18.5 13.75H20M8.5 16.25q2.5 1.75 5 0" /><circle cx="11" cy="3.5" r="1" fill="currentColor" stroke="none" /><circle cx="8.25" cy="12.5" r=".85" fill="currentColor" stroke="none" /><circle cx="13.75" cy="12.5" r=".85" fill="currentColor" stroke="none" /><path d="m19 2 1.1 2.65L22.75 5.75 20.1 6.85 19 9.5l-1.1-2.65-2.65-1.1 2.65-1.1Z" fill="currentColor" fillOpacity=".16" strokeWidth="1.5" /></>
    case 'file':
      return <PageGlyph><path d="M9 11.5h6M9 15h4" /></PageGlyph>
    case 'file-pdf':
      return <PageGlyph><path d="M9 16c3-4 3-7 2-7-1 0 0 4 3 6 2 1 3 .5 3-.2 0-1-5-1-8 1-2 1-2 2-1 2 .7 0 1.3-1 2-2Z" strokeWidth="1.35" /></PageGlyph>
    case 'file-word':
      return <PageGlyph><path d="m8.5 11 1 6 2.5-4 2.5 4 1-6" /></PageGlyph>
    case 'file-excel':
      return <PageGlyph><rect x="8.5" y="11" width="7" height="6" rx=".5" /><path d="M12 11v6M8.5 14h7" /></PageGlyph>
    case 'file-powerpoint':
      return <PageGlyph><path d="M9 11h6v4H9ZM12 15v3M10 18h4" /></PageGlyph>
    case 'file-image':
      return <PageGlyph><path d="m8.5 17 3-4 2 2 2-2M9 10.5h.01" /></PageGlyph>
    case 'file-text':
      return <PageGlyph><path d="M9 11h6M12 11v6M10.5 17h3" /></PageGlyph>
    case 'file-markdown':
      return <PageGlyph><path d="M8.5 17v-6l3 3 3-3v6" /></PageGlyph>
    case 'file-document':
      return <PageGlyph><path d="M9 11h6M9 14h6M9 17h3" /></PageGlyph>
  }
}

/** Shared, original interface glyphs. Labelled controls should use the default decorative mode. */
export function Icon({ name, size = 20, decorative = true }: IconProps) {
  return (
    <svg
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : ICON_LABELS[name]}
      data-testid={`icon-${name}`}
      className="cay-icon"
      focusable="false"
      fill="none"
      height={size}
      role={decorative ? undefined : 'img'}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width={size}
    >
      {glyphFor(name)}
    </svg>
  )
}
