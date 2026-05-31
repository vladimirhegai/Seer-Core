// Express server for billing. `chargeCustomer` is the single canonical
// route handler — it lives in the same file as the `app.post` call so
// the route resolver (which links handlers by same-file name lookup)
// attaches the route to it. That drives the "routeExposed" signal in
// seer_risk.
import express from 'express';
import { BillingService } from './Billing';

export const app = express();

export function chargeCustomer(req: any, res: any): void {
  const svc = new BillingService();
  const inv = svc.chargeFor(req.body.userId, req.body.amountCents);
  res.json({ ok: inv !== null });
}

app.post('/charge', chargeCustomer);
