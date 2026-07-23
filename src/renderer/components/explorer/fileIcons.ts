// Small, dependency-free helpers shared by the file-explorer panel — no
// language-server or MIME-sniffing library, just an extension lookup table,
// matching the "lightweight, already-supported highlighting only" scope.

const EXT_LANGUAGE: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  json: 'json',
  jsonc: 'json',
  html: 'markup',
  htm: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  rs: 'rust',
  graphql: 'graphql',
  gql: 'graphql',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  ps1: 'powershell'
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Maps a filename to a language id `normalizeLanguage`/`isHighlightable`
 *  (prismLanguages.ts) already understand — 'text' (unhighlighted, still a
 *  proper code block) for anything not recognized. */
export function languageForFileName(name: string): string {
  return EXT_LANGUAGE[extensionOf(name)] ?? 'text'
}

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}
