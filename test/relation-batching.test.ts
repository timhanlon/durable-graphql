import { describe, it, expect } from "vitest";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { generateSchema, type RelationConfig } from "../src/schema/generator.js";
import type { OperationContext } from "../src/schema/operations.js";

function mockDb(rows: Record<string, unknown>[]) {
  return {
    select: () => ({
      from: () => ({
        where() {
          return this;
        },
        orderBy() {
          return this;
        },
        limit() {
          return this;
        },
        offset() {
          return this;
        },
        then(onFulfilled: (value: Record<string, unknown>[]) => unknown, onRejected?: (reason: unknown) => unknown) {
          return Promise.resolve(rows).then(onFulfilled, onRejected);
        },
      }),
    }),
  };
}

describe("relation batching", () => {
  it("resolves one-relation when FK targets a non-primary column", async () => {
    const parents = sqliteTable("parents", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      code: text("code").notNull(),
      name: text("name").notNull(),
    });
    const children = sqliteTable("children", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      parentCode: text("parent_code").notNull(),
    });

    const relations: RelationConfig[] = [
      {
        sourceTable: "children",
        targetTable: "parents",
        type: "one",
        sourceColumn: "parentCode",
        targetColumn: "code",
      },
    ];

    const { registry } = generateSchema({ parents, children }, relations);
    const field = registry.objectTypes.children.getFields().parent;
    expect(field).toBeDefined();
    expect(field.resolve).toBeTypeOf("function");

    const ctx: OperationContext = {
      db: mockDb([{ id: 1, code: "P-01", name: "Parent 01" }]),
      session: { role: "user", userId: "1", vars: {} },
      rules: {
        user: {
          parents: { select: { columns: "*" } },
        },
      },
      registry,
      relationLoaders: { many: new Map(), one: new Map() },
    };

    const result = await (field.resolve as any)({ parentCode: "P-01" }, {}, ctx);
    expect(result).toMatchObject({ code: "P-01", name: "Parent 01" });
  });
});
