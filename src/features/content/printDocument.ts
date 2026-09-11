/** Build an inert snapshot without editing controls or network images. */
export function printableClone(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement
  clone.querySelectorAll('script,iframe,object,embed,link,meta,base,style,button,select,[role="toolbar"],.column-resize-handle,.table-handle').forEach(node => node.remove())
  for (const element of [clone, ...clone.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || ['contenteditable', 'tabindex', 'srcset', 'formaction'].includes(attribute.name)) element.removeAttribute(attribute.name)
    }
    if (element instanceof HTMLImageElement && !element.getAttribute('src')?.startsWith('blob:')) element.removeAttribute('src')
  }
  return clone
}

/** Opens the system print dialog, where the user can choose Save as PDF. */
export async function printDocument(source: HTMLElement, title: string): Promise<void> {
  const frame = document.createElement('iframe')
  frame.title = '打印文档'
  frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10000px;top:0;border:0'
  document.body.append(frame)
  const target = frame.contentDocument
  const view = frame.contentWindow
  if (!target || !view) { frame.remove(); throw new Error('Print window unavailable') }
  const policy = target.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; font-src 'none'"
  target.head.append(policy)
  target.title = title
  const style = target.createElement('style')
  style.textContent = `@page{size:A4;margin:18mm}body{font:11pt/1.65 "Microsoft YaHei",sans-serif;color:#243830}h1,h2,h3{break-after:avoid}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #b9c8bf;padding:6px;vertical-align:top;overflow-wrap:anywhere}th{background:#edf3ee}thead{display:table-header-group}tr,img{break-inside:avoid}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{border-left:3px solid #b9c8bf;margin-left:0;padding-left:12px}a{color:inherit;text-decoration:underline}mark{background:#fff0ad}*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}.tableWrapper{overflow:visible!important}td[data-background-color="green"],th[data-background-color="green"]{background:#dcede5}td[data-background-color="yellow"],th[data-background-color="yellow"]{background:#fff0ad}td[data-background-color="blue"],th[data-background-color="blue"]{background:#dceaf5}`
  target.head.append(style)
  const heading = target.createElement('h1')
  heading.textContent = title
  target.body.append(heading, target.importNode(printableClone(source), true))
  try {
    await Promise.all([...target.images].map(img => img.decode().catch(() => undefined)))
    await target.fonts?.ready
    view.addEventListener('afterprint', () => frame.remove(), {once:true})
    view.focus()
    view.print()
    // Some webviews never emit afterprint; keep the snapshot alive for the dialog.
    window.setTimeout(() => frame.remove(), 300_000)
  } catch (error) { frame.remove(); throw error }
}
