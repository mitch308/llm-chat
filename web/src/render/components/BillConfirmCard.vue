<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getOps } from "../../api/client";
import { handleAction } from "../../actions/handleAction";

type CardStatus = "pending" | "saved" | "executed" | "cancelled" | "expired" | "error";

const props = withDefaults(
  defineProps<{
    op_id: string;
    status?: CardStatus;
    kind?: "bill_create" | "bill_update" | "bill_delete";
    data: {
      type?: "expense" | "income";
      amount_yuan?: number;
      item?: string;
      category?: string;
      date?: string;
      note?: string | null;
    };
    diff?: { before: Record<string, unknown> | null; after: Record<string, unknown> | null } | null;
    quip?: string | null;
    warning?: string | null;
  }>(),
  { status: "pending", kind: "bill_create", diff: null, quip: null, warning: null },
);

const status = ref<CardStatus>(props.status === "executed" ? "saved" : props.status);
const quip = ref<string | null>(props.quip ?? null);
const error = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  // 历史重现：pending 卡片向服务端核对真实状态；executed 恢复 quip（I6）
  if (status.value === "pending") {
    try {
      const { items } = await getOps([props.op_id]);
      const real = items[0] as
        | { status?: string; result_json?: string | null }
        | undefined;
      if (real?.status && real.status !== "pending") {
        status.value = real.status === "executed" ? "saved" : (real.status as CardStatus);
        if (real.status === "executed" && real.result_json) {
          try {
            const parsed = JSON.parse(real.result_json) as { quip?: string | null };
            if (parsed.quip) quip.value = parsed.quip;
          } catch {
            // result_json 解析失败：仅恢复状态
          }
        }
      }
    } catch {
      // 状态查询失败：保持本地态
    }
  }
});

const actionName =
  props.kind === "bill_update" || props.kind === "bill_delete" ? props.kind : "bill_create";

async function confirm() {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const result = await handleAction(actionName, { op_id: props.op_id });
    status.value = result.status === "executed" || result.status === "already" ? "saved" : "error";
    if (result.quip) quip.value = result.quip;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}

async function cancel() {
  if (busy.value) return;
  busy.value = true;
  try {
    await handleAction("cancel_op", { op_id: props.op_id });
    status.value = "cancelled";
  } catch (e) {
    error.value = e instanceof Error ? e.message : "操作失败";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="bill-card" :data-status="status">
    <div class="card-head">
      <span v-if="data.type === 'income'" class="tag income">收入</span>
      <span v-else class="tag expense">支出</span>
      <span class="amount">¥{{ data.amount_yuan }}</span>
    </div>
    <div class="fields">
      <div class="field"><label>事项</label><span>{{ data.item }}</span></div>
      <div class="field"><label>类目</label><span>{{ data.category }}</span></div>
      <div class="field"><label>日期</label><span>{{ data.date }}</span></div>
      <div v-if="data.note" class="field"><label>备注</label><span>{{ data.note }}</span></div>
    </div>
    <div v-if="diff && (diff.before || diff.after)" class="diff">
      <div v-if="diff.before" class="before">变更前：{{ JSON.stringify(diff.before) }}</div>
      <div v-if="diff.after" class="after">变更后：{{ JSON.stringify(diff.after) }}</div>
    </div>
    <div v-if="warning" class="warning">⚠ {{ warning }}</div>

    <div v-if="status === 'pending'" class="actions">
      <button class="confirm" :disabled="busy" @click="confirm">
        {{ busy ? "处理中…" : actionName === "bill_delete" ? "确认删除" : "确认" }}
      </button>
      <button class="cancel" :disabled="busy" @click="cancel">取消</button>
    </div>
    <div v-else-if="status === 'saved'" class="result saved">✓ 已保存</div>
    <div v-else-if="status === 'cancelled'" class="result cancelled">已取消</div>
    <div v-else-if="status === 'expired'" class="result expired">提议已过期</div>

    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="status === 'saved' && quip" class="quip">💬 {{ quip }}</div>
  </div>
</template>

<style scoped>
.bill-card {
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 12px 14px;
  max-width: 340px;
  background: #fff;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.tag {
  font-size: 12px;
  border-radius: 999px;
  padding: 2px 8px;
}
.tag.expense {
  background: #fee2e2;
  color: #b91c1c;
}
.tag.income {
  background: #d1fae5;
  color: #047857;
}
.amount {
  font-size: 20px;
  font-weight: 600;
}
.fields {
  display: grid;
  gap: 4px;
}
.field {
  display: flex;
  gap: 8px;
  font-size: 13px;
}
.field label {
  color: #6b7280;
  min-width: 3em;
}
.diff {
  margin-top: 8px;
  font-size: 12px;
  color: #6b7280;
}
.warning {
  margin-top: 8px;
  font-size: 12px;
  color: #b45309;
  background: #fef3c7;
  border-radius: 6px;
  padding: 4px 8px;
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
button {
  border: none;
  border-radius: 8px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 13px;
}
.confirm {
  background: #3b82f6;
  color: #fff;
}
.cancel {
  background: #f3f4f6;
  color: #374151;
}
button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.result {
  margin-top: 10px;
  font-size: 13px;
  font-weight: 500;
}
.saved {
  color: #059669;
}
.cancelled,
.expired {
  color: #6b7280;
}
.error {
  margin-top: 8px;
  font-size: 12px;
  color: #dc2626;
}
.quip {
  margin-top: 8px;
  font-size: 13px;
  background: #f0f9ff;
  border-radius: 8px;
  padding: 6px 10px;
  color: #0369a1;
}
</style>
