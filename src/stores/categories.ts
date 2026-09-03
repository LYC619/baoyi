import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  Bot,
  Box,
  Bug,
  Clapperboard,
  Code2,
  FileText,
  Folder,
  Globe,
  Image,
  Inbox,
  Search,
  Settings2,
  Shield,
  SlidersHorizontal,
  StickyNote,
  Wrench,
  Zap
} from 'lucide-vue-next'
import type { Component } from 'vue'
import { plain } from '@/utils'
import type { Category } from '@/types'

/**
 * 分类图标名 → 组件。用户在设置里填的是 Lucide 名字，能对上的才画出来。
 * 退休分类的图标名留着 —— 用户自建的分类可能还在用它们。
 */
const ICONS: Record<string, Component> = {
  bug: Bug,
  bot: Bot,
  search: Search,
  'file-text': FileText,
  'sliders-horizontal': SlidersHorizontal,
  globe: Globe,
  image: Image,
  clapperboard: Clapperboard,
  shield: Shield,
  'sticky-note': StickyNote,
  box: Box,
  'code-2': Code2,
  'settings-2': Settings2,
  folder: Folder,
  wrench: Wrench,
  inbox: Inbox,
  zap: Zap
}

/** 设置页那句「内置了哪些图标名」的提示直接读它，免得两边说不一样 */
export const ICON_NAMES = Object.keys(ICONS)

export const useCategoriesStore = defineStore('categories', () => {
  const list = ref<Category[]>([])

  async function load(kind?: string): Promise<void> {
    list.value = await window.baoyi.categories.list(kind)
  }

  async function upsert(category: Category, kind?: string): Promise<void> {
    list.value = await window.baoyi.categories.upsert(plain(category), kind)
  }

  async function remove(id: string): Promise<void> {
    list.value = await window.baoyi.categories.remove(id)
  }

  /** 按分类名取图标名，找不到就用通用图标 */
  function iconOf(name: string): string {
    return list.value.find((c) => c.name === name)?.icon || 'box'
  }

  /** 按分类名直接取图标组件。侧边栏和主页的分组标题都走它 */
  function iconComponent(name: string): Component {
    return ICONS[iconOf(name)] ?? Box
  }

  return { list, load, upsert, remove, iconOf, iconComponent }
})
