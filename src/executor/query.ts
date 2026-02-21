import { and, asc, desc, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { SelectPermission, Session } from "../permissions/types.js";
import { buildWhereClause } from "../permissions/engine.js";
import type { TableRegistry } from "../schema/generator.js";
import { userWhereToSQL } from "./where.js";

interface FindOptions {
  userWhere?: Record<string, any>;
  permission: SelectPermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  limit?: number;
  offset?: number;
  orderBy?: Record<string, string>;
  registry: TableRegistry;
}

interface FindByPkOptions {
  pkColumn: string;
  pkValue: string | number;
  permission: SelectPermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  registry: TableRegistry;
}

interface FindPageOptions {
  userWhere?: Record<string, any>;
  permission: SelectPermission;
  session: Session;
  columns: Record<string, SQLiteColumn>;
  first: number;
  after?: string;
  pkColumn: string;
  registry: TableRegistry;
}

export interface CursorPageResult {
  nodes: Record<string, unknown>[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

function encodeCursor(pkValue: unknown): string {
  return btoa(JSON.stringify({ pk: pkValue }));
}

function decodeCursor(cursor: string): unknown {
  try {
    const parsed = JSON.parse(atob(cursor)) as { pk?: unknown };
    if (!Object.prototype.hasOwnProperty.call(parsed, "pk")) {
      throw new Error("Invalid cursor payload");
    }
    return parsed.pk;
  } catch {
    throw new Error("Invalid cursor");
  }
}

/**
 * Execute a find-many query with permission filtering.
 */
export async function executeFind(
  db: any,
  tableName: string,
  opts: FindOptions
): Promise<Record<string, unknown>[]> {
  const { userWhere, permission, session, columns, limit, offset, orderBy, registry } = opts;

  const table = registry.tables[tableName];
  if (!table) return [];

  // Build combined where: user filter AND permission filter
  const whereParts: (SQL | undefined)[] = [];

  if (userWhere) {
    whereParts.push(userWhereToSQL(userWhere, columns));
  }

  if (permission.filter) {
    whereParts.push(buildWhereClause(permission.filter, session, columns));
  }

  const validParts = whereParts.filter((c): c is SQL => c !== undefined);
  const combinedWhere = validParts.length === 0 ? undefined : validParts.length === 1 ? validParts[0] : and(...validParts);

  // Build select columns
  const allowedCols = permission.columns;
  const selectColumns: Record<string, SQLiteColumn> = {};
  for (const [colName, col] of Object.entries(columns)) {
    if (allowedCols === "*" || allowedCols.includes(colName)) {
      selectColumns[colName] = col;
    }
  }

  // Build query
  let query = db.select(selectColumns).from(table);

  if (combinedWhere) {
    query = query.where(combinedWhere);
  }

  if (orderBy) {
    const orderClauses = [];
    for (const [colName, direction] of Object.entries(orderBy)) {
      const col = columns[colName];
      if (col) {
        orderClauses.push(direction === "desc" ? desc(col) : asc(col));
      }
    }
    if (orderClauses.length > 0) {
      query = query.orderBy(...orderClauses);
    }
  }

  const effectiveLimit = permission.limit
    ? Math.min(limit ?? permission.limit, permission.limit)
    : limit;

  if (effectiveLimit) {
    query = query.limit(effectiveLimit);
  }

  if (offset) {
    query = query.offset(offset);
  }

  return query;
}

/**
 * Execute a find-by-PK query with permission filtering.
 */
export async function executeFindByPk(
  db: any,
  tableName: string,
  opts: FindByPkOptions
): Promise<Record<string, unknown> | null> {
  const { pkColumn, pkValue, permission, session, columns, registry } = opts;

  const results = await executeFind(db, tableName, {
    userWhere: { [pkColumn]: { _eq: pkValue } },
    permission,
    session,
    columns,
    limit: 1,
    registry,
  });

  return results[0] ?? null;
}

/**
 * Execute cursor pagination using primary-key ordering.
 */
export async function executeFindPage(
  db: any,
  tableName: string,
  opts: FindPageOptions
): Promise<CursorPageResult> {
  const { userWhere, permission, session, columns, first, after, pkColumn, registry } = opts;

  const cursorFilter = after
    ? { [pkColumn]: { _gt: decodeCursor(after) } }
    : undefined;

  const combinedUserWhere =
    userWhere && cursorFilter
      ? { _and: [userWhere, cursorFilter] }
      : userWhere ?? cursorFilter;

  const effectiveFirst = permission.limit
    ? Math.min(first, permission.limit)
    : first;

  const nodes = await executeFind(db, tableName, {
    userWhere: combinedUserWhere,
    permission,
    session,
    columns,
    orderBy: { [pkColumn]: "asc" },
    limit: effectiveFirst,
    registry,
  });

  if (nodes.length === 0) {
    return { nodes: [], nextCursor: null, hasNextPage: false };
  }

  const lastNode = nodes[nodes.length - 1];
  const probeWhere = {
    _and: [
      ...(combinedUserWhere ? [combinedUserWhere] : []),
      { [pkColumn]: { _gt: lastNode[pkColumn] } },
    ],
  };

  const probe = await executeFind(db, tableName, {
    userWhere: probeWhere,
    permission,
    session,
    columns,
    orderBy: { [pkColumn]: "asc" },
    limit: 1,
    registry,
  });

  const hasNextPage = probe.length > 0;
  const nextCursor = hasNextPage ? encodeCursor(lastNode[pkColumn]) : null;

  return { nodes, nextCursor, hasNextPage };
}
