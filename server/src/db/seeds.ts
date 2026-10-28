import type Database from "better-sqlite3";

/** 两级类目种子（spec 第 6 节）：父 → 叶子；收入单级。 */
export const CATEGORY_SEEDS: {
  name: string;
  kind: "expense" | "income";
  leaves?: string[];
}[] = [
  { name: "餐饮", kind: "expense", leaves: ["三餐", "饮料奶茶", "零食", "聚餐"] },
  { name: "服饰", kind: "expense", leaves: ["衣服", "鞋帽", "饰品"] },
  {
    name: "交通",
    kind: "expense",
    leaves: ["加油", "打车", "停车", "公交地铁", "火车机票"],
  },
  { name: "居住", kind: "expense", leaves: ["房租水电", "物业", "家居"] },
  { name: "娱乐", kind: "expense", leaves: ["电影演出", "游戏", "旅行"] },
  { name: "医疗", kind: "expense", leaves: ["药品", "门诊"] },
  { name: "教育", kind: "expense", leaves: ["书籍", "课程"] },
  { name: "日用品", kind: "expense", leaves: ["清洁洗护", "纸品", "其他日用"] },
  { name: "数码", kind: "expense", leaves: ["设备", "配件", "软件订阅"] },
  { name: "人情往来", kind: "expense", leaves: ["礼物", "随礼红包"] },
  { name: "其他支出", kind: "expense" },
  { name: "工资", kind: "income" },
  { name: "退款", kind: "income" },
  { name: "红包", kind: "income" },
  { name: "其他收入", kind: "income" },
];

/** 幂等写入：已存在的名字跳过。 */
export function seedCategories(db: Database.Database): void {
  const insertIfAbsent = db.prepare(
    `INSERT INTO categories (name, kind, parent_id)
     SELECT $name, $kind, $parentId
     WHERE NOT EXISTS (SELECT 1 FROM categories WHERE name = $name)`,
  );
  const idByName = db.prepare(`SELECT id FROM categories WHERE name = ?`);

  for (const cat of CATEGORY_SEEDS) {
    insertIfAbsent.run({ name: cat.name, kind: cat.kind, parentId: null });
    const parent = idByName.get(cat.name) as { id: number } | undefined;
    if (!parent) continue;
    for (const leaf of cat.leaves ?? []) {
      insertIfAbsent.run({ name: leaf, kind: cat.kind, parentId: parent.id });
    }
  }
}
