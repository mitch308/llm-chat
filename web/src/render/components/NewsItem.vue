<script setup lang="ts">
defineProps<{
  title_zh?: string | null;
  title: string;
  summary_zh?: string | null;
  source: string;
  heat?: number;
  published_at?: string | null;
  url: string;
}>();
</script>

<template>
  <a :href="url" target="_blank" rel="noopener" class="news-item">
    <div class="title">{{ title_zh || title }}</div>
    <div v-if="summary_zh" class="summary">{{ summary_zh }}</div>
    <div class="meta">
      <span class="source">{{ source }}</span>
      <span v-if="heat">🔥{{ heat }}</span>
      <span v-if="published_at">{{ published_at }}</span>
    </div>
  </a>
</template>

<style scoped>
.news-item {
  display: block;
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px 12px;
  text-decoration: none;
  color: inherit;
  background: #fff;
  max-width: 480px;
}
.title {
  font-size: 14px;
  font-weight: 600;
}
.summary {
  font-size: 12px;
  color: #4b5563;
  margin-top: 4px;
}
.meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: #9ca3af;
  margin-top: 6px;
}
.source {
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 4px;
  padding: 0 6px;
}
</style>
