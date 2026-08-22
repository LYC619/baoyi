<script setup lang="ts">
/**
 * 抱一 Logo —— 弧线环抱圆点。
 * 外弧留口在右上，内弧在下方托住中心圆点，取「抱一」之形。
 */
withDefaults(defineProps<{ size?: number; color?: string }>(), {
  size: 28,
  color: 'var(--accent)'
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 64 64"
    fill="none"
    aria-hidden="true"
    class="logo"
  >
    <path
      d="M45 9.5A26 26 0 1 0 51.9 48.7"
      :stroke="color"
      stroke-width="5"
      stroke-linecap="round"
    />
    <path
      d="M16 37.8a17 17 0 0 0 32 0"
      :stroke="color"
      stroke-width="5"
      stroke-linecap="round"
    />
    <circle cx="32" cy="27.5" r="8.5" :fill="color" />
  </svg>
</template>

<style scoped>
.logo {
  display: block;
  flex: none;
}
</style>
