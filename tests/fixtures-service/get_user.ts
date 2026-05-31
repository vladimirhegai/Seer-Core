// Track G — caller side that needs route_pattern match (/users/123 → /users/:id).

declare const fetch: any;

export async function loadUser(id: number): Promise<unknown> {
  return await fetch('/users/' + 123);  // not really dynamic; literal-ish
}

export async function loadUserLiteral(): Promise<unknown> {
  return await fetch('/users/123');
}
