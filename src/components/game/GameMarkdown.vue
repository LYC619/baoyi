<script setup lang="ts">
import { tr } from '../../i18n/index.ts'

import { computed, ref } from 'vue'
import { marked, Renderer } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{
  text: string
  editableTasks?: boolean
  images?: Record<string, string>
}>()
const emit = defineEmits<{ toggle: [index: number] }>()

const root = ref<HTMLElement>()

const html = computed(() => {
  const renderer = new Renderer()
  renderer.html = () => ''
  renderer.image = ({ href, text }) => {
    const key = (href || '').trim()
    if (key && props.images && Object.prototype.hasOwnProperty.call(props.images, key)) {
      const encoded = encodeURIComponent(key)
      const alt = encodeURIComponent(text || '')
      return `<span data-local-img="${encoded}" data-local-alt="${alt}"></span>`
    }
    return text ? `<span>${text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))}</span>` : ''
  }

  const clean = DOMPurify.sanitize(marked.parse(props.text, { async: false, gfm: true, renderer }) as string, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'object', 'embed', 'form', 'style', 'svg', 'math'],
    FORBID_ATTR: ['href', 'src', 'style', 'id', 'name'],
  })
  const parsed = new DOMParser().parseFromString(clean, 'text/html')
  parsed.querySelectorAll('h2,h3').forEach((el, i) => el.setAttribute('data-heading', String(i)))
  parsed.querySelectorAll('input').forEach((el, i) => {
    if (el.type !== 'checkbox') {
      el.remove()
      return
    }
    el.disabled = !props.editableTasks
    el.setAttribute('data-task', String(i))
    el.setAttribute('aria-label', tr("切换待办 {p0}", {p0: (i + 1)}))
  })
  parsed.querySelectorAll('span[data-local-img]').forEach((el) => {
    let key = ''
    let alt = ''
    try {
      key = decodeURIComponent(el.getAttribute('data-local-img') || '')
      alt = decodeURIComponent(el.getAttribute('data-local-alt') || '')
    } catch {
      el.remove()
      return
    }
    const dataUrl = key && props.images ? props.images[key] : ''
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      el.remove()
      return
    }
    const img = parsed.createElement('img')
    img.setAttribute('src', dataUrl)
    img.setAttribute('alt', alt)
    img.setAttribute('loading', 'lazy')
    el.replaceWith(img)
  })
  return parsed.body.innerHTML
})

const headings = computed(() => {
  const doc = new DOMParser().parseFromString(html.value, 'text/html')
  return [...doc.querySelectorAll('h2,h3')].map((el, index) => ({
    index,
    text: el.textContent || '',
    level: el.tagName === 'H3' ? 3 : 2,
  }))
})

function jump(index: number) {
  const el = root.value?.querySelector<HTMLElement>(`[data-heading="${index}"]`)
  el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  el?.animate([{ background: 'var(--active-surface)' }, { background: 'transparent' }], { duration: 1300 })
}

function change(e: Event) {
  const input = e.target as HTMLInputElement
  if (props.editableTasks && input.matches('input[data-task]')) emit('toggle', Number(input.dataset.task))
}

defineExpose({ headings, jump })
</script>

<template>
  <div ref="root" class="game-markdown" @change="change" v-html="html" />
</template>

<style scoped>
.game-markdown {
  font-size: 13px;
  line-height: 1.85;
  overflow-wrap: anywhere;
  user-select: text;
}
.game-markdown :deep(h1) {
  font-size: 23px;
  margin: 0 0 18px;
}
.game-markdown :deep(h2) {
  font-size: 18px;
  margin: 24px 0 12px;
  scroll-margin-top: 12px;
}
.game-markdown :deep(h3) {
  font-size: 15px;
  margin: 18px 0 9px;
}
.game-markdown :deep(p) {
  margin: 10px 0;
}
.game-markdown :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 12px 0;
  border-radius: 6px;
  border: 1px solid var(--divider);
}
.game-markdown :deep(ul),
.game-markdown :deep(ol) {
  padding-left: 24px;
}
.game-markdown :deep(input[type='checkbox']) {
  accent-color: var(--accent);
  margin-right: 6px;
}
.game-markdown :deep(table) {
  border-collapse: collapse;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}
.game-markdown :deep(td),
.game-markdown :deep(th) {
  border: 1px solid var(--divider-strong);
  padding: 7px 12px;
  text-align: left;
}
.game-markdown :deep(pre) {
  background: var(--bg-main);
  padding: 14px;
  overflow: auto;
  border-radius: 6px;
}
.game-markdown :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
}
.game-markdown :deep(blockquote) {
  border-left: 2px solid var(--accent);
  padding: 4px 14px;
  margin: 15px 0;
  color: var(--text-sub);
}
</style>
