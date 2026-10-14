import { WidgetType, type EditorView } from '@codemirror/view'
import { undo, redo } from '@codemirror/commands'
import { elementScale } from '../../shared/elementScale'
import { parseTsv, serializeTsv } from './tableClipboard'
import type { NoteId } from '../../domain/model'
import type { ImageReadPort } from '../../domain/ports'
import { readImageAsset } from '../content/imageAssetLoader'
import {
  mergeTableCells,
  splitTableCell,
  tableWithCell,
  tableWithMatrix,
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
    void readImageAsset(assetReader, noteId, this.relativePath).then(
      (loaded) => {
        if (this.disposed || !container.isConnected) return
        try {
          const objectUrl = URL.createObjectURL(new Blob([loaded.bytes], { type: loaded.mediaType }))
          if (this.disposed || !container.isConnected) {
            URL.revokeObjectURL(objectUrl)
            return
          }
          this.objectUrl = objectUrl
          const image = document.createElement('img')
          image.decoding = 'async'
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

  updateDOM(dom: HTMLElement, _view: EditorView, previousWidget: DocumentTableWidget) {
    const previous = dom.dataset.gridShape
    const shape = JSON.stringify([this.table.cells.map(row => row.length), this.table.alignments, this.table.merges ?? [], this.editable])
    if (previous !== shape) return false
    this.cleanupOutsidePointer = previousWidget.cleanupOutsidePointer
    previousWidget.cleanupOutsidePointer = null
    dom.dispatchEvent(new CustomEvent('table-model-update', { detail: { table: this.table, source: this.source } }))
    return true
  }

  toDOM(view: EditorView) {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-live-table'
    wrapper.setAttribute('aria-label', this.editable ? '编辑 Markdown 表格' : 'Markdown 表格')
    let current = this.table
    const eagerCellActions = current.cells.length * Math.max(1, ...current.cells.map(line => line.length)) <= 800
    let sourceLength = this.source.length
    wrapper.dataset.gridShape = JSON.stringify([current.cells.map(row => row.length), current.alignments, current.merges ?? [], this.editable])
    wrapper.addEventListener('table-model-update', event => {
      const detail = (event as CustomEvent<{ table: MarkdownTable; source: string }>).detail
      current = detail.table
      sourceLength = detail.source.length
      for (const input of [...wrapper.querySelectorAll<HTMLTextAreaElement>('textarea'), ...stagingRows.querySelectorAll<HTMLTextAreaElement>('textarea')]) {
        const cell = input.closest<HTMLElement>('[data-row][data-column]')!
        const value = current.cells[Number(cell.dataset.row)]?.[Number(cell.dataset.column)] ?? ''
        if (input.value !== value) input.value = value
        input.title = value
        cell.title = value
      }
    })
    let selection: TableCellRange | null = null
    let dragAnchor: { row: number; column: number } | null = null
    let dragging = false
    let pendingCellChange = false
    let suppressClick = false
    wrapper.addEventListener('table-flush', () => {
      const active = document.activeElement
      if (active instanceof HTMLTextAreaElement && wrapper.contains(active)) { active.dispatchEvent(new Event('input')); active.blur() }
      dragging = false
      if (pendingCellChange) { pendingCellChange = false; commit(current) }
    })
    const from = () => view.posAtDOM(wrapper)
    const to = () => from() + sourceLength
    const commit = (tableModel: MarkdownTable, focusCell?: { row: number; column: number }, range?: TableCellRange) => {
      const position = from()
      const scrollLeft = Math.max(0, viewport.scrollLeft)
      this.tableScrollPositions?.set(position, scrollLeft)
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
        target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
        const nextViewport = tableWrapper?.querySelector<HTMLElement>('.cm-live-table-viewport')
        if (nextViewport !== null && nextViewport !== undefined) {
          const bounds = nextViewport.getBoundingClientRect()
          const cellBounds = target.getBoundingClientRect()
          if (bounds.width > 0) {
            const scale = elementScale(nextViewport)
            if (cellBounds.right > bounds.right) nextViewport.scrollLeft += (cellBounds.right - bounds.right) / scale
            else if (cellBounds.left < bounds.left) nextViewport.scrollLeft -= (bounds.left - cellBounds.left) / scale
          }
          this.tableScrollPositions?.set(position, nextViewport.scrollLeft)
          const rail = tableWrapper?.querySelector<HTMLElement>('.cm-live-table-scrollbar')
          if (rail) rail.scrollLeft = nextViewport.scrollLeft
        }
        if (range !== undefined) tableWrapper?.dispatchEvent(new CustomEvent('table-cell-selection', { detail: range }))
      }
      window.requestAnimationFrame(restoreFocus)
      window.setTimeout(restoreFocus, 0)
    }
    const tableColumns = () => Math.max(1, ...current.cells.map((line) => line.length))
    const toolbarLayer = document.createElement('div')
    toolbarLayer.className = 'cm-live-table-toolbar-layer'
    const viewport = document.createElement('div')
    viewport.className = 'cm-live-table-viewport'
    viewport.style.scrollbarWidth = 'none'
    viewport.style.setProperty('-ms-overflow-style', 'none')
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
      const scale = elementScale(wrapper)
      const gap = 8
      const toolbarWidth = toolbarRect.width / scale || toolbar.offsetWidth
      const toolbarHeight = toolbarRect.height / scale || toolbar.offsetHeight
      const wrapperWidth = wrapperRect.width / scale || wrapper.clientWidth
      const maxLeft = Math.max(gap, wrapperWidth - toolbarWidth - gap)
      const centeredLeft = (cellRect.left - wrapperRect.left) / scale + (cellRect.width / scale - toolbarWidth) / 2
      const left = Math.max(gap, Math.min(maxLeft, centeredLeft))
      let top = (cellRect.top - wrapperRect.top) / scale - toolbarHeight - gap
      if (top < gap) top = (cellRect.bottom - wrapperRect.top) / scale + gap
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
    wrapper.addEventListener('table-cell-selection', (event) => {
      if (event instanceof CustomEvent) setSelection(event.detail as TableCellRange)
    })
    const clearSelectionOutsideTable = (event: Event) => {
      const target = event.target
      if (target instanceof Node && wrapper.contains(target)) return
      setSelection(null)
    }
    const outsideEvents = ['pointerdown', 'mousedown', 'click'] as const
    for (const eventName of outsideEvents) document.addEventListener(eventName, clearSelectionOutsideTable, true)

    const rangeOrCell = () => selectedRange() ?? { startRow: current.cells.length - 1, startColumn: 0, endRow: current.cells.length - 1, endColumn: 0 }
    const selectedMatrix = () => {
      const range = selectedRange()
      if (range === null || range.startRow === range.endRow && range.startColumn === range.endColumn) return null
      const row = Math.min(range.startRow, range.endRow)
      const column = Math.min(range.startColumn, range.endColumn)
      const cells = current.cells.slice(row, Math.max(range.startRow, range.endRow) + 1)
        .map(line => line.slice(column, Math.max(range.startColumn, range.endColumn) + 1))
      return { row, column, cells, range }
    }
    const clearSelected = () => {
      const selected = selectedMatrix()
      if (selected === null) return
      commit(tableWithMatrix(current, selected.row, selected.column, selected.cells.map(line => line.map(() => ''))),
        { row: selected.row, column: selected.column }, selected.range)
    }
    for (const type of ['copy', 'cut'] as const) wrapper.addEventListener(type, event => {
      if (!this.editable || event.clipboardData === null) return
      const selected = selectedMatrix()
      if (selected === null) return
      event.preventDefault()
      event.stopPropagation()
      event.clipboardData.setData('text/plain', serializeTsv(selected.cells))
      if (type === 'cut') clearSelected()
    })
    wrapper.addEventListener('keydown', event => {
      if (this.editable && !event.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) redo(view); else undo(view)
        return
      }
      if (!this.editable || event.isComposing || !['Delete', 'Backspace'].includes(event.key) || selectedMatrix() === null) return
      event.preventDefault()
      event.stopPropagation()
      clearSelected()
    })
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
        let next = current
        for (let row = Math.max(range.startRow, range.endRow); row >= Math.min(range.startRow, range.endRow); row -= 1) next = tableWithDeletedRow(next, row)
        commit(next)
      }, deletionGroup)
      button('column-delete', '删除列', () => {
        const range = rangeOrCell()
        let next = current
        for (let column = Math.max(range.startColumn, range.endColumn); column >= Math.min(range.startColumn, range.endColumn); column -= 1) next = tableWithDeletedColumn(next, column)
        commit(next)
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
        dragAnchor = { row, column }
        dragging = true
        suppressClick = false
        if (target instanceof HTMLTextAreaElement) {
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
        if (row !== dragAnchor.row || column !== dragAnchor.column) suppressClick = true
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
          updateCell()
        })
        input.addEventListener('focus', () => { ensureActions(); resizeMarkdownCellEditor(input); selectCell() })
        input.addEventListener('blur', () => collapseMarkdownCellEditor(input))
        const updateCell = () => {
          const value = input.value.replace(/\r\n?|\n/gu, '<br>')
          if (current.cells[merge?.row ?? row]?.[merge?.column ?? column] === value) return
          const next = tableWithCell(current, merge?.row ?? row, merge?.column ?? column, value)
          // Blur during a pointer gesture must not replace the DOM before drag completes.
          if (dragging) { current = next; pendingCellChange = true; return }
          commit(next)
        }
        input.addEventListener('paste', (event) => {
          const text = event.clipboardData?.getData('text/plain') ?? ''
          if (text.length === 0) return
          const range = selectedRange()
          const multi = range !== null && (range.startRow !== range.endRow || range.startColumn !== range.endColumn)
          if (!multi && !/[\t\r\n]/u.test(text)) return
          event.preventDefault()
          event.stopPropagation()
          const values = parseTsv(text)
          const anchorRow = range === null ? row : Math.min(range.startRow, range.endRow)
          const anchorColumn = range === null ? column : Math.min(range.startColumn, range.endColumn)
          const single = values.length === 1 && values[0].length === 1
          const height = single && multi ? Math.abs(range!.endRow - range!.startRow) + 1 : values.length
          const width = single && multi ? Math.abs(range!.endColumn - range!.startColumn) + 1 : Math.max(...values.map(line => line.length))
          const matrix = single && multi ? Array.from({ length: height }, () => Array.from({ length: width }, () => values[0][0])) : values
          const next = tableWithMatrix(current, anchorRow, anchorColumn, matrix)
          commit(next, { row: anchorRow, column: anchorColumn }, {
            startRow: anchorRow, startColumn: anchorColumn, endRow: anchorRow + height - 1, endColumn: anchorColumn + width - 1,
          })
        })
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
          if (event.isComposing) return
          if (event.key === 'Escape') {
            event.preventDefault()
            input.blur()
            return
          }
          if (event.key !== 'Tab' && event.key !== 'Enter') return
          const direction = event.shiftKey ? -1 : 1
          if (event.key === 'Enter' && direction > 0) renderRows(row + (merge?.rowSpan ?? 1) + 1)
          if (event.key === 'Tab' && direction > 0 && column + (merge?.columnSpan ?? 1) >= tableColumns()) renderRows(row + (merge?.rowSpan ?? 1) + 1)
          const inputs = [...wrapper.querySelectorAll<HTMLTextAreaElement>('textarea')]
          const nextRow = row + (direction > 0 ? rowSpan : -1)
          const verticalTarget = inputs.find(candidate => {
            const cell = candidate.closest<HTMLTableCellElement>('[data-row][data-column]')!
            const startRow = Number(cell.dataset.row), startColumn = Number(cell.dataset.column)
            return nextRow >= startRow && nextRow < startRow + cell.rowSpan && column >= startColumn && column < startColumn + cell.colSpan
          })
          const nextTarget = event.key === 'Tab' ? inputs[inputs.indexOf(input) + direction] : verticalTarget
          if (nextTarget === null || nextTarget === undefined) {
            if (event.key === 'Enter') { event.preventDefault(); input.blur(); return }
            updateCell()
            return
          }
          const nextCell = nextTarget.closest<HTMLElement>('[data-row][data-column]')!
          event.preventDefault()
          event.stopPropagation()
          commit(
            tableWithCell(current, merge?.row ?? row, merge?.column ?? column, input.value.replace(/\r?\n/gu, ' ')),
            { row: Number(nextCell.dataset.row), column: Number(nextCell.dataset.column) },
          )
        })
        cell.append(input)
        const actions = document.createElement('span')
        actions.className = 'cm-live-table-cell-actions'
        const logicalRow = merge?.row ?? row
        const logicalColumn = merge?.column ?? column
        const columnSpan = merge?.columnSpan ?? 1
        const rowSpan = merge?.rowSpan ?? 1
        let actionsReady = false
        const ensureActions = () => {
          if (actionsReady) return
          actionsReady = true
          actions.append(
          cellInsertButton('在左侧添加列', 'column-left', () => commit(tableWithInsertedColumn(current, logicalColumn))),
          cellInsertButton('在右侧添加列', 'column-right', () => commit(tableWithInsertedColumn(current, logicalColumn + columnSpan))),
          cellInsertButton('在下方添加行', 'row-below', () => commit(tableWithInsertedRow(current, logicalRow + rowSpan))),
          )
        }
        if (eagerCellActions) ensureActions()
        cell.addEventListener('pointerenter', ensureActions)
        cell.append(actions)
        actions.dataset.edge = 'none'
        cell.addEventListener('pointermove', (event) => {
          const bounds = cell.getBoundingClientRect()
          const edgeDistance = 14 * elementScale(cell)
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
    let renderedRows = 0
    let renderFrame = 0
    const columns = Math.max(1, ...current.cells.map(line => line.length))
    const stagingRows = document.createDocumentFragment()
    const renderRows = (end: number, destination: Node = grid) => {
      if (destination === grid) grid.append(stagingRows)
      const fragment = document.createDocumentFragment()
      for (; renderedRows < Math.min(end, current.cells.length); renderedRows += 1) {
        const row = renderedRows
        const tableRow = document.createElement('tr')
        for (let column = 0; column < columns; column += 1) {
          const cell = renderCell(row, column)
          if (cell !== undefined) tableRow.append(cell)
        }
        fragment.append(tableRow)
      }
      destination.appendChild(fragment)
    }
    // The durable model is committed synchronously. Materialize large grids in
    // small frames so painting, pointer input and save actions can continue.
    renderRows(current.cells.length * columns > 800 ? 10 : current.cells.length)
    const renderRemaining = () => {
      if (!wrapper.isConnected) return
      renderRows(renderedRows + Math.max(1, Math.floor(200 / columns)), stagingRows)
      if (renderedRows < current.cells.length) renderFrame = window.requestAnimationFrame(renderRemaining)
      else { grid.append(stagingRows); wrapper.removeAttribute('aria-busy'); updateScrollbar() }
    }
    if (renderedRows < current.cells.length) {
      wrapper.setAttribute('aria-busy', 'true')
      renderFrame = window.requestAnimationFrame(renderRemaining)
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
      window.cancelAnimationFrame(renderFrame)
      for (const eventName of outsideEvents) document.removeEventListener(eventName, clearSelectionOutsideTable, true)
      viewport.removeEventListener('scroll', repositionOnScroll)
      scrollRail.removeEventListener('scroll', syncViewportFromRail)
      document.removeEventListener('pointerup', stopDrag, true)
      document.removeEventListener('pointercancel', stopDrag, true)
      resizeObserver?.disconnect()
    }

    wrapper.addEventListener('pointermove', (event) => {
      if (!this.editable || !dragging || dragAnchor === null) return
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return
      const target = document.elementFromPoint?.(event.clientX, event.clientY) ?? event.target
      const hoveredCell = target instanceof Element
        ? target.closest<HTMLElement>('[data-row][data-column]')
        : null
      if (hoveredCell === null || !wrapper.contains(hoveredCell)) return
      const row = Number(hoveredCell.dataset.row)
      const column = Number(hoveredCell.dataset.column)
      if (!Number.isInteger(row) || !Number.isInteger(column)) return
      if (row !== dragAnchor.row || column !== dragAnchor.column) { suppressClick = true; event.preventDefault() }
      setSelection({ startRow: dragAnchor.row, startColumn: dragAnchor.column, endRow: row, endColumn: column })
    })
    const stopDrag = (event: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (pendingCellChange && dragAnchor !== null) {
        pendingCellChange = false
        commit(current, dragAnchor, selection ?? undefined)
      }
      dragAnchor = null
      if (wrapper.hasPointerCapture?.(event.pointerId)) wrapper.releasePointerCapture(event.pointerId)
      globalThis.setTimeout(() => { suppressClick = false }, 0)
    }
    document.addEventListener('pointerup', stopDrag, true)
    document.addEventListener('pointercancel', stopDrag, true)
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
