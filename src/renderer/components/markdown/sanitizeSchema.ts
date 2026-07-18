// Security note: this renderer deliberately does NOT use rehype-raw. Without
// it, react-markdown never interprets embedded HTML syntax in the source
// text as real elements — a literal `<script>...</script>` or
// `<img onerror=...>` typed in Claude's reply renders as inert, escaped
// text on screen, not as executable markup. That is the primary defense.
//
// rehype-sanitize still matters even so: ordinary Markdown syntax (a real
// `[text](url)` link, a real `![alt](url)` image) produces genuine <a>/<img>
// nodes, and this schema is what strips a dangerous `javascript:`/`vbscript:`
// href or blocks any protocol we don't explicitly allow. It's derived from
// rehype-sanitize's own GitHub-style defaultSchema (which already handles
// GFM output correctly — task-list checkboxes, tables, strikethrough, etc.)
// with one intentional addition: `data:` is allowed for <img src> ONLY,
// since local workspace images are delivered as data URLs by media-service.ts
// (see MessageImage.tsx) — never for <a href>.
import { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'

export const markdownSanitizeSchema: Schema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https', 'data']
  }
}
