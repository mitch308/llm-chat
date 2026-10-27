<script setup lang="ts">
defineProps<{
  item: string;
  categoryName: string;
  amount_yuan: number;
  type: "expense" | "income";
  date: string;
}>();
</script>

<template>
  <div class="bill-item">
    <span class="date">{{ date }}</span>
    <span>{{ item }}</span>
    <span class="cat">{{ categoryName }}</span>
    <span class="amount" :class="type">¥{{ amount_yuan }}</span>
  </div>
</template>

<style scoped>
.bill-item {
  display: flex;
  gap: 8px;
  font-size: 13px;
  padding: 4px 0;
}
.date {
  color: #9ca3af;
}
.cat {
  color: #6b7280;
}
.amount.expense {
  color: #dc2626;
  margin-left: auto;
}
.amount.income {
  color: #059669;
  margin-left: auto;
}
</style>
