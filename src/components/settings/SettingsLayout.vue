<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { Component } from 'vue'

interface Tab {
  id: string
  label: string
  icon: Component
}

const props = defineProps<{
  tabs: Tab[]
  moduleTarget: string
  moduleLabel: string
}>()

const route = useRoute()

type TabId = string

function tabFromRoute(value: unknown): TabId {
  const id = String(Array.isArray(value) ? value[0] : (value ?? ''))
  return props.tabs.some((t) => t.id === id) ? id : props.tabs[0].id
}

const tab = ref<TabId>(tabFromRoute(route.query.tab))
watch(
  () => route.query.tab,
  (v) => (tab.value = tabFromRoute(v))
)




