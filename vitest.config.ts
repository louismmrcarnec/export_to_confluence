import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.test.ts", "main.test.ts"],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "__mocks__/obsidian.ts"),
    },
  },
});
