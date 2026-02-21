import { describe, it, expect } from "vitest";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { GraphQLFloat, GraphQLInt, GraphQLString } from "graphql";
import { drizzleTypeToGraphQL } from "../src/schema/types.js";

function mockColumn(dataType: string, sqlType?: string): SQLiteColumn {
  return {
    dataType,
    getSQLType: () => sqlType ?? dataType,
  } as unknown as SQLiteColumn;
}

describe("drizzleTypeToGraphQL", () => {
  it("maps integer columns to GraphQLInt", () => {
    const column = mockColumn("number int53", "integer");
    expect(drizzleTypeToGraphQL(column)).toBe(GraphQLInt);
  });

  it("maps real/float columns to GraphQLFloat", () => {
    const column = mockColumn("number", "real");
    expect(drizzleTypeToGraphQL(column)).toBe(GraphQLFloat);
  });

  it("maps unknown column types to GraphQLString", () => {
    const column = mockColumn("object json");
    expect(drizzleTypeToGraphQL(column)).toBe(GraphQLString);
  });
});
