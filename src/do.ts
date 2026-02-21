import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { createYoga } from "graphql-yoga";
import { generateSchema } from "./schema/generator.js";
import { deriveRelations } from "./schema/introspect.js";
import { extractSession } from "./context.js";
import { defaultRules } from "../permissions.config.js";
import * as dbSchema from "./db/schema.js";
import type { OperationContext } from "./schema/operations.js";
import migrationConfig from "../drizzle/migrations.js";

const tables = {
  users: dbSchema.users,
  posts: dbSchema.posts,
  comments: dbSchema.comments,
};

const relations = deriveRelations(tables);

export class GraphQLDurableObject extends DurableObject {
  private db: ReturnType<typeof drizzle>;
  private yoga: ReturnType<typeof createYoga<Record<string, any>, OperationContext>>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.db = drizzle(ctx.storage, { logger: false });

    ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrationConfig);
    });

    const { schema, registry } = generateSchema(tables, relations);

    this.yoga = createYoga({
      schema,
      graphqlEndpoint: "/graphql",
      graphiql: env.ENABLE_GRAPHIQL === "true",
      context: ({ request }): OperationContext => {
        const session = extractSession(request);
        return {
          db: this.db,
          session,
          rules: defaultRules,
          registry,
          relationLoaders: {
            many: new Map(),
            one: new Map(),
          },
        };
      },
    });
  }

  async fetch(request: Request): Promise<Response> {
    return this.yoga.fetch(request);
  }
}
