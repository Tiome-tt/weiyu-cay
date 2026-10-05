/** Suppress WebView browser UI while allowing the app's own editor/menu handlers. */
export function installBrowserDefaultGuards(target: Document): () => void {
  const contextMenu = (event: MouseEvent) => event.preventDefault()
  const keyDown = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase()
    if (key === 'f5' || key === 'f3' || ((event.ctrlKey || event.metaKey) && ['f', 'g', 'r', 'p', 's', 'u'].includes(key))) {
      event.preventDefault()
    }
  }
  target.addEventListener('contextmenu', contextMenu)
  target.addEventListener('keydown', keyDown, true)
  return () => {
    target.removeEventListener('contextmenu', contextMenu)
    target.removeEventListener('keydown', keyDown, true)
  }
}
