import { and, or, not, eq, ne, gt, lt, gte, lte, inArray, notInArray, isNull, isNotNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type {
  Session,
  SessionValue,
  BooleanExpression,
  ComparisonExp,
  PermissionRules,
  SelectPermission,
  InsertPermission,
  UpdatePermission,
  DeletePermission,
  TablePermissions,
} from "./types.js";

/**
 * Resolve a value that may reference a session variable.
 * Session var references start with "X-" (e.g. "X-User-Id").
 */
export function resolveValue(value: SessionValue, session: Session): string | number | boolean {
  if (typeof value === "string" && value.startsWith("X-")) {
    const resolved = session.vars[value];
    if (resolved === undefined) {
      throw new Error(`Session variable ${value} not found`);
    }
    // Try to coerce to number if it looks numeric
    const num = Number(resolved);
    if (!Number.isNaN(num) && resolved !== "") return num;
    return resolved;
  }
  return value;
}

/**
 * Build a Drizzle SQL where clause from a BooleanExpression.
 */
export function buildWhereClause(
  filter: BooleanExpression,
  session: Session,
  tableColumns: Record<string, SQLiteColumn>
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (key === "_and") {
      const andClauses = (value as BooleanExpression[]).map((f) =>
        buildWhereClause(f, session, tableColumns)
      );
      const valid = andClauses.filter((c): c is SQL => c !== undefined);
      if (valid.length > 0) conditions.push(and(...valid));
    } else if (key === "_or") {
      const orClauses = (value as BooleanExpression[]).map((f) =>
        buildWhereClause(f, session, tableColumns)
      );
      const valid = orClauses.filter((c): c is SQL => c !== undefined);
      if (valid.length > 0) conditions.push(or(...valid));
    } else if (key === "_not") {
      const inner = buildWhereClause(value as BooleanExpression, session, tableColumns);
      if (inner) conditions.push(not(inner));
    } else {
      // Column comparison
      const column = tableColumns[key];
      if (!column) continue;
      const comp = value as ComparisonExp;
      conditions.push(...buildColumnConditions(column, comp, session));
    }
  }

  if (conditions.length === 0) return undefined;
  const valid = conditions.filter((c): c is SQL => c !== undefined);
  return valid.length === 1 ? valid[0] : and(...valid);
}

function buildColumnConditions(
  column: SQLiteColumn,
  comp: ComparisonExp,
  session: Session
): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [];

  if (comp._eq !== undefined) conditions.push(eq(column, resolveValue(comp._eq, session)));
  if (comp._ne !== undefined) conditions.push(ne(column, resolveValue(comp._ne, session)));
  if (comp._gt !== undefined) conditions.push(gt(column, resolveValue(comp._gt, session)));
  if (comp._lt !== undefined) conditions.push(lt(column, resolveValue(comp._lt, session)));
  if (comp._gte !== undefined) conditions.push(gte(column, resolveValue(comp._gte, session)));
  if (comp._lte !== undefined) conditions.push(lte(column, resolveValue(comp._lte, session)));
  if (comp._in !== undefined) {
    const values = comp._in.map((v) => resolveValue(v, session));
    conditions.push(inArray(column, values));
  }
  if (comp._nin !== undefined) {
    const values = comp._nin.map((v) => resolveValue(v, session));
    conditions.push(notInArray(column, values));
  }
  if (comp._is_null !== undefined) {
    conditions.push(comp._is_null ? isNull(column) : isNotNull(column));
  }

  return conditions;
}

/**
 * Filter requested columns to only those allowed by the permission.
 */
export function filterColumns(requested: string[], allowed: string[] | "*"): string[] {
  if (allowed === "*") return requested;
  return requested.filter((col) => allowed.includes(col));
}

/**
 * Apply preset values to mutation data, resolving session vars.
 */
export function applyPresets(
  data: Record<string, unknown>,
  presets: Record<string, SessionValue> | undefined,
  session: Session
): Record<string, unknown> {
  if (!presets) return data;
  const result = { ...data };
  for (const [key, value] of Object.entries(presets)) {
    result[key] = resolveValue(value, session);
  }
  return result;
}

/**
 * Look up the permission for a given role, table, and operation.
 * Returns null if no permission exists (deny by default).
 */
export function getPermission<T extends keyof TablePermissions>(
  role: string,
  table: string,
  op: T,
  rules: PermissionRules
): TablePermissions[T] | null {
  const roleRules = rules[role];
  if (!roleRules) return null;
  const tableRules = roleRules[table];
  if (!tableRules) return null;
  return (tableRules[op] as TablePermissions[T]) ?? null;
}
