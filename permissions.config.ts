import { definePermissions } from "./src/permissions/define.js";
import * as dbSchema from "./src/db/schema.js";

const tables = {
  users: dbSchema.users,
  posts: dbSchema.posts,
  comments: dbSchema.comments,
};

export const defaultRules = definePermissions(tables, {
  admin: {
    users: {
      select: { columns: "*" },
      insert: { columns: "*" },
      update: { columns: "*" },
      delete: {},
    },
    posts: {
      select: { columns: "*" },
      insert: { columns: "*" },
      update: { columns: "*" },
      delete: {},
    },
    comments: {
      select: { columns: "*" },
      insert: { columns: "*" },
      update: { columns: "*" },
      delete: {},
    },
  },
  user: {
    users: {
      select: {
        columns: ["id", "name", "role", "createdAt"],
        filter: { id: { _eq: "X-User-Id" } },
      },
    },
    posts: {
      select: {
        columns: ["id", "title", "body", "published", "authorId", "createdAt"],
        filter: {
          _or: [{ published: { _eq: true } }, { authorId: { _eq: "X-User-Id" } }],
        },
      },
      insert: {
        columns: ["title", "body", "published"],
        presets: { authorId: "X-User-Id" },
      },
      update: {
        columns: ["title", "body", "published"],
        filter: { authorId: { _eq: "X-User-Id" } },
      },
      delete: {
        filter: { authorId: { _eq: "X-User-Id" } },
      },
    },
    comments: {
      select: {
        columns: ["id", "body", "postId", "authorId", "createdAt"],
      },
      insert: {
        columns: ["body", "postId"],
        presets: { authorId: "X-User-Id" },
      },
      update: {
        columns: ["body"],
        filter: { authorId: { _eq: "X-User-Id" } },
      },
      delete: {
        filter: { authorId: { _eq: "X-User-Id" } },
      },
    },
  },
});
