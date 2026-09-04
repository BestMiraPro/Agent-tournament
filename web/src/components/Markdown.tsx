import { renderMarkdown } from '../lib/markdown.js'

// The SINGLE sanctioned dangerouslySetInnerHTML in the codebase: safe only
// because renderMarkdown (lib/markdown.ts) escapes HTML first and generates a
// closed subset (no a/img/table tags possible). XSS pins: test/web/markdown.test.ts.
export function Markdown({ text }: { text: string }) {
  return <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}
