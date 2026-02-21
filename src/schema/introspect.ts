import { getTableColumns, type Table } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { RelationConfig } from "./generator.js";

/**
 * Derive RelationConfigs from Drizzle table foreign keys.
 *
 * For each FK on table A referencing table B:
 *   - A → B as "one" (the FK owner has a reference to one parent)
 *   - B → A as "many" (the referenced table has many children)
 */
export function deriveRelations(tables: Record<string, Table>): RelationConfig[] {
  const relations: RelationConfig[] = [];

  // Build reverse lookup: SQL table name → our key name
  const sqlNameToKey = new Map<string, string>();
  for (const [key, table] of Object.entries(tables)) {
    const config = getTableConfig(table as SQLiteTable);
    sqlNameToKey.set(config.name, key);
  }

  for (const [sourceName, table] of Object.entries(tables)) {
    const config = getTableConfig(table as SQLiteTable);
    const sourceColumns = getTableColumns(table);

    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      const foreignTableConfig = getTableConfig(ref.foreignTable as SQLiteTable);
      const targetName = sqlNameToKey.get(foreignTableConfig.name);
      if (!targetName) continue;

      // Find column names by matching the column objects
      const sourceColName = findColumnName(sourceColumns, ref.columns[0]);
      const targetColName = findColumnName(getTableColumns(tables[targetName]), ref.foreignColumns[0]);
      if (!sourceColName || !targetColName) continue;

      // source → target (one): e.g. posts.authorId → users.id
      relations.push({
        sourceTable: sourceName,
        targetTable: targetName,
        type: "one",
        sourceColumn: sourceColName,
        targetColumn: targetColName,
      });

      // target → source (many): e.g. users.id → posts.authorId
      relations.push({
        sourceTable: targetName,
        targetTable: sourceName,
        type: "many",
        sourceColumn: targetColName,
        targetColumn: sourceColName,
      });
    }
  }

  return relations;
}

function findColumnName(columns: Record<string, any>, target: any): string | undefined {
  for (const [name, col] of Object.entries(columns)) {
    if (col === target) return name;
  }
  return undefined;
}
