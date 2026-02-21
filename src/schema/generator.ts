import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLFieldConfigMap,
} from "graphql";
import { getTableColumns, type Table } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { buildObjectType, buildInsertInput, buildUpdateInput } from "./types.js";
import { buildWhereInput, buildOrderByInput } from "./filters.js";
import { buildQueryFields, buildMutationFields, type OperationContext } from "./operations.js";
import { getPermission } from "../permissions/engine.js";
import { executeFind } from "../executor/query.js";

export interface RelationConfig {
  sourceTable: string;
  targetTable: string;
  type: "one" | "many";
  sourceColumn: string;
  targetColumn: string;
  /** Field name on the parent type. Defaults to targetTable (many) or singularized targetTable (one). */
  fieldName?: string;
}

export interface TableRegistry {
  tables: Record<string, Table>;
  columns: Record<string, Record<string, SQLiteColumn>>;
  objectTypes: Record<string, GraphQLObjectType>;
  relations: RelationConfig[];
}

interface ManyPending {
  sourceValue: unknown;
  resolve: (rows: Record<string, unknown>[]) => void;
  reject: (err: unknown) => void;
}

interface OnePending {
  sourceValue: unknown;
  resolve: (row: Record<string, unknown> | null) => void;
  reject: (err: unknown) => void;
}

interface ManyBatchState {
  scheduled: boolean;
  pending: ManyPending[];
}

interface OneBatchState {
  scheduled: boolean;
  pending: OnePending[];
}

/**
 * Generate a complete GraphQL schema from Drizzle tables and relation configs.
 */
export function generateSchema(
  tables: Record<string, Table>,
  relations: RelationConfig[]
): { schema: GraphQLSchema; registry: TableRegistry } {
  const registry: TableRegistry = {
    tables,
    columns: {},
    objectTypes: {},
    relations,
  };

  // Step 1: Extract columns for all tables
  for (const [name, table] of Object.entries(tables)) {
    registry.columns[name] = getTableColumns(table) as Record<string, SQLiteColumn>;
  }

  // Step 2: Build GraphQL object types (with relation thunks for lazy resolution)
  for (const [name, table] of Object.entries(tables)) {
    const columns = registry.columns[name];
    const tableName = name;

    registry.objectTypes[name] = buildObjectType(name, columns, () => {
      const fields: GraphQLFieldConfigMap<any, any> = {};

      for (const rel of relations) {
        if (rel.sourceTable !== tableName) continue;

        const targetType = registry.objectTypes[rel.targetTable];
        if (!targetType) continue;

        let fieldName = rel.fieldName ?? (rel.type === "many" ? rel.targetTable : singularize(rel.targetTable));

        // Disambiguate if field name collides (e.g. two FKs to same target)
        if (fields[fieldName]) {
          const suffix = rel.sourceColumn.replace(/Id$/, "").replace(/(_id)$/, "");
          fieldName = `${fieldName}As${suffix.charAt(0).toUpperCase() + suffix.slice(1)}`;
        }

        if (rel.type === "many") {
          fields[fieldName] = {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(targetType))),
            resolve: (parent: Record<string, unknown>, _args: unknown, ctx: OperationContext) => {
              const perm = getPermission(ctx.session.role, rel.targetTable, "select", ctx.rules);
              if (!perm) return [];

              const sourceValue = parent[rel.sourceColumn];
              if (sourceValue === null || sourceValue === undefined) return [];

              // Permission limits are per relation query; keep the old path to avoid changing semantics.
              if (perm.limit) {
                return executeFind(ctx.db, rel.targetTable, {
                  userWhere: { [rel.targetColumn]: { _eq: sourceValue } },
                  permission: perm,
                  session: ctx.session,
                  columns: registry.columns[rel.targetTable],
                  registry,
                });
              }

              const loaderKey = relationCacheKey(rel);
              let state = ctx.relationLoaders.many.get(loaderKey) as ManyBatchState | undefined;
              if (!state) {
                state = { scheduled: false, pending: [] };
                ctx.relationLoaders.many.set(loaderKey, state);
              }

              return new Promise<Record<string, unknown>[]>((resolve, reject) => {
                state!.pending.push({ sourceValue, resolve, reject });
                if (state!.scheduled) return;
                state!.scheduled = true;

                queueMicrotask(async () => {
                  const batch = state!.pending;
                  state!.pending = [];
                  state!.scheduled = false;

                  const values = [...new Set(batch.map((item) => item.sourceValue))];

                  try {
                    const rows = await executeFind(ctx.db, rel.targetTable, {
                      userWhere: { [rel.targetColumn]: { _in: values } },
                      permission: perm,
                      session: ctx.session,
                      columns: registry.columns[rel.targetTable],
                      registry,
                    });

                    const grouped = new Map<string, Record<string, unknown>[]>();
                    for (const row of rows) {
                      const key = valueKey(row[rel.targetColumn]);
                      const existing = grouped.get(key) ?? [];
                      existing.push(row);
                      grouped.set(key, existing);
                    }

                    for (const item of batch) {
                      item.resolve(grouped.get(valueKey(item.sourceValue)) ?? []);
                    }
                  } catch (err) {
                    for (const item of batch) item.reject(err);
                  }
                });
              });
            },
          };
        } else {
          fields[fieldName] = {
            type: targetType,
            resolve: (parent: Record<string, unknown>, _args: unknown, ctx: OperationContext) => {
              const perm = getPermission(ctx.session.role, rel.targetTable, "select", ctx.rules);
              if (!perm) return null;

              const sourceValue = parent[rel.sourceColumn];
              if (sourceValue === null || sourceValue === undefined) return null;

              // Permission limits are per relation query; keep the old path to avoid changing semantics.
              if (perm.limit) {
                return executeFind(ctx.db, rel.targetTable, {
                  userWhere: { [rel.targetColumn]: { _eq: sourceValue } },
                  permission: perm,
                  session: ctx.session,
                  columns: registry.columns[rel.targetTable],
                  limit: 1,
                  registry,
                }).then((rows) => rows[0] ?? null);
              }

              const loaderKey = relationCacheKey(rel);
              let state = ctx.relationLoaders.one.get(loaderKey) as OneBatchState | undefined;
              if (!state) {
                state = { scheduled: false, pending: [] };
                ctx.relationLoaders.one.set(loaderKey, state);
              }

              return new Promise<Record<string, unknown> | null>((resolve, reject) => {
                state!.pending.push({ sourceValue, resolve, reject });
                if (state!.scheduled) return;
                state!.scheduled = true;

                queueMicrotask(async () => {
                  const batch = state!.pending;
                  state!.pending = [];
                  state!.scheduled = false;

                  const values = [...new Set(batch.map((item) => item.sourceValue))];

                  try {
                    const rows = await executeFind(ctx.db, rel.targetTable, {
                      userWhere: { [rel.targetColumn]: { _in: values } },
                      permission: perm,
                      session: ctx.session,
                      columns: registry.columns[rel.targetTable],
                      registry,
                    });

                    const byPk = new Map<string, Record<string, unknown>>();
                    for (const row of rows) {
                      const key = valueKey(row[rel.targetColumn]);
                      if (!byPk.has(key)) {
                        byPk.set(key, row);
                      }
                    }

                    for (const item of batch) {
                      item.resolve(byPk.get(valueKey(item.sourceValue)) ?? null);
                    }
                  } catch (err) {
                    for (const item of batch) item.reject(err);
                  }
                });
              });
            },
          };
        }
      }

      return fields;
    });
  }

  // Step 3: Build filter/input types and query/mutation fields
  const queryFields: GraphQLFieldConfigMap<unknown, OperationContext> = {};
  const mutationFields: GraphQLFieldConfigMap<unknown, OperationContext> = {};

  for (const [name] of Object.entries(tables)) {
    const columns = registry.columns[name];
    const objectType = registry.objectTypes[name];
    const whereInput = buildWhereInput(name, columns);
    const orderByInput = buildOrderByInput(name, columns);
    const insertInput = buildInsertInput(name, columns);
    const updateInput = buildUpdateInput(name, columns);

    Object.assign(queryFields, buildQueryFields(name, objectType, whereInput, orderByInput, columns));
    Object.assign(
      mutationFields,
      buildMutationFields(name, objectType, whereInput, insertInput, updateInput, columns)
    );
  }

  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: queryFields,
    }),
    mutation: new GraphQLObjectType({
      name: "Mutation",
      fields: mutationFields,
    }),
  });

  return { schema, registry };
}

/**
 * Naive but safe singularization — handles common English plurals.
 * Falls back to the original string if no rule matches.
 */
function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes") || word.endsWith("ches") || word.endsWith("shes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) return word.slice(0, -1);
  return word;
}

function relationCacheKey(rel: RelationConfig): string {
  return `${rel.sourceTable}.${rel.sourceColumn}:${rel.targetTable}.${rel.targetColumn}:${rel.type}`;
}

function valueKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}
