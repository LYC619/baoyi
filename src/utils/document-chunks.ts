import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { rangeFromOffsets } from './document-anchor'

const FORBID_TAGS = ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'input']
const FORBID_ATTR = ['href', 'src', 'style']

export interface DocumentProseChunk {
  html: string
  text: string
  heading: string
}

export function sanitizeMarkdownBlock(markdownText: string): string {
  if (typeof DOMPurify?.sanitize !== 'function' || typeof marked?.parse !== 'function') return ''
  return DOMPurify.sanitize(marked.parse(markdownText) as string, {
    FORBID_TAGS,
    FORBID_ATTR,
  })
}

export function buildDocumentChunks(format: string, text: string): DocumentProseChunk[] {
  if (!text) return []
  if (format === 'txt') {
    return text
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((para) => ({
        html: DOMPurify.sanitize(
          '<p>' +
            para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>') +
            '</p>'
        ),
        text: para,
        heading: '',
      }))
  }
  return marked
    .lexer(text)
    .filter((t) => t.type !== 'space')
    .map((t) => ({
      html: DOMPurify.sanitize(marked.parser([t]), {
        FORBID_TAGS,
        FORBID_ATTR,
      }),
      text: t.raw,
      heading: t.type === 'heading' ? t.text : '',
    }))
}

export function boxesFromRange(range: Range): DOMRect[] {
  const seen = new Set<string>()
  return [...range.getClientRects()].filter((r) => {
    const key = [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 10)).join(':')
    if (r.width < 1 || r.height < 1 || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function highlightQueryInElement(
  root: HTMLElement | null | undefined,
  viewport: HTMLElement | null | undefined,
  query: string,
  occurrence = 0,
  scrollToMatch = true
): void {
  if (!root) return
  const text = root.textContent || ''
  const lower = text.toLowerCase()
  const term = query.toLowerCase()
  let start = lower.indexOf(term)
  for (let i = 0; i < occurrence && start >= 0; i++) {
    start = lower.indexOf(term, start + term.length)
  }
  if (start < 0) return
  const range = rangeFromOffsets(root, start, start + term.length)
  if (!range) return
  if (viewport && scrollToMatch) {
    viewport.scrollTop += range.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 100
  }
  const api = (CSS as any).highlights
  const HighlightClass = (window as any).Highlight
  if (api && HighlightClass) {
    api.set('document-search', new HighlightClass(range))
  }
}
