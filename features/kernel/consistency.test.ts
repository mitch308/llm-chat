import { describe, expect, it } from "vitest";
import { BILL_ACTIONS, BILL_COMPONENTS } from "../bills/shared";
import { NEWS_COMPONENTS } from "../news/shared";
import { SHARED_COMPONENTS } from "../shared/shared";
import { assembleServerFeatures, scanServerFeatures } from "./server";

/** 与 server/src/features.ts 同源的装配：扫描 features/ 实目录组装（目录名排序 = 注册顺序）。 */
const ASM = assembleServerFeatures(
  await scanServerFeatures(new URL("../", import.meta.url)),
);

describe("ASM catalog 一致性（server 侧）", () => {
  it("组件键集合 == BILL ∪ NEWS ∪ SHARED 三份清单的并集", () => {
    expect([...ASM.catalog.componentNames].sort()).toEqual(
      [...BILL_COMPONENTS, ...NEWS_COMPONENTS, ...SHARED_COMPONENTS].sort(),
    );
  });

  it("动作键集合 == BILL_ACTIONS + 内置 cancel_op", () => {
    expect([...ASM.catalog.actionNames].sort()).toEqual(
      [...BILL_ACTIONS, "cancel_op"].sort(),
    );
  });

  it("技能按目录名排序注册：记账技能在新闻技能前（bills < news < shared）", () => {
    expect(ASM.skills.map((s) => s.label)).toEqual(["记账技能", "新闻技能"]);
  });
});
