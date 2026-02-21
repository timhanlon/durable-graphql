import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/jwt.test.ts",
      "test/mutation-visibility.test.ts",
      "test/schema-types.test.ts",
      "test/query-pagination.test.ts",
      "test/relation-batching.test.ts",
    ],
  },
});
