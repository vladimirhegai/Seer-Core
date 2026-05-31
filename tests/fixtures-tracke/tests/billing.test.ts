// Direct billing test — covers chargeFor via BillingService. The
// clusterer should keep billing tests near the billing module thanks to
// the heavy test-edge weight.
import { BillingService } from '../billing/Billing';

function testChargeForReturnsInvoice() {
  const svc = new BillingService();
  const inv = svc.chargeFor('alice', 1000);
  expect(inv).not.toBe(null);
}

function expect(_v: unknown) {
  return { toBe(_e: unknown): void { /* */ }, not: { toBe(_e: unknown): void { /* */ } } };
}
