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
  | 'minimize'
  | 'maximize'
  | 'restore'
  | 'close'
  | 'star'

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
  minimize: '最小化',
  maximize: '最大化',
  restore: '还原',
  close: '关闭',
  star: '星标',
}

function glyphFor(name: IconName): ReactNode {
  switch (name) {
    case 'search':
      return <><circle cx="10.5" cy="10.5" r="5.75" /><path d="m15 15 4.25 4.25" /></>
    case 'settings':
      return <><path d="M19.43 12.98a7.7 7.7 0 0 0 .05-.98 7.7 7.7 0 0 0-.05-.98l2.11-1.65-2-3.46-2.49 1a7.6 7.6 0 0 0-1.69-.98L15 3.5h-4l-.38 2.43a7.6 7.6 0 0 0-1.69.98l-2.49-1-2 3.46 2.11 1.65a7.7 7.7 0 0 0-.05.98 7.7 7.7 0 0 0 .05.98l-2.11 1.65 2 3.46 2.49-1c.52.4 1.09.73 1.69.98L11 20.5h4l.38-2.43a7.6 7.6 0 0 0 1.69-.98l2.49 1 2-3.46-2.13-1.65Z" /><circle cx="13" cy="12" r="3" /></>
    case 'plus':
      return <path d="M12 5v14M5 12h14" />
    case 'folder':
      return <path d="M3.75 7.75A1.75 1.75 0 0 1 5.5 6h4l1.75 2H18.5a1.75 1.75 0 0 1 1.75 1.75v6.75a1.75 1.75 0 0 1-1.75 1.75h-13A1.75 1.75 0 0 1 3.75 16.5Z" />
    case 'note':
      return <><path d="M6 3.75h9.5L19 7.25v13H6z" /><path d="M15.5 3.75v3.5H19M9 11h7M9 14.5h7M9 18h4" /></>
    case 'inbox':
      return <><path d="M4 5.25h16v12.5H4z" /><path d="M4 13h4l1.5 2h5L16 13h4M12 5.25v6M9.75 9 12 11.25 14.25 9" /></>
    case 'trash':
      return <><path d="M5.5 7.25h13l-1 12H6.5zM9 7.25V4.75h6v2.5M4 7.25h16M10 10.5v5M14 10.5v5" /></>
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
    case 'minimize':
      return <path d="M6 17.5h12" />
    case 'maximize':
      return <rect x="5.5" y="5.5" width="13" height="13" rx="1.25" />
    case 'restore':
      return <><rect x="8.5" y="5.5" width="10" height="10" rx="1.25" /><path d="M5.5 8.5v10h10" /></>
    case 'close':
      return <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    case 'star':
      return <path d="m12 3.75 2.55 5.16 5.7.83-4.13 4.03.98 5.69L12 16.77l-5.1 2.69.98-5.69-4.13-4.03 5.7-.83Z" />
  }
}

/** Shared, original interface glyphs. Labelled controls should use the default decorative mode. */
export function Icon({ name, size = 20, decorative = true }: IconProps) {
  return (
    <svg
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : ICON_LABELS[name]}
      data-testid={`icon-${name}`}
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
