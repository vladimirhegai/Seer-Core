// Track G fixtures — HTTP client call sites in TypeScript/JavaScript.
//
// This file is consumed by tests/trackg.ts (Step 3 onward) to verify that
// the TypeScript extractor records ServiceCallDef rows for fetch/axios/etc.

declare const fetch: any;
declare const axios: any;
declare const apiClient: any;
declare const process: any;

// Simple fetch — should yield { protocol: 'http', framework: 'fetch',
// method: 'ANY', rawTarget: '/api/users', normalizedPath: '/api/users' }.
export async function listUsers(): Promise<unknown> {
  return await fetch('/api/users');
}

// fetch with explicit method via options object — method = POST.
export async function createUser(body: unknown): Promise<unknown> {
  return await fetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
}

// axios.<verb> shorthand — method derived from the verb. Caller attribution
// must be `checkout`, not module scope.
export async function checkout(): Promise<unknown> {
  return await axios.post('/checkout', { ok: true });
}

// Generic client.<method>(literalUrl) — should yield framework 'http-client'.
export function fetchOrders(): unknown {
  return apiClient.get('/api/orders');
}

// Template literal with env var — recovers /charge AND envKey PAYMENT_URL.
export async function chargeCustomer(amount: number): Promise<unknown> {
  return await fetch(`${process.env.PAYMENT_URL}/charge`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

// Dynamic URL with no literal path — should NOT be recorded.
export async function dynamicUrl(u: string): Promise<unknown> {
  return await fetch(u);
}

// Non-HTTP `.get` (e.g. cache lookup) — first arg is not a string, so dropped.
export function readCache(key: string): unknown {
  return apiClient.get(key);
}
