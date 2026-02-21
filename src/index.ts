import { GraphQLDurableObject } from "./do.js";
import { authMiddleware } from "./auth/middleware.js";

export { GraphQLDurableObject };

const SINGLE_TENANT_ID = "default";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/graphql") {
      return new Response("Not Found", { status: 404 });
    }

    // Authenticate: verify JWT and extract trusted headers.
    const authResult = await authMiddleware(request, env);
    if (authResult instanceof Response) {
      return authResult; // 401
    }

    // Route all requests to a single Durable Object instance.
    const id = env.GRAPHQL_DO.idFromName(SINGLE_TENANT_ID);
    const stub = env.GRAPHQL_DO.get(id);

    // Rewrite the URL to /graphql for the DO
    url.pathname = "/graphql";

    // Build headers for the DO request.
    // Strip identity headers from the original request to prevent spoofing,
    // then merge in trusted headers from the auth layer.
    const doHeaders = new Headers(request.headers);
    doHeaders.delete("X-Role");
    doHeaders.delete("X-User-Id");
    doHeaders.delete("Authorization");
    doHeaders.delete("X-Admin-Secret");
    for (const [key, value] of Object.entries(authResult.headers)) {
      doHeaders.set(key, value);
    }

    const doRequest = new Request(url.toString(), {
      method: request.method,
      headers: doHeaders,
      body: request.body,
    });

    return stub.fetch(doRequest);
  },
};
