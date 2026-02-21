import { describe, it, expect } from "vitest";
import { executeFindPage } from "../src/executor/query.js";

function mockDb(rows: Record<string, unknown>[]) {
  return {
    select: () => ({
      from: () => {
        const state: { limit?: number; offset?: number } = {};
        return {
          where() {
            return this;
          },
          orderBy() {
            return this;
          },
          limit(n: number) {
            state.limit = n;
            return this;
          },
          offset(n: number) {
            state.offset = n;
            return this;
          },
          then(onFulfilled: (value: Record<string, unknown>[]) => unknown, onRejected?: (reason: unknown) => unknown) {
            const start = state.offset ?? 0;
            const sliced = rows.slice(start);
            const limited = state.limit !== undefined ? sliced.slice(0, state.limit) : sliced;
            return Promise.resolve(limited).then(onFulfilled, onRejected);
          },
        };
      },
    }),
  };
}

describe("executeFindPage", () => {
  it("still reports hasNextPage when permission.limit equals first", async () => {
    const rows = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
    ];
    const result = await executeFindPage(
      mockDb(rows),
      "users",
      {
        userWhere: undefined,
        permission: { columns: "*", limit: 2 },
        session: { role: "user", userId: "1", vars: {} },
        columns: {
          id: { primary: true } as any,
          name: { primary: false } as any,
        },
        first: 2,
        pkColumn: "id",
        registry: { tables: { users: {} as any }, columns: {}, objectTypes: {}, relations: [] },
      }
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.hasNextPage).toBe(true);
    expect(typeof result.nextCursor).toBe("string");
  });
});
