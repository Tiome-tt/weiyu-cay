import { codeLanguages } from './codeLanguages'

interface CodeLanguageControlOptions {
  value: string
  disabled: boolean
  onCommit(value: string, focusEditor: boolean): void
}

let nextId = 0

/** Shared DOM control for CodeMirror widgets and ProseMirror node views. */
export function createCodeLanguageControl(options: CodeLanguageControlOptions) {
  const dom = document.createElement('span')
  dom.className = 'cm-code-language'
  dom.contentEditable = 'false'
  const input = document.createElement('input')
  input.type = 'text'
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-label', '代码块语言')
  input.setAttribute('aria-autocomplete', 'none')
  input.setAttribute('aria-haspopup', 'listbox')
  input.setAttribute('aria-expanded', 'false')
  input.autocomplete = 'off'
  input.spellcheck = false
  input.title = '输入语言后按 Enter 应用；清空即不指定语言'
  const toggle = document.createElement('button')
  toggle.type = 'button'
  toggle.className = 'cm-code-language__toggle'
  toggle.setAttribute('aria-label', '选择代码语言')
  toggle.innerHTML = '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m4 6 4 4 4-4"/></svg>'
  dom.append(input, toggle)
  let savedValue = options.value
  let menu: HTMLDivElement | null = null
  let active = -1
  const id = `code-language-options-${++nextId}`

  const resizeInput = () => {
    input.style.width = `${Math.max(2, Math.min(32, input.value.length + 1))}ch`
    dom.dataset.empty = String(input.value.length === 0)
  }
  const close = () => {
    menu?.remove()
    menu = null
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-controls')
    input.removeAttribute('aria-activedescendant')
    document.removeEventListener('pointerdown', outside)
    document.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('resize', close)
  }
  const outside = (event: PointerEvent) => {
    if (!dom.contains(event.target as Node) && !menu?.contains(event.target as Node)) close()
  }
  const onScroll = (event: Event) => {
    if (!menu?.contains(event.target as Node)) close()
  }
  const commit = (focusEditor: boolean) => {
    const value = input.value.trim()
    close()
    if (value === savedValue) { if (focusEditor) options.onCommit(value, true); return }
    savedValue = value
    options.onCommit(value, focusEditor)
  }
  const select = (value: string) => {
    input.value = value
    resizeInput()
    commit(true)
  }
  const open = () => {
    if (input.disabled || menu) return
    menu = document.createElement('div')
    menu.className = 'code-language-options'
    menu.id = id
    menu.setAttribute('role', 'listbox')
    menu.setAttribute('aria-label', '代码语言')
    // A portal avoids clipping by editor scroll containers and content zoom.
    const theme = getComputedStyle(dom)
    for (const key of ['--color-surface', '--color-text', '--color-muted', '--color-border-soft', '--color-accent-soft', '--color-focus', '--code-font']) {
      menu.style.setProperty(key, theme.getPropertyValue(key))
    }
    codeLanguages.forEach(({ id: value, label }, index) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.id = `${id}-${index}`
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(value === savedValue))
      item.textContent = label
      item.addEventListener('pointerdown', event => event.preventDefault())
      item.addEventListener('click', () => select(value))
      menu!.append(item)
    })
    document.body.append(menu)
    const rect = dom.getBoundingClientRect()
    const height = Math.min(menu.scrollHeight || 320, 320, window.innerHeight - 16)
    menu.style.maxHeight = `${height}px`
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 188))}px`
    menu.style.top = `${rect.bottom + height + 6 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - height - 4)}px`
    active = codeLanguages.findIndex(entry => entry.id === savedValue)
    input.setAttribute('aria-expanded', 'true')
    input.setAttribute('aria-controls', id)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
  }
  input.addEventListener('input', () => { resizeInput(); close() })
  input.addEventListener('change', () => commit(false))
  input.addEventListener('blur', () => commit(false))
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      input.value = savedValue; resizeInput(); close()
    } else if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation()
      if (menu && active >= 0) select(codeLanguages[active].id)
      else commit(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation(); open()
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + codeLanguages.length) % codeLanguages.length
      menu?.querySelectorAll('button').forEach((item, index) => item.dataset.active = String(index === active))
      input.setAttribute('aria-activedescendant', `${id}-${active}`)
      menu?.querySelectorAll('button')[active]?.scrollIntoView?.({ block: 'nearest' })
    } else if (event.key === 'Tab') commit(false)
  })
  toggle.addEventListener('pointerdown', event => event.preventDefault())
  toggle.addEventListener('click', () => { if (menu) close(); else { input.focus(); open() } })
  input.value = options.value
  resizeInput()
  input.disabled = toggle.disabled = options.disabled
  return {
    dom, input,
    setValue(value: string) { if (value !== savedValue) { savedValue = value; input.value = value; resizeInput() } },
    setDisabled(disabled: boolean) { input.disabled = toggle.disabled = disabled; if (disabled) close() },
    destroy: close,
  }
}
