<script setup lang="ts">
defineProps<{
  title?: string | null;
  bills: {
    id: number;
    item: string;
    categoryName: string;
    parentName?: string | null;
    amount_yuan: number;
    type: "expense" | "income";
    date: string;
  }[];
  total_yuan?: number | null;
}>();
</script>

<template>
  <div class="bill-list">
    <div v-if="title" class="list-title">{{ title }}</div>
    <div v-for="b in bills" :key="b.id" class="row">
      <span class="date">{{ b.date }}</span>
      <span class="item">{{ b.item }}</span>
      <span class="cat">{{ b.parentName ? b.parentName + "/" : "" }}{{ b.categoryName }}</span>
      <span class="amount" :class="b.type">¥{{ b.amount_yuan }}</span>
    </div>
    <div v-if="total_yuan != null" class="total">合计 ¥{{ total_yuan }}</div>
  </div>
</template>

<style scoped>
.bill-list {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  max-width: 420px;
  background: #fff;
}
.list-title {
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 600;
  background: #f9fafb;
}
.row {
  display: grid;
  grid-template-columns: 84px 1fr auto auto;
  gap: 8px;
  padding: 6px 12px;
  font-size: 13px;
  border-top: 1px solid #f3f4f6;
  align-items: center;
}
.date {
  color: #9ca3af;
}
.cat {
  color: #6b7280;
  font-size: 12px;
}
.amount.expense {
  color: #dc2626;
}
.amount.income {
  color: #059669;
}
.total {
  padding: 8px 12px;
  font-weight: 600;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}
</style>
