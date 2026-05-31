// Billing module — imports auth so the file graph has a strong
// billing → auth dependency.
import { AuthService } from '../auth/AuthService';
import { Invoice, formatAmount } from './Invoice';

export class BillingService {
  private auth = new AuthService();

  chargeFor(userId: string, amountCents: number): Invoice | null {
    const ok = this.auth.login(userId, 'token');
    if (!ok) return null;
    const inv = new Invoice(userId, amountCents);
    inv.finalize();
    return inv;
  }
}

export function summariseAmount(c: number): string {
  return formatAmount(c);
}
