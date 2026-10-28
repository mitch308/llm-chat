import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "../features/*/server/**/*.test.ts",
      "../features/kernel/*.test.ts",
    ],
  },
});
