import type React from 'react'
import { useMemo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeSanitize from 'rehype-sanitize'
import { stripAnsi } from './ansi'
import { markdownSanitizeSchema } from './sanitizeSchema'
import { CodeBlock } from './CodeBlock'
import { InlineCode } from './InlineCode'
import { MarkdownLink } from './MarkdownLink'
import { MessageImage } from './MessageImage'
import { MarkdownTable } from './MarkdownTable'
import './MarkdownMessage.css'

const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
const REHYPE_PLUGINS = [[rehypeSanitize, markdownSanitizeSchema]] as const

interface MarkdownMessageProps {
  text: string
  /** Threaded down to MarkdownLink/MessageImage so a local (non-http, no
   *  scheme) path can be resolved/opened/revealed — null when there's no
   *  open workspace to resolve against (those cases render safely inert). */
  workspaceId: string | null
}

/** Renders one Claude assistant message as GitHub-flavored Markdown.
 *
 * Security posture (see sanitizeSchema.ts for the full rationale):
 *  - No rehype-raw — embedded HTML syntax in the source text is never
 *    interpreted as real elements, only ever shown as literal escaped text.
 *  - rehype-sanitize still runs, to strip dangerous protocols
 *    (javascript:, data: on links, etc.) from genuine Markdown-syntax
 *    links/images.
 *  - MarkdownLink/MessageImage add a second, independent layer of protocol
 *    validation of their own before ever acting on an href/src.
 *
 * Renders identically whether `text` is a partial (still-streaming) or
 * final string — there is no separate "raw" vs "formatted" mode to switch
 * between, so there's nothing to visibly jump/duplicate when streaming ends. */
export function MarkdownMessage({ text, workspaceId }: MarkdownMessageProps): React.JSX.Element {
  const cleaned = useMemo(() => stripAnsi(text), [text])

  const components = useMemo<Components>(
    () => ({
      h1: ({ children }) => <h1 className="ad-md-h1">{children}</h1>,
      h2: ({ children }) => <h2 className="ad-md-h2">{children}</h2>,
      h3: ({ children }) => <h3 className="ad-md-h3">{children}</h3>,
      h4: ({ children }) => <h4 className="ad-md-h4">{children}</h4>,
      h5: ({ children }) => <h5 className="ad-md-h5">{children}</h5>,
      h6: ({ children }) => <h6 className="ad-md-h6">{children}</h6>,
      p: ({ children }) => <p className="ad-md-p">{children}</p>,
      ul: ({ children, className }) => <ul className={`ad-md-ul ${className ?? ''}`}>{children}</ul>,
      ol: ({ children, className }) => <ol className={`ad-md-ol ${className ?? ''}`}>{children}</ol>,
      li: ({ children, className }) => <li className={`ad-md-li ${className ?? ''}`}>{children}</li>,
      blockquote: ({ children }) => <blockquote className="ad-md-blockquote">{children}</blockquote>,
      hr: () => <hr className="ad-md-hr" />,
      a: ({ href, children }) => <MarkdownLink href={href} workspaceId={workspaceId}>{children}</MarkdownLink>,
      img: ({ src, alt }) => <MessageImage src={typeof src === 'string' ? src : undefined} alt={alt} workspaceId={workspaceId} />,
      table: ({ children }) => <MarkdownTable>{children}</MarkdownTable>,
      input: ({ type, checked }) =>
        type === 'checkbox' ? <input type="checkbox" checked={!!checked} disabled className="ad-md-checkbox" readOnly /> : null,
      code(props) {
        const { className, children } = props
        const match = /language-(\S+)/.exec(className ?? '')
        if (match) {
          return <CodeBlock language={match[1]} code={String(children).replace(/\n$/, '')} />
        }
        return <InlineCode>{children}</InlineCode>
      },
      // The `code` override above already produces a fully-formed block
      // (CodeBlock has its own <pre>) — unwrap react-markdown's default
      // <pre> wrapper so a fenced block isn't double-nested in one.
      pre: ({ children }) => <>{children}</>
    }),
    [workspaceId]
  )

  return (
    <div className="ad-md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS as never} components={components}>
        {cleaned}
      </ReactMarkdown>
    </div>
  )
}
