export interface Session {
  role: string;
  userId: string | null;
  vars: Record<string, string>;
}

/** A value that can be a literal or a reference to a session variable like "X-User-Id" */
export type SessionValue = string | number | boolean;

/** Comparison operators for a single column */
export interface ComparisonExp {
  _eq?: SessionValue;
  _ne?: SessionValue;
  _gt?: SessionValue;
  _lt?: SessionValue;
  _gte?: SessionValue;
  _lte?: SessionValue;
  _in?: SessionValue[];
  _nin?: SessionValue[];
  _is_null?: boolean;
}

/** Boolean expression — column comparisons + logical combinators */
export interface BooleanExpression {
  _and?: BooleanExpression[];
  _or?: BooleanExpression[];
  _not?: BooleanExpression;
  [column: string]: ComparisonExp | BooleanExpression[] | BooleanExpression | undefined;
}

export interface SelectPermission {
  columns: string[] | "*";
  filter?: BooleanExpression;
  limit?: number;
}

export interface InsertPermission {
  columns: string[] | "*";
  check?: BooleanExpression;
  presets?: Record<string, SessionValue>;
}

export interface UpdatePermission {
  columns: string[] | "*";
  filter?: BooleanExpression;
  check?: BooleanExpression;
  presets?: Record<string, SessionValue>;
}

export interface DeletePermission {
  filter?: BooleanExpression;
}

export interface TablePermissions {
  select?: SelectPermission;
  insert?: InsertPermission;
  update?: UpdatePermission;
  delete?: DeletePermission;
}

/** Top-level: role → table → operation permissions */
export type PermissionRules = Record<string, Record<string, TablePermissions>>;
