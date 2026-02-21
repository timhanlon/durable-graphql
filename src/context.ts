import type { Session } from "./permissions/types.js";

/**
 * Extract session info from request headers.
 * X-Role determines the role; X-* headers become session vars.
 */
export function extractSession(request: Request): Session {
  const role = request.headers.get("X-Role") || "anonymous";
  const userId = request.headers.get("X-User-Id");

  const vars: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith("x-") && key !== "x-role") {
      // Normalize to X-Title-Case for matching permission rules
      const normalized = key
        .split("-")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join("-");
      vars[normalized] = value;
    }
  }

  return { role, userId, vars };
}
