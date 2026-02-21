import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLString,
  GraphQLObjectType,
  GraphQLInputObjectType,
  type GraphQLFieldConfigMap,
} from "graphql";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { GraphQLError } from "graphql";
import { drizzleTypeToGraphQL } from "./types.js";
import type { Session } from "../permissions/types.js";
import { getPermission } from "../permissions/engine.js";
import type { PermissionRules } from "../permissions/types.js";
import { executeFind, executeFindByPk, executeFindPage } from "../executor/query.js";
import { executeInsert, executeUpdate, executeDelete } from "../executor/mutation.js";
import type { TableRegistry } from "./generator.js";

export interface OperationContext {
  db: any;
  session: Session;
  rules: PermissionRules;
  registry: TableRegistry;
  relationLoaders: {
    many: Map<string, unknown>;
    one: Map<string, unknown>;
  };
}

/**
 * Build query fields for a table: list + byPk.
 */
export function buildQueryFields(
  tableName: string,
  objectType: GraphQLObjectType,
  whereInput: GraphQLInputObjectType,
  orderByInput: GraphQLInputObjectType,
  columns: Record<string, SQLiteColumn>
): GraphQLFieldConfigMap<unknown, OperationContext> {
  const fields: GraphQLFieldConfigMap<unknown, OperationContext> = {};
  const pageType = new GraphQLObjectType({
    name: `${objectType.name}Page`,
    fields: {
      nodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))) },
      nextCursor: { type: GraphQLString },
      hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });

  // findMany: [table](where, limit, offset, orderBy)
  fields[tableName] = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
    args: {
      where: { type: whereInput },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      orderBy: { type: orderByInput },
    },
    resolve: async (_root, args, ctx) => {
      const perm = getPermission(ctx.session.role, tableName, "select", ctx.rules);
      if (!perm) throw new GraphQLError(`Access denied: select on ${tableName}`);

      return executeFind(ctx.db, tableName, {
        userWhere: args.where,
        permission: perm,
        session: ctx.session,
        columns,
        limit: args.limit,
        offset: args.offset,
        orderBy: args.orderBy,
        registry: ctx.registry,
      });
    },
  };

  // cursor pagination: [table]Page(where, first, after)
  fields[`${tableName}Page`] = {
    type: new GraphQLNonNull(pageType),
    args: {
      where: { type: whereInput },
      first: { type: new GraphQLNonNull(GraphQLInt) },
      after: { type: GraphQLString },
    },
    resolve: async (_root, args, ctx) => {
      const perm = getPermission(ctx.session.role, tableName, "select", ctx.rules);
      if (!perm) throw new GraphQLError(`Access denied: select on ${tableName}`);

      if (!Number.isInteger(args.first) || args.first <= 0) {
        throw new GraphQLError(`Invalid 'first' value on ${tableName}Page: must be a positive integer`);
      }

      const pkColumn = Object.entries(columns).find(([, col]) => col.primary);
      if (!pkColumn) {
        throw new GraphQLError(`Cursor pagination is unavailable for ${tableName}: missing primary key`);
      }

      try {
        return await executeFindPage(ctx.db, tableName, {
          userWhere: args.where,
          permission: perm,
          session: ctx.session,
          columns,
          first: args.first,
          after: args.after,
          pkColumn: pkColumn[0],
          registry: ctx.registry,
        });
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        throw new GraphQLError(err instanceof Error ? err.message : "Invalid cursor");
      }
    },
  };

  // findByPk: [table]ByPk(id)
  const pkColumn = Object.entries(columns).find(([, col]) => col.primary);
  if (pkColumn) {
    fields[`${tableName}ByPk`] = {
      type: objectType,
      args: {
        [pkColumn[0]]: { type: new GraphQLNonNull(drizzleTypeToGraphQL(pkColumn[1])) },
      },
      resolve: async (_root, args, ctx) => {
        const perm = getPermission(ctx.session.role, tableName, "select", ctx.rules);
        if (!perm) throw new GraphQLError(`Access denied: select on ${tableName}`);

        return executeFindByPk(ctx.db, tableName, {
          pkColumn: pkColumn[0],
          pkValue: args[pkColumn[0]],
          permission: perm,
          session: ctx.session,
          columns,
          registry: ctx.registry,
        });
      },
    };
  }

  return fields;
}

/**
 * Build mutation fields for a table: insert, update, delete.
 */
export function buildMutationFields(
  tableName: string,
  objectType: GraphQLObjectType,
  whereInput: GraphQLInputObjectType,
  insertInput: GraphQLInputObjectType,
  updateInput: GraphQLInputObjectType,
  columns: Record<string, SQLiteColumn>
): GraphQLFieldConfigMap<unknown, OperationContext> {
  const fields: GraphQLFieldConfigMap<unknown, OperationContext> = {};

  // insert_[table](objects)
  fields[`insert_${tableName}`] = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
    args: {
      objects: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(insertInput))),
      },
    },
    resolve: async (_root, args, ctx) => {
      const perm = getPermission(ctx.session.role, tableName, "insert", ctx.rules);
      if (!perm) throw new GraphQLError(`Access denied: insert on ${tableName}`);

      return executeInsert(ctx.db, tableName, {
        objects: args.objects,
        permission: perm,
        session: ctx.session,
        columns,
        registry: ctx.registry,
        rules: ctx.rules,
      });
    },
  };

  // update_[table](where, _set)
  fields[`update_${tableName}`] = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
    args: {
      where: { type: new GraphQLNonNull(whereInput) },
      _set: { type: new GraphQLNonNull(updateInput) },
    },
    resolve: async (_root, args, ctx) => {
      const perm = getPermission(ctx.session.role, tableName, "update", ctx.rules);
      if (!perm) throw new GraphQLError(`Access denied: update on ${tableName}`);

      const allowed = perm.columns;
      const hasUserSet = Object.entries(args._set as Record<string, unknown>).some(
        ([key, value]) =>
          value !== undefined && (allowed === "*" || allowed.includes(key))
      );
      const hasPresets =
        perm.presets !== undefined && Object.keys(perm.presets).length > 0;
      if (!hasUserSet && !hasPresets) {
        throw new GraphQLError(`Empty _set: no valid columns to update on ${tableName}`);
      }

      return executeUpdate(ctx.db, tableName, {
        userWhere: args.where,
        set: args._set,
        permission: perm,
        session: ctx.session,
        columns,
        registry: ctx.registry,
        rules: ctx.rules,
      });
    },
  };

  // delete_[table](where)
  fields[`delete_${tableName}`] = {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(objectType))),
    args: {
      where: { type: new GraphQLNonNull(whereInput) },
    },
    resolve: async (_root, args, ctx) => {
      const perm = getPermission(ctx.session.role, tableName, "delete", ctx.rules);
      if (!perm) throw new GraphQLError(`Access denied: delete on ${tableName}`);

      return executeDelete(ctx.db, tableName, {
        userWhere: args.where,
        permission: perm,
        session: ctx.session,
        columns,
        registry: ctx.registry,
        rules: ctx.rules,
      });
    },
  };

  return fields;
}
