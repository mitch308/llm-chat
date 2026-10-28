<script setup lang="ts">
interface NewsItemData {
  title_zh?: string | null;
  title: string;
  summary_zh?: string | null;
  source: string;
  heat?: number;
  published_at?: string | null;
  url: string;
}

defineProps<{ items: NewsItemData[]; dataTime?: string | null }>();
</script>

<template>
  <div class="news-list">
    <a
      v-for="(n, i) in items"
      :key="i"
      :href="n.url"
      target="_blank"
      rel="noopener"
      class="news-item"
    >
      <div class="title">{{ n.title_zh || n.title }}</div>
      <div v-if="n.summary_zh" class="summary">{{ n.summary_zh }}</div>
      <div class="meta">
        <span class="source">{{ n.source }}</span>
        <span v-if="n.heat" class="heat">🔥{{ n.heat }}</span>
        <span v-if="n.published_at">{{ n.published_at }}</span>
        <span class="origin">{{ n.title }}</span>
      </div>
    </a>
    <div v-if="dataTime" class="data-time">数据时间：{{ dataTime }}</div>
  </div>
</template>

<style scoped>
.news-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 480px;
}
.news-item {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px 12px;
  text-decoration: none;
  color: inherit;
  background: #fff;
}
.news-item:hover {
  border-color: #93c5fd;
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
  flex-wrap: wrap;
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
.origin {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.data-time {
  font-size: 11px;
  color: #9ca3af;
}
</style>
