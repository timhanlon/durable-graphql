import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,

  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  type GraphQLScalarType,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
} from "graphql";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Map a Drizzle SQLite column to a GraphQL scalar type.
 */
export function drizzleTypeToGraphQL(column: SQLiteColumn): GraphQLScalarType {
  const dataType = column.dataType;
  const sqlType = column.getSQLType().toLowerCase();

  // Drizzle beta uses compound dataType strings like "number int53", "object date"
  if (dataType === "bigint") return GraphQLInt;
  if (dataType.startsWith("number")) {
    if (sqlType.includes("real") || sqlType.includes("float") || sqlType.includes("double") || sqlType.includes("decimal") || sqlType.includes("numeric")) {
      return GraphQLFloat;
    }
    return GraphQLInt;
  }
  if (dataType === "boolean") return GraphQLBoolean;
  if (dataType.startsWith("string")) return GraphQLString;

  return GraphQLString;
}

/**
 * Build a GraphQL object type from a Drizzle table's columns.
 * Relation fields are added separately via thunks.
 */
export function buildObjectType(
  tableName: string,
  columns: Record<string, SQLiteColumn>,
  relationFields?: () => GraphQLFieldConfigMap<unknown, unknown>
): GraphQLObjectType {
  const typeName = pascalCase(tableName);

  return new GraphQLObjectType({
    name: typeName,
    fields: () => {
      const fields: GraphQLFieldConfigMap<unknown, unknown> = {};

      for (const [colName, column] of Object.entries(columns)) {
        const gqlType = drizzleTypeToGraphQL(column);
        fields[colName] = {
          type: column.notNull ? new GraphQLNonNull(gqlType) : gqlType,
        };
      }

      // Merge relation fields if provided
      if (relationFields) {
        Object.assign(fields, relationFields());
      }

      return fields;
    },
  });
}

/**
 * Build a GraphQL input type for INSERT operations.
 * PKs with autoIncrement are optional; columns with defaults are optional.
 */
export function buildInsertInput(
  tableName: string,
  columns: Record<string, SQLiteColumn>
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${pascalCase(tableName)}InsertInput`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};

      for (const [colName, column] of Object.entries(columns)) {
        // All insert fields are optional at the GraphQL level.
        // Required-ness depends on the role's permission (presets can satisfy notNull).
        // The DB enforces actual constraints.
        fields[colName] = {
          type: drizzleTypeToGraphQL(column),
        };
      }

      return fields;
    },
  });
}

/**
 * Build a GraphQL input type for UPDATE _set operations.
 * All fields are optional.
 */
export function buildUpdateInput(
  tableName: string,
  columns: Record<string, SQLiteColumn>
): GraphQLInputObjectType {
  return new GraphQLInputObjectType({
    name: `${pascalCase(tableName)}UpdateInput`,
    fields: () => {
      const fields: GraphQLInputFieldConfigMap = {};

      for (const [colName, column] of Object.entries(columns)) {
        fields[colName] = {
          type: drizzleTypeToGraphQL(column),
        };
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
