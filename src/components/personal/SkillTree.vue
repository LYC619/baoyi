<script setup lang="ts">
import type { SkillCard } from "@/types/skill-profile";
defineProps<{ cards: SkillCard[]; parentId?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>
<template>
  <ul class="skill-tree">
    <li
      v-for="card in cards.filter((c) => c.parentId === (parentId || ''))"
      :key="card.id"
    >
      <button class="ws-button" @click="emit('select', card.id)">
        {{ card.name }}
      </button>
      <details v-if="cards.some((c) => c.parentId === card.id)">
        <summary>子技能</summary>
        <SkillTree
          :cards="cards"
          :parent-id="card.id"
          @select="emit('select', $event)"
        />
      </details>
    </li>
  </ul>
</template>
<style scoped>
.skill-tree {
  list-style: none;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.skill-tree details {
  margin: 8px 0 0 12px;
  border-left: 1px solid var(--divider);
}
.skill-tree summary {
  font-size: 12px;
  color: var(--text-sub);
  cursor: pointer;
  padding-left: 8px;
}
</style>
