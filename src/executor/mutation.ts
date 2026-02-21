import { and, type SQL } from "drizzle-orm";
import { GraphQLError } from "graphql";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { InsertPermission, UpdatePermission, DeletePermission, SelectPermission, Session, PermissionRules } from "../permissions/types.js";
import { buildWhereClause, applyPresets, getPermission } from "../permissions/engine.js";
import type { TableRegistry } from "../schema/generator.js";
import { userWhereToSQL } from "./where.js";
import { executeFind } from "./query.js";

interface InsertOptions {
  objects: Record<string, unknown>[];
  permission: InsertPermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  registry: TableRegistry;
  rules: PermissionRules;
}

interface UpdateOptions {
  userWhere: Record<string, any>;
  set: Record<string, unknown>;
  permission: UpdatePermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  registry: TableRegistry;
  rules: PermissionRules;
}

interface DeleteOptions {
  userWhere: Record<string, any>;
  permission: DeletePermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  registry: TableRegistry;
  rules: PermissionRules;
}

/**
 * Combine user WHERE + permission WHERE into a single clause.
 */
function combinedWhere(
  userWhere: Record<string, any>,
  permissionFilter: UpdatePermission["filter"] | DeletePermission["filter"],
  session: Session,
  columns: Record<string, SQLiteColumn>
): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  parts.push(userWhereToSQL(userWhere, columns));

  if (permissionFilter) {
    parts.push(buildWhereClause(permissionFilter, session, columns));
  }

  const valid = parts.filter((c): c is SQL => c !== undefined);
  return valid.length === 0 ? undefined : valid.length === 1 ? valid[0] : and(...valid);
}

/**
 * Filter mutation results through select permissions.
 * First filters out rows that don't match the select row-level filter,
 * then strips columns the role can't read.
 */
/** @internal exported for testing */
export function applySelectVisibility(
  rows: Record<string, unknown>[],
  selectPerm: SelectPermission | null | undefined,
  session: Session,
  columns: Record<string, SQLiteColumn>
): Record<string, unknown>[] {
  if (!selectPerm) {
    // No select permission — don't leak row existence or count
    return [];
  }

  // Row-level filter: evaluate the select permission's filter against each row
  let visible = rows;
  if (selectPerm.filter) {
    visible = rows.filter((row) =>
      evaluateFilter(selectPerm.filter!, row, session)
    );
  }

  // Column-level filter: strip columns the role can't read
  const allowedCols = selectPerm.columns;
  return visible.map((row) => {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (allowedCols === "*" || allowedCols.includes(key)) {
        filtered[key] = value;
      }
    }
    return filtered;
  });
}

/**
 * Evaluate a BooleanExpression filter against a row in-memory.
 * Used to apply row-level select visibility on mutation return payloads.
 */
/** @internal exported for testing */
export function evaluateFilter(
  filter: import("../permissions/types.js").BooleanExpression,
  row: Record<string, unknown>,
  session: Session
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (key === "_and") {
      const exprs = value as import("../permissions/types.js").BooleanExpression[];
      if (!exprs.every((f) => evaluateFilter(f, row, session))) return false;
    } else if (key === "_or") {
      const exprs = value as import("../permissions/types.js").BooleanExpression[];
      if (!exprs.some((f) => evaluateFilter(f, row, session))) return false;
    } else if (key === "_not") {
      if (evaluateFilter(value as import("../permissions/types.js").BooleanExpression, row, session))
        return false;
    } else {
      // Column comparison
      const comp = value as import("../permissions/types.js").ComparisonExp;
      const rowVal = row[key];
      if (!evaluateComparison(rowVal, comp, session)) return false;
    }
  }
  return true;
}

/** @internal exported for testing */
export function evaluateComparison(
  rowVal: unknown,
  comp: import("../permissions/types.js").ComparisonExp,
  session: Session
): boolean {
  const resolve = (v: import("../permissions/types.js").SessionValue) => {
    if (typeof v === "string" && v.startsWith("X-")) {
      const resolved = session.vars[v];
      if (resolved === undefined) return v;
      const num = Number(resolved);
      return !Number.isNaN(num) && resolved !== "" ? num : resolved;
    }
    return v;
  };

  if (comp._eq !== undefined && rowVal != resolve(comp._eq)) return false;
  if (comp._ne !== undefined && rowVal == resolve(comp._ne)) return false;
  if (comp._gt !== undefined && !((rowVal as number) > (resolve(comp._gt) as number))) return false;
  if (comp._lt !== undefined && !((rowVal as number) < (resolve(comp._lt) as number))) return false;
  if (comp._gte !== undefined && !((rowVal as number) >= (resolve(comp._gte) as number))) return false;
  if (comp._lte !== undefined && !((rowVal as number) <= (resolve(comp._lte) as number))) return false;
  if (comp._in !== undefined && !comp._in.map(resolve).includes(rowVal as any)) return false;
  if (comp._nin !== undefined && comp._nin.map(resolve).includes(rowVal as any)) return false;
  if (comp._is_null !== undefined && (comp._is_null ? rowVal != null : rowVal == null)) return false;
  return true;
}

/**
 * Execute INSERT with permission filtering: column filter + presets + check.
 * Wrapped in a transaction for atomic check enforcement.
 */
export async function executeInsert(
  db: any,
  tableName: string,
  opts: InsertOptions
): Promise<Record<string, unknown>[]> {
  const { objects, permission, session, columns, registry, rules } = opts;
  const table = registry.tables[tableName];
  if (!table) return [];

  const selectPerm = getPermission(session.role, tableName, "select", rules);

  const results: Record<string, unknown>[] = [];

  for (const obj of objects) {
    // Filter to allowed columns
    let data: Record<string, unknown> = {};
    const allowed = permission.columns;
    for (const [key, value] of Object.entries(obj)) {
      if (allowed === "*" || allowed.includes(key)) {
        data[key] = value;
      }
    }

    // Apply presets (overwrite user values)
    data = applyPresets(data, permission.presets, session);

    if (permission.check) {
      // Atomic: insert + check in a transaction
      const insertedRows = await db.transaction(async (tx: any) => {
        const result = await tx.insert(table).values(data).returning();

        const pkCol = Object.entries(columns).find(([, c]) => c.primary);
        if (pkCol && result.length > 0) {
          const insertedId = result[0][pkCol[0]];
          const visible = await executeFind(tx, tableName, {
            userWhere: { [pkCol[0]]: { _eq: insertedId } },
            permission: { columns: permission.columns, filter: permission.check },
            session,
            columns,
            limit: 1,
            registry,
          });
          if (visible.length === 0) {
            tx.rollback();
          }
        }

        return result;
      });

      results.push(...insertedRows);
    } else {
      const result = await db.insert(table).values(data).returning();
      results.push(...result);
    }
  }

  return applySelectVisibility(results, selectPerm, session, columns);
}

/**
 * Execute UPDATE with permission filtering.
 * Check enforcement is atomic via transaction.
 */
export async function executeUpdate(
  db: any,
  tableName: string,
  opts: UpdateOptions
): Promise<Record<string, unknown>[]> {
  const { userWhere: uw, set, permission, session, columns, registry, rules } = opts;
  const table = registry.tables[tableName];
  if (!table) return [];

  // Reject empty _set
  const filteredSet: Record<string, unknown> = {};
  const allowed = permission.columns;
  for (const [key, value] of Object.entries(set)) {
    if (value !== undefined && (allowed === "*" || allowed.includes(key))) {
      filteredSet[key] = value;
    }
  }

  const setData = applyPresets(filteredSet, permission.presets, session);

  if (Object.keys(setData).length === 0) {
    throw new GraphQLError(`Empty _set: no valid columns to update on ${tableName}`);
  }

  const where = combinedWhere(uw, permission.filter, session, columns);
  const selectPerm = getPermission(session.role, tableName, "select", rules);

  if (permission.check) {
    // Atomic: update + check in a transaction
    const results = await db.transaction(async (tx: any) => {
      let query = tx.update(table).set(setData);
      if (where) query = query.where(where);
      const rows = await query.returning();

      const pkCol = Object.entries(columns).find(([, c]) => c.primary);
      if (pkCol && rows.length > 0) {
        for (const row of rows) {
          const visible = await executeFind(tx, tableName, {
            userWhere: { [pkCol[0]]: { _eq: row[pkCol[0]] } },
            permission: { columns: permission.columns, filter: permission.check },
            session,
            columns,
            limit: 1,
            registry,
          });
          if (visible.length === 0) {
            tx.rollback();
          }
        }
      }

      return rows;
    });

    return applySelectVisibility(results, selectPerm, session, columns);
  }

  let query = db.update(table).set(setData);
  if (where) query = query.where(where);
  const results = await query.returning();

  return applySelectVisibility(results, selectPerm, session, columns);
}

/**
 * Execute DELETE with permission filtering.
 */
export async function executeDelete(
  db: any,
  tableName: string,
  opts: DeleteOptions
): Promise<Record<string, unknown>[]> {
  const { userWhere: uw, permission, session, columns, registry, rules } = opts;
  const table = registry.tables[tableName];
  if (!table) return [];

  const where = combinedWhere(uw, permission.filter, session, columns);
  const selectPerm = getPermission(session.role, tableName, "select", rules);

  let query = db.delete(table);
  if (where) query = query.where(where);
  const results = await query.returning();

  return applySelectVisibility(results, selectPerm, session, columns);
}
