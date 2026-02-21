import { env } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * Helper to run a GraphQL query/mutation directly against the Durable Object,
 * bypassing the Worker auth layer. The DO trusts whatever headers it receives —
 * the Worker is the auth boundary, tested separately in jwt.test.ts.
 */
async function gql(
  query: string,
  opts: { role?: string; userId?: string } = {}
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.role) headers["X-Role"] = opts.role;
  if (opts.userId) headers["X-User-Id"] = opts.userId;

  const id = env.GRAPHQL_DO.idFromName("test");
  const stub = env.GRAPHQL_DO.get(id);

  const res = await stub.fetch("https://fake-host/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  const json = (await res.json()) as {
    data?: Record<string, any>;
    errors?: Array<{ message: string }>;
  };
  return json;
}

describe("Schema introspection", () => {
  it("exposes query and mutation types", async () => {
    const result = await gql(
      `{ __schema { queryType { fields { name } } mutationType { fields { name } } } }`,
      { role: "admin" }
    );

    const queryFields = result.data!.__schema.queryType.fields.map(
      (f: any) => f.name
    );
    const mutationFields = result.data!.__schema.mutationType.fields.map(
      (f: any) => f.name
    );

    expect(queryFields).toContain("users");
    expect(queryFields).toContain("usersByPk");
    expect(queryFields).toContain("usersPage");
    expect(queryFields).toContain("posts");
    expect(queryFields).toContain("comments");

    expect(mutationFields).toContain("insert_users");
    expect(mutationFields).toContain("update_users");
    expect(mutationFields).toContain("delete_users");
  });

  it("maps integer columns to Int type", async () => {
    const result = await gql(
      `{ __type(name: "Users") { fields { name type { name ofType { name } } } } }`,
      { role: "admin" }
    );
    const idField = result.data!.__type.fields.find(
      (f: any) => f.name === "id"
    );
    expect(idField.type.ofType.name).toBe("Int");
  });
});

describe("CRUD operations", () => {
  beforeAll(async () => {
    // Seed data as admin
    await gql(
      `mutation {
        insert_users(objects: [
          {name: "Alice", email: "alice@test.com", role: "admin"},
          {name: "Bob", email: "bob@test.com", role: "user"}
        ]) { id }
      }`,
      { role: "admin" }
    );
  });

  it("inserts and returns rows", async () => {
    const result = await gql(
      `mutation {
        insert_posts(objects: [{title: "Test Post", body: "Hello", published: true, authorId: 1}])
        { id title body published authorId }
      }`,
      { role: "admin" }
    );

    expect(result.errors).toBeUndefined();
    expect(result.data!.insert_posts).toHaveLength(1);
    expect(result.data!.insert_posts[0].title).toBe("Test Post");
  });

  it("queries with filtering", async () => {
    const result = await gql(
      `{ users(where: {name: {_eq: "Alice"}}) { id name email } }`,
      { role: "admin" }
    );

    expect(result.data!.users).toHaveLength(1);
    expect(result.data!.users[0].name).toBe("Alice");
  });

  it("queries by primary key", async () => {
    const result = await gql(`{ usersByPk(id: 1) { id name } }`, {
      role: "admin",
    });

    expect(result.data!.usersByPk).toEqual({ id: 1, name: "Alice" });
  });

  it("updates rows and returns updated data", async () => {
    const result = await gql(
      `mutation {
        update_users(where: {id: {_eq: 1}}, _set: {name: "Alice Updated"})
        { id name }
      }`,
      { role: "admin" }
    );

    expect(result.data!.update_users).toHaveLength(1);
    expect(result.data!.update_users[0].name).toBe("Alice Updated");
  });

  it("deletes rows and returns deleted data", async () => {
    // Insert a throwaway user to delete
    await gql(
      `mutation { insert_users(objects: [{name: "ToDelete", email: "del@test.com"}]) { id } }`,
      { role: "admin" }
    );

    const result = await gql(
      `mutation { delete_users(where: {name: {_eq: "ToDelete"}}) { id name } }`,
      { role: "admin" }
    );

    expect(result.data!.delete_users).toHaveLength(1);
    expect(result.data!.delete_users[0].name).toBe("ToDelete");
  });
});

describe("Permissions", () => {
  beforeAll(async () => {
    // Ensure we have users and posts
    await gql(
      `mutation {
        insert_users(objects: [
          {name: "PermAlice", email: "pa@test.com", role: "admin"},
          {name: "PermBob", email: "pb@test.com", role: "user"}
        ]) { id }
      }`,
      { role: "admin" }
    );
  });

  it("denies anonymous access", async () => {
    const result = await gql(`{ users { id } }`);
    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain("Access denied");
  });

  it("applies preset values on insert", async () => {
    // Get PermBob's ID dynamically
    const usersResult = await gql(
      `{ users(where: {name: {_eq: "PermBob"}}) { id } }`,
      { role: "admin" }
    );
    const bobId = String(usersResult.data!.users[0].id);

    const result = await gql(
      `mutation {
        insert_posts(objects: [{title: "Bob Post", body: "Content", published: true}])
        { id authorId }
      }`,
      { role: "user", userId: bobId }
    );

    expect(result.errors).toBeUndefined();
    // authorId should be preset from X-User-Id
    expect(result.data!.insert_posts[0].authorId).toBe(Number(bobId));
  });

  it("enforces row-level security on select", async () => {
    // Get user IDs
    const usersResult = await gql(
      `{ users(where: {name: {_in: ["PermAlice", "PermBob"]}}) { id name } }`,
      { role: "admin" }
    );
    const alice = usersResult.data!.users.find(
      (u: any) => u.name === "PermAlice"
    );
    const bob = usersResult.data!.users.find(
      (u: any) => u.name === "PermBob"
    );

    // Bob creates a draft post
    await gql(
      `mutation {
        insert_posts(objects: [{title: "Bob Draft", body: "Secret", published: false}])
        { id }
      }`,
      { role: "user", userId: String(bob.id) }
    );

    // Bob can see his draft
    const bobPosts = await gql(`{ posts { id title published } }`, {
      role: "user",
      userId: String(bob.id),
    });
    const bobDraft = bobPosts.data!.posts.find(
      (p: any) => p.title === "Bob Draft"
    );
    expect(bobDraft).toBeDefined();

    // Alice cannot see Bob's draft
    const alicePosts = await gql(`{ posts { id title published } }`, {
      role: "user",
      userId: String(alice.id),
    });
    const aliceDraft = alicePosts.data!.posts.find(
      (p: any) => p.title === "Bob Draft"
    );
    expect(aliceDraft).toBeUndefined();
  });

  it("prevents cross-user mutations", async () => {
    const usersResult = await gql(
      `{ users(where: {name: {_in: ["PermAlice", "PermBob"]}}) { id name } }`,
      { role: "admin" }
    );
    const alice = usersResult.data!.users.find(
      (u: any) => u.name === "PermAlice"
    );
    const bob = usersResult.data!.users.find(
      (u: any) => u.name === "PermBob"
    );

    // Get a post that Bob owns
    const bobPosts = await gql(
      `{ posts(where: {authorId: {_eq: ${bob.id}}}) { id title } }`,
      { role: "admin" }
    );
    if (bobPosts.data!.posts.length === 0) return; // skip if no posts

    const postId = bobPosts.data!.posts[0].id;

    // Alice tries to update Bob's post
    const result = await gql(
      `mutation {
        update_posts(where: {id: {_eq: ${postId}}}, _set: {title: "Hacked"})
        { id }
      }`,
      { role: "user", userId: String(alice.id) }
    );

    // Should return empty — permission filter blocks it
    expect(result.data!.update_posts).toHaveLength(0);
  });

  it("rejects empty _set on update", async () => {
    const result = await gql(
      `mutation { update_users(where: {id: {_eq: 1}}, _set: {}) { id } }`,
      { role: "admin" }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain("Empty _set");
  });
});

describe("Relations", () => {
  beforeAll(async () => {
    // Seed relation data
    await gql(
      `mutation {
        insert_users(objects: [{name: "RelUser", email: "rel@test.com"}]) { id }
      }`,
      { role: "admin" }
    );
    const users = await gql(
      `{ users(where: {name: {_eq: "RelUser"}}) { id } }`,
      { role: "admin" }
    );
    const userId = users.data!.users[0].id;

    await gql(
      `mutation {
        insert_posts(objects: [{title: "RelPost", body: "Content", published: true, authorId: ${userId}}])
        { id }
      }`,
      { role: "admin" }
    );
    const posts = await gql(
      `{ posts(where: {title: {_eq: "RelPost"}}) { id } }`,
      { role: "admin" }
    );
    const postId = posts.data!.posts[0].id;

    await gql(
      `mutation {
        insert_comments(objects: [{body: "Nice", postId: ${postId}, authorId: ${userId}}])
        { id }
      }`,
      { role: "admin" }
    );
  });

  it("resolves nested one-to-many relations", async () => {
    const result = await gql(
      `{ posts(where: {title: {_eq: "RelPost"}}) { title comments { body } } }`,
      { role: "admin" }
    );

    expect(result.data!.posts[0].comments).toHaveLength(1);
    expect(result.data!.posts[0].comments[0].body).toBe("Nice");
  });

  it("resolves nested many-to-one relations", async () => {
    const result = await gql(
      `{ posts(where: {title: {_eq: "RelPost"}}) { title user { name } } }`,
      { role: "admin" }
    );

    expect(result.data!.posts[0].user.name).toBe("RelUser");
  });

  it("resolves deeply nested relations", async () => {
    const result = await gql(
      `{ users(where: {name: {_eq: "RelUser"}}) { name posts { title comments { body user { name } } } } }`,
      { role: "admin" }
    );

    const user = result.data!.users[0];
    expect(user.posts[0].title).toBe("RelPost");
    expect(user.posts[0].comments[0].user.name).toBe("RelUser");
  });
});

describe("Filters", () => {
  beforeAll(async () => {
    await gql(
      `mutation {
        insert_users(objects: [
          {name: "FilterA", email: "fa@test.com"},
          {name: "FilterB", email: "fb@test.com"},
          {name: "FilterC", email: "fc@test.com"}
        ]) { id }
      }`,
      { role: "admin" }
    );
  });

  it("supports _in operator", async () => {
    const result = await gql(
      `{ users(where: {name: {_in: ["FilterA", "FilterC"]}}) { name } }`,
      { role: "admin" }
    );
    expect(result.data!.users).toHaveLength(2);
  });

  it("supports _and combinator", async () => {
    const result = await gql(
      `{ users(where: {_and: [{name: {_eq: "FilterA"}}, {email: {_eq: "fa@test.com"}}]}) { name } }`,
      { role: "admin" }
    );
    expect(result.data!.users).toHaveLength(1);
  });

  it("supports _or combinator", async () => {
    const result = await gql(
      `{ users(where: {_or: [{name: {_eq: "FilterA"}}, {name: {_eq: "FilterB"}}]}) { name } }`,
      { role: "admin" }
    );
    expect(result.data!.users).toHaveLength(2);
  });

  it("supports _not combinator", async () => {
    const result = await gql(
      `{ users(where: {_not: {name: {_eq: "FilterA"}}}) { name } }`,
      { role: "admin" }
    );
    const names = result.data!.users.map((u: any) => u.name);
    expect(names).not.toContain("FilterA");
  });

  it("supports limit and offset", async () => {
    const result = await gql(
      `{ users(limit: 2, offset: 0, orderBy: {name: ASC}) { name } }`,
      { role: "admin" }
    );
    expect(result.data!.users.length).toBeLessThanOrEqual(2);
  });
});

describe("Cursor pagination", () => {
  beforeAll(async () => {
    await gql(
      `mutation {
        insert_users(objects: [
          {name: "CursorA", email: "cursor-a@test.com"},
          {name: "CursorB", email: "cursor-b@test.com"},
          {name: "CursorC", email: "cursor-c@test.com"},
          {name: "CursorD", email: "cursor-d@test.com"}
        ]) { id }
      }`,
      { role: "admin" }
    );
  });

  it("returns a page with nextCursor and hasNextPage", async () => {
    const page1 = await gql(
      `{ usersPage(where: {name: {_in: ["CursorA", "CursorB", "CursorC", "CursorD"]}}, first: 2) { nodes { id name } nextCursor hasNextPage } }`,
      { role: "admin" }
    );

    expect(page1.errors).toBeUndefined();
    expect(page1.data!.usersPage.nodes).toHaveLength(2);
    expect(page1.data!.usersPage.hasNextPage).toBe(true);
    expect(typeof page1.data!.usersPage.nextCursor).toBe("string");
  });

  it("uses after cursor to fetch the next page", async () => {
    const page1 = await gql(
      `{ usersPage(where: {name: {_in: ["CursorA", "CursorB", "CursorC", "CursorD"]}}, first: 2) { nodes { id } nextCursor hasNextPage } }`,
      { role: "admin" }
    );

    const cursor = page1.data!.usersPage.nextCursor;
    const page2 = await gql(
      `{ usersPage(where: {name: {_in: ["CursorA", "CursorB", "CursorC", "CursorD"]}}, first: 2, after: "${cursor}") { nodes { id } nextCursor hasNextPage } }`,
      { role: "admin" }
    );

    const page1Ids = page1.data!.usersPage.nodes.map((u: any) => u.id);
    const page2Ids = page2.data!.usersPage.nodes.map((u: any) => u.id);

    expect(page2.errors).toBeUndefined();
    expect(page2Ids.every((id: number) => !page1Ids.includes(id))).toBe(true);
  });

  it("rejects malformed cursor", async () => {
    const result = await gql(
      `{ usersPage(first: 2, after: "not-base64") { nodes { id } } }`,
      { role: "admin" }
    );

    expect(result.errors).toBeDefined();
    expect(result.errors![0].message).toContain("Invalid cursor");
  });
});
