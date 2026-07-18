// Must be imported (and fully evaluated) before any `prismjs/components/*`
// side-effect import — those files are written in the old UMD/global style
// and self-register onto a global `Prism` at import time, per
// prism-react-renderer's own documented pattern. This file's only job is to
// publish that global first; keeping it in its own module (with exactly one
// import) sidesteps ES module import-hoisting, which would otherwise run a
// sibling `import 'prismjs/components/...'` before a same-file assignment
// statement regardless of source order.
import { Prism } from 'prism-react-renderer'

declare global {
  interface Window {
    Prism: typeof Prism
  }
}

window.Prism = Prism

export { Prism }
