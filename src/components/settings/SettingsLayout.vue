<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft } from 'lucide-vue-next'
import BaoyiLogo from '@/components/ui/BaoyiLogo.vue'
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
const router = useRouter()

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

function switchTab(id: TabId): void {
  tab.value = id
  router.replace({ query: { tab: id } })
}

const slots = defineSlots<{
  [key: string]: any
}>()




