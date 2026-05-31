// Gateway service — calls into billing's /api/charge and /users/:id
declare const fetch: any;

export async function processPayment(amount: number): Promise<unknown> {
  return await fetch('/api/charge', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export async function fetchUser(id: string): Promise<unknown> {
  return await fetch(`/users/${id}`, { method: 'GET' });
}
