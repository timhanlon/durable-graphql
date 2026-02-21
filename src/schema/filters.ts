import {
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLBoolean,
  GraphQLInt,
  GraphQLEnumType,
  type GraphQLInputFieldConfigMap,
  type GraphQLScalarType,
} from "graphql";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { drizzleTypeToGraphQL } from "./types.js";

const OrderByEnum = new GraphQLEnumType({
  name: "OrderBy",
  values: {
    ASC: { value: "asc" },
    DESC: { value: "desc" },
  },
});

/**
 * Build a comparison input type for a single scalar type.
 * E.g. IntComparisonExp with _eq, _ne, _gt, etc.
 */
const comparisonTypeCache = new Map<string, GraphQLInputObjectType>();

function getComparisonType(scalarType: GraphQLScalarType): GraphQLInputObjectType {
  const name = `${scalarType.name}ComparisonExp`;
  const cached = comparisonTypeCache.get(name);
  if (cached) return cached;

  const type = new GraphQLInputObjectType({
    name,
    fields: {
      _eq: { type: scalarType },
      _ne: { type: scalarType },
      _gt: { type: scalarType },
      _lt: { type: scalarType },
      _gte: { type: scalarType },
      _lte: { type: scalarType },
      _in: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
      _nin: { type: new GraphQLList(new GraphQLNonNull(scalarType)) },
      _is_null: { type: GraphQLBoolean },
    },
  });

  comparisonTypeCache.set(name, type);
  return type;
}

/**
 * Build a WhereInput type for a table.
 * Each column gets its comparison operators, plus _and, _or, _not.
 */
export function buildWhereInput(
  tableName: string,
  columns: Record<string, SQLiteColumn>
): GraphQLInputObjectType {
  const typeName = `${pascalCase(tableName)}WhereInput`;

  const type: GraphQLInputObjectType = new GraphQLInputObjectType({
    name: typeName,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};

      for (const [colName, column] of Object.entries(columns)) {
        const scalarType = drizzleTypeToGraphQL(column);
        fields[colName] = { type: getComparisonType(scalarType) };
      }

      // Logical combinators
      fields._and = { type: new GraphQLList(new GraphQLNonNull(type)) };
      fields._or = { type: new GraphQLList(new GraphQLNonNull(type)) };
      fields._not = { type };

      return fields;
    },
  });

  return type;
}

/**
 * Build an OrderByInput type for a table.
 * Each column can be ASC or DESC.
 */
export function buildOrderByInput(
  tableName: string,
  columns: Record<string, SQLiteColumn>
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${pascalCase(tableName)}OrderByInput`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};

      for (const colName of Object.keys(columns)) {
        fields[colName] = { type: OrderByEnum };
      }

      return fields;
    },
  });
}

function pascalCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
