import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The HTTP smoke test builds and starts the real app; give it room.
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
