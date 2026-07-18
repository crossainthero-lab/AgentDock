// prism-react-renderer only bundles a base set of Prism grammars (verified
// against its dist bundle: typescript, tsx, jsx, javascript, python, json,
// markup/html, css, sql, markdown, yaml, go, java, c, cpp, rust, graphql —
// notably NOT bash or powershell, both explicitly required). Its own docs
// say to register more by publishing its Prism instance as `window.Prism`
// (see prismRuntime.ts) and then importing the grammar files from the
// `prismjs` package, which self-register onto that global.
import './prismRuntime'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-powershell'

/** Canonical Prism language ids this renderer can actually highlight —
 *  anything outside this set falls back to a plain, unhighlighted block
 *  (CodeBlock.tsx) rather than risking a Prism grammar-not-found error. */
export const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'tsx',
  'jsx',
  'javascript',
  'python',
  'json',
  'markup',
  'css',
  'sql',
  'markdown',
  'yaml',
  'go',
  'java',
  'c',
  'cpp',
  'rust',
  'graphql',
  'bash',
  'powershell'
])

const LANGUAGE_ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  yml: 'yaml',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
  'c++': 'cpp',
  'c#': 'csharp',
  golang: 'go',
  md: 'markdown'
}

export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  jsx: 'JSX',
  javascript: 'JavaScript',
  python: 'Python',
  json: 'JSON',
  markup: 'HTML',
  css: 'CSS',
  sql: 'SQL',
  markdown: 'Markdown',
  yaml: 'YAML',
  go: 'Go',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  rust: 'Rust',
  graphql: 'GraphQL',
  bash: 'Bash',
  powershell: 'PowerShell',
  diff: 'Diff',
  text: 'Plain text'
}

/** Lowercases and resolves a fenced code block's language tag (e.g. the
 *  "tsx" in ```tsx) to a canonical Prism id — never throws, never guesses
 *  a language that wasn't actually specified. */
export function normalizeLanguage(raw: string | undefined): string {
  if (!raw) return 'text'
  const lower = raw.trim().toLowerCase()
  return LANGUAGE_ALIASES[lower] ?? lower
}

export function isHighlightable(language: string): boolean {
  return SUPPORTED_LANGUAGES.has(language)
}

export function languageLabel(language: string): string {
  return LANGUAGE_LABELS[language] ?? (language === 'text' ? 'Plain text' : language)
}
