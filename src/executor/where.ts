import { eq, ne, and, or, not, gt, lt, gte, lte, inArray, notInArray, isNull, isNotNull, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Convert a GraphQL where input to a Drizzle SQL condition.
 */
export function userWhereToSQL(
  where: Record<string, any>,
  columns: Record<string, SQLiteColumn>
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined || value === null) continue;

    if (key === "_and" && Array.isArray(value)) {
      const inner = value.map((w: Record<string, any>) => userWhereToSQL(w, columns)).filter((c): c is SQL => c !== undefined);
      if (inner.length > 0) conditions.push(and(...inner));
    } else if (key === "_or" && Array.isArray(value)) {
      const inner = value.map((w: Record<string, any>) => userWhereToSQL(w, columns)).filter((c): c is SQL => c !== undefined);
      if (inner.length > 0) conditions.push(or(...inner));
    } else if (key === "_not" && typeof value === "object") {
      const inner = userWhereToSQL(value, columns);
      if (inner) conditions.push(not(inner));
    } else {
      const column = columns[key];
      if (!column || typeof value !== "object") continue;

      const comp = value as Record<string, any>;
      if (comp._eq !== undefined) conditions.push(eq(column, comp._eq));
      if (comp._ne !== undefined) conditions.push(ne(column, comp._ne));
      if (comp._gt !== undefined) conditions.push(gt(column, comp._gt));
      if (comp._lt !== undefined) conditions.push(lt(column, comp._lt));
      if (comp._gte !== undefined) conditions.push(gte(column, comp._gte));
      if (comp._lte !== undefined) conditions.push(lte(column, comp._lte));
      if (comp._in !== undefined) conditions.push(inArray(column, comp._in));
      if (comp._nin !== undefined) conditions.push(notInArray(column, comp._nin));
      if (comp._is_null !== undefined) conditions.push(comp._is_null ? isNull(column) : isNotNull(column));
    }
  }

  const valid = conditions.filter((c): c is SQL => c !== undefined);
  if (valid.length === 0) return undefined;
  return valid.length === 1 ? valid[0] : and(...valid);
}
