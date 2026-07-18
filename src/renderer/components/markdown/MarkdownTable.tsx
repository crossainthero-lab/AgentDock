import type React from 'react'
import { useRef } from 'react'
import { CopyButton } from './CopyButton'
import './MarkdownTable.css'

/** GFM tables from remark-gfm already produce correct thead/tbody/tr/th/td
 *  structure — this wraps that in a horizontally-scrollable container (wide
 *  tables must scroll, never overflow/break the message column) and adds a
 *  copy action that reads the actual rendered cell text via a ref, since
 *  react-markdown's `children` here are React nodes, not raw table text. */
export function MarkdownTable({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const tableRef = useRef<HTMLTableElement>(null)

  function tableAsTsv(): string {
    const table = tableRef.current
    if (!table) return ''
    return Array.from(table.rows)
      .map((row) => Array.from(row.cells).map((cell) => (cell.textContent ?? '').trim()).join('\t'))
      .join('\n')
  }

  return (
    <div className="ad-md-table-wrap">
      <div className="ad-md-table-toolbar">
        <CopyButton getText={tableAsTsv} label="Copy table" />
      </div>
      <div className="ad-md-table-scroll">
        <table className="ad-md-table" ref={tableRef}>
          {children}
        </table>
      </div>
    </div>
  )
}
