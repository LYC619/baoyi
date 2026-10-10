<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { useSearch } from '@/composables/useSearch'

const { text, clear } = useSearch()
const input = ref<HTMLInputElement | null>(null)

function onKeydown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    input.value?.focus()
    input.value?.select()
  }
  if (e.key === 'Escape' && document.activeElement === input.value) {
    clear()
    input.value?.blur()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="search">
    <Search class="search__icon" :size="15" />
    <input
      ref="input"
      v-model="text"
      class="search__input"
      type="text"
      aria-label="搜索软件"
      placeholder="搜索名称、说明或标签…"
      spellcheck="false"
    />
    <button v-if="text" class="search__clear" title="清除" @click="clear">
      <X :size="13" />
    </button>
    <kbd v-else class="search__kbd">Ctrl K</kbd>
  </div>
</template>

<style scoped>
.search {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--search-h);
  padding: 0 12px;
  border-radius: var(--radius-input);
  background: var(--bg-card);
  border: 1px solid var(--card-border);
  transition: border-color var(--t-fast) ease;
}
.search:focus-within {
  border-color: var(--accent);
}

.search__icon {
  flex: none;
  color: var(--text-faint);
}

.search__input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  outline: none;
  color: var(--text-main);
}
.search__input::placeholder {
  color: var(--text-faint);
}

.search__clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--text-sub);
  background: var(--hover-surface);
}
.search__clear:hover {
  color: var(--text-main);
}

.search__kbd {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.5px;
  color: var(--text-faint);
  border: 1px solid var(--divider);
  border-radius: 4px;
  padding: 2px 5px;
}
</style>
