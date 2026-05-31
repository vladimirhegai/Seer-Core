// Two structurally identical handlers with renamed identifiers — these
// should land in the same SimHash duplicate cluster.

export function fetchUserById(id: number): { ok: boolean; data: string | null } {
  if (id <= 0) {
    return { ok: false, data: null };
  }
  const result = lookupRecord('user', id);
  if (!result) {
    return { ok: false, data: null };
  }
  return { ok: true, data: result };
}

export function fetchOrderById(orderId: number): { ok: boolean; data: string | null } {
  if (orderId <= 0) {
    return { ok: false, data: null };
  }
  const found = lookupRecord('order', orderId);
  if (!found) {
    return { ok: false, data: null };
  }
  return { ok: true, data: found };
}

// A wholly different function — should NOT cluster with the two above.
export function sumNumbers(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total = total + v;
  }
  return total;
}

declare function lookupRecord(kind: string, id: number): string | null;
