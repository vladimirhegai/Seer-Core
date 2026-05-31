export function formatAmount(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export class Invoice {
  constructor(public userId: string, public amountCents: number) {}
  finalize(): void {
    if (this.amountCents <= 0) throw new Error('non-positive');
  }
}
