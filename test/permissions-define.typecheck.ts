import { definePermissions } from "../src/permissions/define.js";
import { users, posts, comments } from "../src/db/schema.js";

const tables = { users, posts, comments };

// Valid: table names + column names are inferred from Drizzle schema.
definePermissions(tables, {
  admin: {
    users: {
      select: { columns: "*" },
      insert: { columns: ["name", "email", "role"] },
      update: { columns: ["name"], filter: { id: { _eq: "X-User-Id" } } },
    },
    posts: {
      select: { columns: ["id", "title", "createdAt"] },
      insert: { columns: ["title", "body"], presets: { authorId: "X-User-Id" } },
    },
  },
});

// Invalid table name should fail.
definePermissions(tables, {
  user: {
    // @ts-expect-error - "profiles" is not a known table
    profiles: {
      select: { columns: "*" },
    },
  },
});

// Invalid select column should fail.
definePermissions(tables, {
  user: {
    users: {
      // @ts-expect-error - "fullName" is not a column on users
      select: { columns: ["id", "fullName"] },
    },
  },
});

// Invalid filter key should fail.
definePermissions(tables, {
  user: {
    comments: {
      select: {
        columns: ["id"],
        // @ts-expect-error - "ownerId" is not a column on comments
        filter: { ownerId: { _eq: "X-User-Id" } },
      },
    },
  },
});

// Invalid presets key should fail.
definePermissions(tables, {
  user: {
    posts: {
      insert: {
        columns: ["title"],
        // @ts-expect-error - "ownerId" is not a column on posts
        presets: { ownerId: "X-User-Id" },
      },
    },
  },
});
