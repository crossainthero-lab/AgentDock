import type React from 'react'
import { memo } from 'react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { Prism } from './prismRuntime'
import { isHighlightable, languageLabel, normalizeLanguage } from './prismLanguages'
import { CopyButton } from './CopyButton'
import './CodeBlock.css'

// Colors are var() references into tokens.css, so this stays in sync with
// light/dark automatically — refined/muted rather than a rainbow, per the
// design direction (see --color-syntax-* in tokens.css).
const agentDockPrismTheme: PrismTheme = {
  plain: { color: 'var(--color-syntax-variable)', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-syntax-comment)', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: 'var(--color-syntax-punctuation)' } },
    { types: ['tag'], style: { color: 'var(--color-syntax-tag)' } },
    { types: ['attr-name'], style: { color: 'var(--color-syntax-attr)' } },
    { types: ['attr-value', 'string', 'char', 'inserted'], style: { color: 'var(--color-syntax-string)' } },
    { types: ['boolean', 'constant', 'symbol', 'deleted'], style: { color: 'var(--color-syntax-number)' } },
    { types: ['selector', 'builtin'], style: { color: 'var(--color-syntax-type)' } },
    { types: ['operator', 'entity', 'url'], style: { color: 'var(--color-syntax-operator)' } },
    { types: ['atrule', 'keyword', 'important'], style: { color: 'var(--color-syntax-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-syntax-function)' } },
    { types: ['class-name'], style: { color: 'var(--color-syntax-type)' } },
    { types: ['regex', 'variable'], style: { color: 'var(--color-syntax-variable)' } },
    { types: ['number'], style: { color: 'var(--color-syntax-number)' } },
    { types: ['bold', 'important'], style: { fontWeight: '700' } },
    { types: ['italic'], style: { fontStyle: 'italic' } }
  ]
}

interface CodeBlockProps {
  language: string
  code: string
}

type DiffLineKind = 'add' | 'del' | 'hunk' | 'ctx'

function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---')) return 'ctx'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function DiffBlock({ code }: { code: string }): React.JSX.Element {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <div className="ad-codeblock">
      <div className="ad-codeblock__header">
        <span className="ad-codeblock__lang">Diff</span>
        <CopyButton text={code} />
      </div>
      <pre className="ad-codeblock__pre">
        <code>
          {lines.map((line, i) => (
            <div key={i} className={`ad-codeblock__diff-line ad-codeblock__diff-line--${classifyDiffLine(line)}`}>
              {line.length > 0 ? line : ' '}
            </div>
          ))}
        </code>
      </pre>
    </div>
  )
}

/** A fenced code block from a Markdown message. `language` is whatever was
 *  written after the opening ```` ``` ```` (may be empty/unrecognized —
 *  both are handled safely, never guessed). */
export const CodeBlock = memo(function CodeBlock({ language, code }: CodeBlockProps): React.JSX.Element {
  const normalized = normalizeLanguage(language)

  if (normalized === 'diff') return <DiffBlock code={code} />

  if (!isHighlightable(normalized)) {
    // No recognized grammar — still a proper code block (border, copy
    // button, monospace, h-scroll), just without token colors, rather than
    // guessing a language or silently dropping the code.
    return (
      <div className="ad-codeblock">
        <div className="ad-codeblock__header">
          <span className="ad-codeblock__lang">{languageLabel(normalized)}</span>
          <CopyButton text={code} />
        </div>
        <pre className="ad-codeblock__pre">
          <code>{code.replace(/\n$/, '')}</code>
        </pre>
      </div>
    )
  }

  return (
    <Highlight prism={Prism} theme={agentDockPrismTheme} code={code.replace(/\n$/, '')} language={normalized}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <div className="ad-codeblock">
          <div className="ad-codeblock__header">
            <span className="ad-codeblock__lang">{languageLabel(normalized)}</span>
            <CopyButton text={code} />
          </div>
          <pre className={`ad-codeblock__pre ${className}`} style={{ ...style, backgroundColor: 'transparent' }}>
            <code>
              {tokens.map((line, i) => {
                const lineProps = getLineProps({ line })
                return (
                  <div key={i} {...lineProps} className={`ad-codeblock__line ${lineProps.className}`}>
                    {line.map((token, key) => {
                      const tokenProps = getTokenProps({ token })
                      return <span key={key} {...tokenProps} />
                    })}
                  </div>
                )
              })}
            </code>
          </pre>
        </div>
      )}
    </Highlight>
  )
})
