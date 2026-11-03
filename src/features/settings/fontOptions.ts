import {text as uiText} from '../../shared/i18n'
/** Labels follow font-family names; persisted CSS stacks remain compatible. */
export const BODY_FONT_OPTIONS = [
  { value: 'system-ui, sans-serif', label: uiText("系统字体","System font") },
  { value: 'KaiTi, STKaiti, serif', label: uiText("楷体（默认）","KaiTi (default)") },
  { value: 'SimSun, NSimSun, serif', label: uiText("宋体","SimSun") },
  { value: 'SimHei, sans-serif', label: uiText("黑体","SimHei") },
  { value: 'FangSong, STFangsong, serif', label: uiText("仿宋","FangSong") },
  { value: 'Microsoft YaHei, Microsoft YaHei UI, sans-serif', label: uiText("微软雅黑","Microsoft YaHei") },
  { value: 'Microsoft YaHei UI, sans-serif', label: 'Microsoft YaHei UI' },
  { value: 'DengXian, sans-serif', label: uiText("等线","DengXian") },
  { value: 'STSong, serif', label: uiText("华文宋体","STSong") },
  { value: 'STKaiti, serif', label: uiText("华文楷体","STKaiti") },
  { value: 'STFangsong, serif', label: uiText("华文仿宋","STFangsong") },
  { value: 'PingFang SC, PingFang TC, sans-serif', label: uiText("苹方-简","PingFang SC") },
  { value: 'Hiragino Sans GB, Hiragino Sans, sans-serif', label: uiText("冬青黑体简体中文","Hiragino Sans GB") },
  { value: 'Arial, sans-serif', label: 'Arial' },
  { value: 'Calibri, sans-serif', label: 'Calibri' },
  { value: 'Aptos, sans-serif', label: 'Aptos' },
  { value: 'Cambria, serif', label: 'Cambria' },
  { value: 'Times New Roman, serif', label: 'Times New Roman' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'serif', label: uiText("系统衬线字体","System serif") },
] as const

export const CODE_FONT_OPTIONS = [
  { value: 'ui-monospace, SFMono-Regular, Consolas, monospace', label: uiText("系统等宽字体（默认）","System monospace (default)") },
  { value: 'Cascadia Code', label: 'Cascadia Code' },
  { value: 'Cascadia Mono', label: 'Cascadia Mono' },
  { value: 'Consolas', label: 'Consolas' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'JetBrains Mono, monospace', label: 'JetBrains Mono' },
  { value: 'Fira Code, monospace', label: 'Fira Code' },
  { value: 'SFMono-Regular, Menlo, Monaco, monospace', label: 'SF Mono' },
  { value: 'Menlo', label: 'Menlo' },
  { value: 'Monaco', label: 'Monaco' },
  { value: 'Segoe UI Mono', label: uiText("Segoe UI Mono（旧选项）","Segoe UI Mono (legacy)") },
] as const
