import { describe, expect, it } from "vitest";
import { registry } from "./registry";

describe("registry", () => {
  it("maps all 9 catalog component types", () => {
    for (const name of [
      "BillConfirmCard",
      "BillList",
      "BillItem",
      "Metric",
      "StatChart",
      "NewsList",
      "NewsItem",
      "EmptyState",
      "ErrorState",
    ]) {
      expect(registry[name], `missing ${name}`).toBeTruthy();
    }
  });
});
