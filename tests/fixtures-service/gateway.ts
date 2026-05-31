// Track G — caller side of the rendezvous. Calls /api/charge via fetch.

declare const fetch: any;

export async function processPayment(amount: number): Promise<unknown> {
  return await fetch('/api/charge', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}
