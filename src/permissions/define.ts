/**
 * Type-safe permission builder.
 * Infers table names and column names from the Drizzle schema object,
 * giving autocomplete and compile-time errors for invalid references.
 */

import type { Table, InferSelectModel } from "drizzle-orm";
import type {
  PermissionRules,
  SessionValue,
  BooleanExpression,
} from "./types.js";

/** Extract column names (as string union) from a Drizzle table. */
type ColumnName<T extends Table> = keyof InferSelectModel<T> & string;

/** Typed boolean expression scoped to columns of a specific table. */
type TypedBooleanExp<T extends Table> = {
  _and?: TypedBooleanExp<T>[];
  _or?: TypedBooleanExp<T>[];
  _not?: TypedBooleanExp<T>;
} & {
  [K in ColumnName<T>]?: {
    _eq?: SessionValue;
    _ne?: SessionValue;
    _gt?: SessionValue;
    _lt?: SessionValue;
    _gte?: SessionValue;
    _lte?: SessionValue;
    _in?: SessionValue[];
    _nin?: SessionValue[];
    _is_null?: boolean;
  };
};

interface TypedSelectPermission<T extends Table> {
  columns: ColumnName<T>[] | "*";
  filter?: TypedBooleanExp<T>;
  limit?: number;
}

interface TypedInsertPermission<T extends Table> {
  columns: ColumnName<T>[] | "*";
  check?: TypedBooleanExp<T>;
  presets?: Partial<Record<ColumnName<T>, SessionValue>>;
}

interface TypedUpdatePermission<T extends Table> {
  columns: ColumnName<T>[] | "*";
  filter?: TypedBooleanExp<T>;
  check?: TypedBooleanExp<T>;
  presets?: Partial<Record<ColumnName<T>, SessionValue>>;
}

interface TypedDeletePermission<T extends Table> {
  filter?: TypedBooleanExp<T>;
}

type TypedTablePermissions<T extends Table> = {
  select?: TypedSelectPermission<T>;
  insert?: TypedInsertPermission<T>;
  update?: TypedUpdatePermission<T>;
  delete?: TypedDeletePermission<T>;
};

/** Per-role permission map scoped to the tables object. */
type TypedRolePermissions<Tables extends Record<string, Table>> = {
  [TableName in keyof Tables & string]?: TypedTablePermissions<Tables[TableName]>;
};

/**
 * Define type-safe permission rules.
 *
 * Table names and column names are inferred from the Drizzle schema.
 * Invalid table or column references are caught at compile time.
 *
 * ```ts
 * const rules = definePermissions(tables, {
 *   admin: {
 *     users: { select: { columns: "*" } },
 *   },
 *   user: {
 *     users: { select: { columns: ["id", "name"] } },
 *     // bogusTable: { ... }  ← compile error
 *   },
 * });
 * ```
 */
export function definePermissions<Tables extends Record<string, Table>>(
  _tables: Tables,
  rules: Record<string, TypedRolePermissions<Tables>>
): PermissionRules {
  return rules as unknown as PermissionRules;
}
