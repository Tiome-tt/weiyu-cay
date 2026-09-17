import { WidgetType, type EditorView } from '@codemirror/view'
import type { NoteId } from '../../domain/model'
import type { ImageReadPort } from '../../domain/ports'
import {
  mergeTableCells,
  splitTableCell,
  tableWithCell,
  tableWithDeletedColumn,
  tableWithDeletedRow,
  tableWithAlignment,
  tableWithInsertedColumn,
  tableWithInsertedRow,
  type MarkdownTable,
  type TableCellRange,
} from './markdownActions'

export interface DocumentImageWidgetContext {
  noteId?: NoteId
  assetReader?: ImageReadPort
}

export class DocumentImageWidget extends WidgetType {
  private objectUrl: string | null = null
  private disposed = false
  private readonly sourceLength: number

  constructor(
    from: number,
    to: number,
    private readonly alt: string,
    private readonly relativePath: string,
    private readonly context: DocumentImageWidgetContext,
  ) {
    super()
    this.sourceLength = to - from
  }

  eq(other: DocumentImageWidget) {
    return this.sourceLength === other.sourceLength &&
      this.alt === other.alt &&
      this.relativePath === other.relativePath &&
      this.context.noteId === other.context.noteId &&
      this.context.assetReader === other.context.assetReader
  }

  toDOM(view: EditorView) {
    const container = document.createElement('span')
    container.className = 'cm-live-image cm-live-image--loading'
    container.tabIndex = 0
    container.setAttribute('aria-label', this.alt.length > 0 ? `图片：${this.alt}` : '装饰图片')
    container.textContent = this.alt.length > 0 ? this.alt : '正在载入图片'
    container.addEventListener('click', () => this.select(view, container))
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      this.select(view, container)
    })

    const { noteId, assetReader } = this.context
    if (noteId === undefined || assetReader === undefined) {
      this.showFailure(container)
      return container
    }
    void assetReader.readImage({ noteId, relativePath: this.relativePath }).then(
      (loaded) => {
        if (this.disposed || !container.isConnected) return
        try {
          const objectUrl = URL.createObjectURL(new Blob([loaded.bytes.slice().buffer], { type: loaded.mediaType }))
          if (this.disposed || !container.isConnected) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          this.objectUrl = objectUrl
          const image = document.createElement('img')
          image.src = objectUrl
          image.alt = this.alt
          image.addEventListener('error', () => {
            if (this.disposed || !container.isConnected) return
            URL.revokeObjectURL(objectUrl)
            if (this.objectUrl === objectUrl) this.objectUrl = null
            this.showFailure(container)
          })
          container.className = 'cm-live-image cm-live-image--ready'
          container.replaceChildren(image)
        } catch {
          this.showFailure(container)
        }
      },
      () => {
        if (!this.disposed && container.isConnected) this.showFailure(container)
      },
    )
    return container
  }

  destroy() {
    this.disposed = true
    if (this.objectUrl !== null) URL.revokeObjectURL(this.objectUrl)
    this.objectUrl = null
  }

  ignoreEvent() {
    return false
  }

  private select(view: EditorView, container: HTMLElement) {
    const from = view.posAtDOM(container)
    view.dispatch({ selection: { anchor: from, head: from + this.sourceLength } })
    view.focus()
  }

  private showFailure(container: HTMLElement) {
    container.className = 'cm-live-image cm-live-image--missing'
    container.setAttribute('role', 'img')
    container.setAttribute('aria-label', this.alt.length > 0 ? `找不到图片：${this.alt}` : '找不到图片')
    container.textContent = this.alt.length > 0 ? `找不到图片 · ${this.alt}` : '找不到图片'
  }
}

export function externalUrlAtPosition(value: string, position: number): string | null {
  const cursor = Math.max(0, Math.min(value.length, position))
  const pattern = /(?:https?:\/\/|mailto:)[^\s<>"']+/giu
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (cursor >= start && cursor <= end) return match[0]
  }
  return null
}
export class DocumentTableWidget extends WidgetType {
  private cleanupOutsidePointer: (() => void) | null = null

  constructor(
    private readonly position: number,
    _to: number,
    private readonly source: string,
    private readonly table: MarkdownTable,
    private readonly onEdit: (input: { from: number; to: number; table: MarkdownTable; scrollLeft?: number }) => void,
    private readonly editable = true,
    private readonly onOpenExternal?: (href: string) => void | Promise<void>,
    private readonly tableScrollPositions?: Map<number, number>,
  ) {
    super()
  }

  eq(other: DocumentTableWidget) {
    return this.source === other.source && this.onEdit === other.onEdit && this.editable === other.editable && this.onOpenExternal === other.onOpenExternal
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-live-table'
    wrapper.setAttribute('aria-label', this.editable ? '编辑 Markdown 表格' : 'Markdown 表格')
    let current = this.table
    let selection: TableCellRange | null = null
    let dragAnchor: { row: number; column: number } | null = null
    let dragging = false
    let suppressClick = false
    const from = () => view.posAtDOM(wrapper)
    const to = () => from() + this.source.length
    const commit = (tableModel: MarkdownTable, focusCell?: { row: number; column: number }) => {
      const position = from()
      const scrollLeft = Math.max(0, viewport.scrollLeft)
      this.tableScrollPositions?.set(this.position, scrollLeft)
      this.onEdit({ from: position, to: to(), table: tableModel, scrollLeft })
      current = tableModel
      if (focusCell === undefined) return
      const restoreFocus = () => {
        const tableWrapper = [...view.dom.querySelectorAll<HTMLElement>('.cm-live-table')].find((element) => {
          try { return view.posAtDOM(element) === position } catch { return false }
        })
        const target = tableWrapper?.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="' + (focusCell.row + 1) + ' 行 ' + (focusCell.column + 1) + ' 列"]',
        )
        if (target === null || target === undefined) return
        target.focus({ preventScroll: true })
      }
      window.requestAnimationFrame(restoreFocus)
      window.setTimeout(restoreFocus, 0)
    }
    const tableColumns = () => Math.max(1, ...current.cells.map((line) => line.length))
    const toolbarLayer = document.createElement('div')
    toolbarLayer.className = 'cm-live-table-toolbar-layer'
    const viewport = document.createElement('div')
    viewport.className = 'cm-live-table-viewport'
    const scrollRail = document.createElement('div')
    scrollRail.className = 'cm-live-table-scrollbar'
    scrollRail.setAttribute('role', 'scrollbar')
    scrollRail.setAttribute('aria-orientation', 'horizontal')
    scrollRail.setAttribute('aria-label', '表格横向滚动')
    scrollRail.setAttribute('aria-valuemin', '0')
    scrollRail.setAttribute('aria-valuemax', '0')
    scrollRail.setAttribute('aria-valuenow', '0')
    const scrollTrack = document.createElement('div')
    scrollTrack.className = 'cm-live-table-scrollbar__track'
    scrollRail.append(scrollTrack)
    const toolbar = document.createElement('div')
    toolbar.className = 'cm-live-table-toolbar cm-live-table-toolbar--floating'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', '表格工具')
    const summary = document.createElement('span')
    summary.className = 'cm-live-table-toolbar__summary'
    summary.setAttribute('aria-live', 'polite')
    const group = () => {
      const element = document.createElement('div')
      element.className = 'cm-live-table-toolbar__group'
      toolbar.append(element)
      return element
    }
    const controls = new Map<string, HTMLButtonElement>()
    const button = (name: string, label: string, action: () => void, parent: HTMLElement) => {
      const control = document.createElement('button')
      control.type = 'button'
      control.setAttribute('aria-label', label)
      control.title = label
      control.className = `cm-live-table-toolbar__button cm-live-table-toolbar__button--${name}`
      control.append(toolbarGlyph(name))
      control.addEventListener('mousedown', (event) => event.preventDefault())
      control.addEventListener('click', action)
      controls.set(label, control)
      parent.append(control)
    }
    const selectedRange = () => selection
    const selectedMerge = () => {
      const range = selectedRange()
      if (range === null) return undefined
      return current.merges?.find((merge) => range.startRow >= merge.row && range.startRow < merge.row + merge.rowSpan && range.startColumn >= merge.column && range.startColumn < merge.column + merge.columnSpan)
    }
    const positionToolbar = () => {
      const range = selectedRange()
      if (range === null || toolbar.hidden) return
      const activeCell = wrapper.querySelector<HTMLElement>(`[data-row="${range.startRow}"][data-column="${range.startColumn}"]`)
      if (activeCell === null) return
      const wrapperRect = wrapper.getBoundingClientRect()
      const cellRect = activeCell.getBoundingClientRect()
      const toolbarRect = toolbar.getBoundingClientRect()
      const gap = 8
      const toolbarWidth = toolbarRect.width || toolbar.offsetWidth
      const toolbarHeight = toolbarRect.height || toolbar.offsetHeight
      const wrapperWidth = wrapperRect.width || wrapper.clientWidth
      const maxLeft = Math.max(gap, wrapperWidth - toolbarWidth - gap)
      const centeredLeft = cellRect.left - wrapperRect.left + (cellRect.width - toolbarWidth) / 2
      const left = Math.max(gap, Math.min(maxLeft, centeredLeft))
      let top = cellRect.top - wrapperRect.top - toolbarHeight - gap
      if (top < gap) top = cellRect.bottom - wrapperRect.top + gap
      toolbar.style.left = `${Math.round(left)}px`
      toolbar.style.top = `${Math.round(top)}px`
    }
    const updateToolbar = () => {
      const range = selectedRange()
      const hasSelection = range !== null
      const multi = range !== null && (range.startRow !== range.endRow || range.startColumn !== range.endColumn)
      const merged = selectedMerge() !== undefined
      for (const control of controls.values()) control.disabled = !hasSelection
      const mergeControl = controls.get('合并单元格')
      const splitControl = controls.get('拆分单元格')
      if (mergeControl !== undefined) mergeControl.disabled = !multi || merged
      if (splitControl !== undefined) splitControl.disabled = !merged
      toolbar.hidden = !hasSelection
      wrapper.classList.toggle('cm-live-table--active', hasSelection)
      summary.textContent = hasSelection && range !== null
        ? `${Math.abs(range.endRow - range.startRow) + 1} × ${Math.abs(range.endColumn - range.startColumn) + 1}`
        : ''
      if (hasSelection) positionToolbar()
    }
    const setSelection = (next: TableCellRange | null) => {
      selection = next
      updateToolbar()
      const range = next
      for (const cell of wrapper.querySelectorAll<HTMLElement>('[data-row][data-column]')) {
        const row = Number(cell.dataset.row)
        const column = Number(cell.dataset.column)
        const selected = range !== null && row >= Math.min(range.startRow, range.endRow) && row <= Math.max(range.startRow, range.endRow)
          && column >= Math.min(range.startColumn, range.endColumn) && column <= Math.max(range.startColumn, range.endColumn)
        cell.setAttribute('aria-selected', String(selected))
      }
    }
    const clearSelectionOutsideTable = (event: Event) => {
      const target = event.target
      if (target instanceof Node && wrapper.contains(target)) return
      setSelection(null)
    }
    const outsideEvents = ['pointerdown', 'mousedown', 'click'] as const
    for (const eventName of outsideEvents) document.addEventListener(eventName, clearSelectionOutsideTable, true)

    const rangeOrCell = () => selectedRange() ?? { startRow: current.cells.length - 1, startColumn: 0, endRow: current.cells.length - 1, endColumn: 0 }
    const selectedColumns = () => {
      const range = rangeOrCell()
      const fromColumn = Math.min(range.startColumn, range.endColumn)
      const toColumn = Math.min(tableColumns() - 1, Math.max(range.startColumn, range.endColumn))
      return Array.from({ length: Math.max(1, toColumn - fromColumn + 1) }, (_, index) => fromColumn + index)
    }
    const setAlignment = (alignment: 'left' | 'center' | 'right') => {
      let next = current
      for (const column of selectedColumns()) next = tableWithAlignment(next, column, alignment)
      commit(next)
    }
    if (this.editable) {
      const deletionGroup = group()
      button('row-delete', '删除行', () => {
        const range = rangeOrCell()
        commit(tableWithDeletedRow(current, Math.min(range.startRow, range.endRow)))
      }, deletionGroup)
      button('column-delete', '删除列', () => {
        const range = rangeOrCell()
        commit(tableWithDeletedColumn(current, Math.min(range.startColumn, range.endColumn)))
      }, deletionGroup)
      const mergeGroup = group()
      button('merge', '合并单元格', () => {
        if (selection !== null) commit(mergeTableCells(current, selection))
      }, mergeGroup)
      button('split', '拆分单元格', () => {
        const range = selection
        if (range !== null) commit(splitTableCell(current, range.startRow, range.startColumn))
      }, mergeGroup)
      const alignmentGroup = group()
      button('align-left', '左对齐', () => setAlignment('left'), alignmentGroup)
      button('align-center', '居中对齐', () => setAlignment('center'), alignmentGroup)
      button('align-right', '右对齐', () => setAlignment('right'), alignmentGroup)
    }
    const table = document.createElement('table')
    table.setAttribute('aria-label', 'Markdown 表格')
    const grid = document.createElement('tbody')
    const mergeAt = (row: number, column: number) => current.merges?.find((merge) => row >= merge.row && row < merge.row + merge.rowSpan && column >= merge.column && column < merge.column + merge.columnSpan)
    const focusTableCell = (row: number, column: number): boolean => {
      const target = wrapper.querySelector<HTMLTextAreaElement>('textarea[aria-label="' + (row + 1) + ' 行 ' + (column + 1) + ' 列"]')
      if (target === null) return false
      target.focus({ preventScroll: true })
      const viewportRect = viewport.getBoundingClientRect()
      const cell = target.closest<HTMLElement>('[data-row][data-column]')
      const cellRect = cell?.getBoundingClientRect()
      if (cellRect !== undefined && viewportRect.width > 0) {
        if (cellRect.left < viewportRect.left) viewport.scrollLeft -= viewportRect.left - cellRect.left
        else if (cellRect.right > viewportRect.right) viewport.scrollLeft += cellRect.right - viewportRect.right
      }
      return true
    }
    const renderCell = (row: number, column: number) => {
      const merge = mergeAt(row, column)
      if (merge !== undefined && (merge.row !== row || merge.column !== column)) return
      const cell = document.createElement(row === 0 ? 'th' : 'td')
      cell.dataset.row = String(row)
      cell.dataset.column = String(column)
      cell.tabIndex = -1
      applyAlignment(cell, current.alignments[column])
      if (merge !== undefined) {
        if (merge.rowSpan > 1) cell.rowSpan = merge.rowSpan
        if (merge.columnSpan > 1) cell.colSpan = merge.columnSpan
      }
      const selectCell = () => {
        if (!this.editable) return
        setSelection({ startRow: row, startColumn: column, endRow: row, endColumn: column })
      }
      cell.addEventListener('pointerdown', (event) => {
        if (!this.editable || event.button !== 0) return
        event.stopPropagation()
        const target = event.target
        selectCell()
        if (target instanceof HTMLTextAreaElement) {
          dragging = false
          dragAnchor = null
          suppressClick = false
          const activeInput = document.activeElement instanceof HTMLTextAreaElement && wrapper.contains(document.activeElement)
            ? document.activeElement
            : null
          if (activeInput !== null && activeInput !== target) {
            event.preventDefault()
            const activeCell = activeInput.closest<HTMLElement>('[data-row][data-column]')
            const activeRow = activeCell === null ? NaN : Number(activeCell.dataset.row)
            const activeColumn = activeCell === null ? NaN : Number(activeCell.dataset.column)
            if (Number.isInteger(activeRow) && Number.isInteger(activeColumn)) {
              const activeMerge = mergeAt(activeRow, activeColumn)
              const logicalRow = activeMerge?.row ?? activeRow
              const logicalColumn = activeMerge?.column ?? activeColumn
              commit(
                tableWithCell(current, logicalRow, logicalColumn, activeInput.value.replace(/\r?\n/gu, ' ')),
                { row, column },
              )
            }
            return
          }
          target.focus({ preventScroll: true })
          return
        }
        dragAnchor = { row, column }
        dragging = true
        suppressClick = true
        event.preventDefault()
        if (Number.isFinite(event.pointerId)) wrapper.setPointerCapture?.(event.pointerId)
      })
      cell.addEventListener('pointerenter', () => {
        if (!this.editable || !dragging || dragAnchor === null) return
        setSelection({ startRow: dragAnchor.row, startColumn: dragAnchor.column, endRow: row, endColumn: column })
      })
      cell.addEventListener('click', (event) => {
        event.stopPropagation()
        if (suppressClick) return
        selectCell()
      })
      if (this.editable) {
        const input = document.createElement('textarea')
        input.rows = 1
        input.wrap = 'soft'
        collapseMarkdownCellEditor(input)
        input.value = current.cells[merge?.row ?? row]?.[merge?.column ?? column] ?? ''
        input.setAttribute('aria-label', `${row + 1} 行 ${column + 1} 列`)
        input.title = input.value
        cell.title = input.value
        const alignment = current.alignments[column]
        if (alignment !== null && alignment !== undefined) input.style.textAlign = alignment
        input.addEventListener('input', () => {
          input.title = input.value
          cell.title = input.value
          resizeMarkdownCellEditor(input)
        })
        input.addEventListener('focus', () => resizeMarkdownCellEditor(input))
        input.addEventListener('blur', () => collapseMarkdownCellEditor(input))
        const updateCell = () => commit(tableWithCell(current, merge?.row ?? row, merge?.column ?? column, input.value.replace(/\r?\n/gu, ' ')))
        input.addEventListener('click', (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          const href = externalUrlAtPosition(input.value, input.selectionStart ?? 0)
          if (href === null) return
          event.preventDefault()
          event.stopPropagation()
          void this.onOpenExternal?.(href)
        })
        input.addEventListener('change', updateCell)
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            input.blur()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            input.blur()
            return
          }
          if (event.key !== 'Tab') return
          const direction = event.shiftKey ? -1 : 1
          const columns = tableColumns()
          let nextRow = row
          let nextColumn = column + direction
          if (nextColumn >= columns) {
            nextRow += 1
            nextColumn = 0
          } else if (nextColumn < 0) {
            nextRow -= 1
            nextColumn = columns - 1
          }
          if (!focusTableCell(nextRow, nextColumn)) return
          event.preventDefault()
          event.stopPropagation()
        })
        cell.append(input)
        const actions = document.createElement('span')
        actions.className = 'cm-live-table-cell-actions'
        const logicalRow = merge?.row ?? row
        const logicalColumn = merge?.column ?? column
        const columnSpan = merge?.columnSpan ?? 1
        const rowSpan = merge?.rowSpan ?? 1
        actions.append(
          cellInsertButton('在左侧添加列', 'column-left', () => commit(tableWithInsertedColumn(current, logicalColumn))),
          cellInsertButton('在右侧添加列', 'column-right', () => commit(tableWithInsertedColumn(current, logicalColumn + columnSpan))),
          cellInsertButton('在下方添加行', 'row-below', () => commit(tableWithInsertedRow(current, logicalRow + rowSpan))),
        )
        cell.append(actions)
        actions.dataset.edge = 'none'
        cell.addEventListener('pointermove', (event) => {
          const bounds = cell.getBoundingClientRect()
          const edgeDistance = 14
          const edge = event.clientX - bounds.left <= edgeDistance
            ? 'left'
            : bounds.right - event.clientX <= edgeDistance
              ? 'right'
              : bounds.bottom - event.clientY <= edgeDistance
                ? 'bottom'
                : 'none'
          actions.dataset.edge = edge
        })
        cell.addEventListener('pointerleave', () => { actions.dataset.edge = 'none' })
      } else {
        const value = current.cells[merge?.row ?? row]?.[merge?.column ?? column] ?? ''
        cell.textContent = value
        cell.title = value
      }
      return cell
    }
    for (let row = 0; row < current.cells.length; row += 1) {
      const tableRow = document.createElement('tr')
      const columns = Math.max(1, ...current.cells.map((line) => line.length))
      for (let column = 0; column < columns; column += 1) {
        const cell = renderCell(row, column)
        if (cell !== undefined) tableRow.append(cell)
      }
      grid.append(tableRow)
    }
    table.append(grid)
    toolbar.append(summary)
    toolbarLayer.append(toolbar)
    viewport.append(table)
    wrapper.append(toolbarLayer, viewport, scrollRail)
    const initialScrollLeft = Math.max(0, this.tableScrollPositions?.get(this.position) ?? 0)
    viewport.scrollLeft = initialScrollLeft
    scrollRail.scrollLeft = initialScrollLeft

    let syncingScroll = false
    const updateScrollbar = () => {
      const hasLayout = viewport.clientWidth > 0
      const maxScroll = hasLayout ? Math.max(0, viewport.scrollWidth - viewport.clientWidth) : 0
      scrollTrack.style.width = Math.max(viewport.clientWidth, viewport.scrollWidth) + 'px'
      scrollRail.setAttribute('aria-valuemax', String(Math.round(maxScroll)))
      scrollRail.setAttribute('aria-valuenow', String(Math.round(Math.min(viewport.scrollLeft, maxScroll))))
      wrapper.classList.toggle('cm-live-table--scrollable', hasLayout && maxScroll > 1)
    }
    const syncRailFromViewport = () => {
      if (!syncingScroll) {
        syncingScroll = true
        scrollRail.scrollLeft = viewport.scrollLeft
        syncingScroll = false
      }
      updateToolbar()
      updateScrollbar()
    }
    const syncViewportFromRail = () => {
      if (!syncingScroll) {
        syncingScroll = true
        viewport.scrollLeft = scrollRail.scrollLeft
        syncingScroll = false
      }
      updateScrollbar()
      positionToolbar()
    }
    const repositionOnScroll = () => {
      syncRailFromViewport()
    }
    viewport.addEventListener('scroll', repositionOnScroll, { passive: true })
    scrollRail.addEventListener('scroll', syncViewportFromRail, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateScrollbar)
    resizeObserver?.observe(viewport)
    resizeObserver?.observe(table)
    window.requestAnimationFrame(updateScrollbar)
    this.cleanupOutsidePointer = () => {
      for (const eventName of outsideEvents) document.removeEventListener(eventName, clearSelectionOutsideTable, true)
      viewport.removeEventListener('scroll', repositionOnScroll)
      scrollRail.removeEventListener('scroll', syncViewportFromRail)
      resizeObserver?.disconnect()
    }

    wrapper.addEventListener('pointermove', (event) => {
      if (!this.editable || !dragging || dragAnchor === null) return
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
      const target = document.elementFromPoint(event.clientX, event.clientY)
      const hoveredCell = target instanceof Element
        ? target.closest<HTMLElement>('[data-row][data-column]')
        : null
      if (hoveredCell === null || !wrapper.contains(hoveredCell)) return
      const row = Number(hoveredCell.dataset.row)
      const column = Number(hoveredCell.dataset.column)
      if (!Number.isInteger(row) || !Number.isInteger(column)) return
      setSelection({ startRow: dragAnchor.row, startColumn: dragAnchor.column, endRow: row, endColumn: column })
    })
    wrapper.addEventListener('pointerup', (event) => {
      if (!dragging) return
      dragging = false
      dragAnchor = null
      if (Number.isFinite(event.pointerId)) wrapper.releasePointerCapture?.(event.pointerId)
      globalThis.setTimeout(() => { suppressClick = false }, 0)
    })
    wrapper.addEventListener('pointercancel', () => {
      dragging = false
      dragAnchor = null
      suppressClick = false
    })
    updateToolbar()
    return wrapper
  }

  ignoreEvent() {
    return true
  }

  destroy() {
    this.cleanupOutsidePointer?.()
    this.cleanupOutsidePointer = null
  }
}

function toolbarGlyph(name: string) {
  const paths: Record<string, string> = {
    plus: 'M12 5v14M5 12h14',
    'row-add': 'M4 5h16M4 12h16M4 19h16M12 9v6M9 12h6',
    'column-add': 'M5 4v16M12 4v16M19 4v16M9 12h6M12 9v6',
    'row-delete': 'M4 5h16M4 12h16M4 19h16M9 12h6',
    'column-delete': 'M5 4v16M12 4v16M19 4v16M9 12h6',
    merge: 'M4 5h16M4 12h16M4 19h16M8 5v14M16 5v14',
    split: 'M4 5h16M4 12h16M4 19h16M12 5v14',
    'align-left': 'M5 6h14M5 12h9M5 18h14',
    'align-center': 'M5 6h14M8 12h8M5 18h14',
    'align-right': 'M5 6h14M10 12h9M5 18h14',
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', paths[name] ?? paths.merge!)
  svg.append(path)
  return svg
}

function cellInsertButton(label: string, icon: string, action: () => void) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `cm-live-table-cell-action cm-live-table-cell-action--${icon}`
  button.setAttribute('aria-label', label)
  button.title = label
  button.append(toolbarGlyph('plus'))
  button.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    action()
  })
  return button
}

function resizeMarkdownCellEditor(input: HTMLTextAreaElement) {
  const maxHeight = 128
  input.style.height = 'auto'
  const height = Math.max(28, Math.min(maxHeight, input.scrollHeight))
  input.style.height = height + 'px'
  input.style.overflowY = input.scrollHeight > maxHeight ? 'auto' : 'hidden'
}
function collapseMarkdownCellEditor(input: HTMLTextAreaElement) {
  input.style.height = '28px'
  input.style.overflowY = 'hidden'
}

function applyAlignment(cell: HTMLTableCellElement, alignment: MarkdownTable['alignments'][number]) {
  if (alignment !== null && alignment !== undefined) cell.dataset.align = alignment
}
