import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["src/**/*.test.ts", "../features/*/web/**/*.test.ts"],
    environment: "jsdom",
  },
});
