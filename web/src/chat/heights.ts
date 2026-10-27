import type { ChatMsg } from "./types";

const BASE = 56;
const LINE_HEIGHT = 22;
const CHARS_PER_LINE = 28;
const SPEC_BLOCK = 260;

/** 虚拟滚动高度估算：短文本紧凑、长文本按行增长、带卡片/图表的消息预留空间。 */
export function estimateItemHeight(msg: ChatMsg): number {
  const lines = Math.max(1, Math.ceil(msg.text.length / CHARS_PER_LINE));
  let h = BASE + lines * LINE_HEIGHT;
  if (msg.specLines.length > 0) h += SPEC_BLOCK;
  return Math.min(h, 2000);
}
