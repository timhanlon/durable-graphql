import { defineRelations } from "drizzle-orm";
import * as schema from "./schema.js";

export const { users, posts, comments } = defineRelations(schema, (r) => ({
  users: {
    posts: r.many.posts(),
    comments: r.many.comments(),
  },
  posts: {
    author: r.one.users({
      from: r.posts.authorId,
      to: r.users.id,
    }),
    comments: r.many.comments(),
  },
  comments: {
    post: r.one.posts({
      from: r.comments.postId,
      to: r.posts.id,
    }),
    author: r.one.users({
      from: r.comments.authorId,
      to: r.users.id,
    }),
  },
}));
