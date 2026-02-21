import { describe, it, expect } from "vitest";
import { evaluateComparison, evaluateFilter, applySelectVisibility } from "../src/executor/mutation.js";
import type { Session } from "../src/permissions/types.js";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

const dummySession: Session = { role: "user", userId: "1", vars: { "X-User-Id": "1" } };

// ─── evaluateComparison: multi-operator conjunctive semantics ───

describe("evaluateComparison", () => {
  it("enforces all operators conjunctively (_gt AND _lt)", () => {
    // { _gt: 1, _lt: 5 } — value 3 satisfies both
    expect(evaluateComparison(3, { _gt: 1, _lt: 5 }, dummySession)).toBe(true);
    // value 6 satisfies _gt but NOT _lt
    expect(evaluateComparison(6, { _gt: 1, _lt: 5 }, dummySession)).toBe(false);
    // value 0 satisfies _lt but NOT _gt
    expect(evaluateComparison(0, { _gt: 1, _lt: 5 }, dummySession)).toBe(false);
  });

  it("enforces _gte AND _lte together", () => {
    expect(evaluateComparison(5, { _gte: 5, _lte: 10 }, dummySession)).toBe(true);
    expect(evaluateComparison(10, { _gte: 5, _lte: 10 }, dummySession)).toBe(true);
    expect(evaluateComparison(11, { _gte: 5, _lte: 10 }, dummySession)).toBe(false);
    expect(evaluateComparison(4, { _gte: 5, _lte: 10 }, dummySession)).toBe(false);
  });

  it("enforces _ne AND _gt together", () => {
    // _ne: 5, _gt: 3 — value 4 passes both
    expect(evaluateComparison(4, { _ne: 5, _gt: 3 }, dummySession)).toBe(true);
    // value 5 fails _ne
    expect(evaluateComparison(5, { _ne: 5, _gt: 3 }, dummySession)).toBe(false);
    // value 2 fails _gt
    expect(evaluateComparison(2, { _ne: 5, _gt: 3 }, dummySession)).toBe(false);
  });

  it("handles single operators correctly", () => {
    expect(evaluateComparison(5, { _eq: 5 }, dummySession)).toBe(true);
    expect(evaluateComparison(5, { _eq: 6 }, dummySession)).toBe(false);
    expect(evaluateComparison(5, { _gt: 3 }, dummySession)).toBe(true);
    expect(evaluateComparison(5, { _lt: 3 }, dummySession)).toBe(false);
    expect(evaluateComparison(5, { _in: [1, 5, 10] }, dummySession)).toBe(true);
    expect(evaluateComparison(5, { _nin: [1, 5, 10] }, dummySession)).toBe(false);
    expect(evaluateComparison(null, { _is_null: true }, dummySession)).toBe(true);
    expect(evaluateComparison(5, { _is_null: true }, dummySession)).toBe(false);
  });

  it("resolves session variables in multi-operator comparisons", () => {
    const session: Session = { role: "user", userId: "1", vars: { "X-Min": "10", "X-Max": "20" } };
    expect(evaluateComparison(15, { _gte: "X-Min" as any, _lte: "X-Max" as any }, session)).toBe(true);
    expect(evaluateComparison(25, { _gte: "X-Min" as any, _lte: "X-Max" as any }, session)).toBe(false);
  });
});

// ─── evaluateFilter: row-level filter with multi-operator columns ───

describe("evaluateFilter", () => {
  it("applies multi-operator column filter in row context", () => {
    // Filter: age between 18 and 65
    const filter = { age: { _gte: 18, _lte: 65 } };
    expect(evaluateFilter(filter, { age: 30 }, dummySession)).toBe(true);
    expect(evaluateFilter(filter, { age: 10 }, dummySession)).toBe(false);
    expect(evaluateFilter(filter, { age: 70 }, dummySession)).toBe(false);
  });

  it("applies _and with multi-operator columns", () => {
    const filter = {
      _and: [
        { score: { _gt: 0, _lt: 100 } },
        { name: { _eq: "Alice" } },
      ],
    };
    expect(evaluateFilter(filter, { score: 50, name: "Alice" }, dummySession)).toBe(true);
    expect(evaluateFilter(filter, { score: 150, name: "Alice" }, dummySession)).toBe(false);
    expect(evaluateFilter(filter, { score: 50, name: "Bob" }, dummySession)).toBe(false);
  });
});

// ─── applySelectVisibility: no select permission → empty rows ───

describe("applySelectVisibility", () => {
  // Minimal mock columns with a primary key
  const mockColumns = {
    id: { primary: true } as unknown as SQLiteColumn,
    name: {} as unknown as SQLiteColumn,
    secret: {} as unknown as SQLiteColumn,
  };

  it("returns empty array when no select permission exists (no count leak)", () => {
    const rows = [
      { id: 1, name: "Alice", secret: "s3cret" },
      { id: 2, name: "Bob", secret: "p@ss" },
    ];
    const result = applySelectVisibility(rows, null, dummySession, mockColumns);
    expect(result).toEqual([]);
  });

  it("returns empty array when selectPerm is undefined (no count leak)", () => {
    const rows = [{ id: 1, name: "Alice" }];
    const result = applySelectVisibility(rows, undefined, dummySession, mockColumns);
    expect(result).toEqual([]);
  });

  it("filters rows and columns with valid select permission", () => {
    const rows = [
      { id: 1, name: "Alice", secret: "s3cret" },
      { id: 2, name: "Bob", secret: "p@ss" },
    ];
    const selectPerm = {
      columns: ["id", "name"] as string[],
      filter: { id: { _eq: 1 } },
    };
    const result = applySelectVisibility(rows, selectPerm, dummySession, mockColumns);
    // Only row with id=1, only allowed columns
    expect(result).toEqual([{ id: 1, name: "Alice" }]);
  });

  it("allows all columns with wildcard", () => {
    const rows = [{ id: 1, name: "Alice", secret: "s3cret" }];
    const selectPerm = { columns: "*" as const };
    const result = applySelectVisibility(rows, selectPerm, dummySession, mockColumns);
    expect(result).toEqual([{ id: 1, name: "Alice", secret: "s3cret" }]);
  });

  it("applies multi-operator row filter correctly", () => {
    const rows = [
      { id: 1, score: 10 },
      { id: 2, score: 50 },
      { id: 3, score: 90 },
    ];
    const selectPerm = {
      columns: "*" as const,
      filter: { score: { _gt: 20, _lt: 80 } },
    };
    const result = applySelectVisibility(rows, selectPerm, dummySession, mockColumns);
    expect(result).toEqual([{ id: 2, score: 50 }]);
  });
});
