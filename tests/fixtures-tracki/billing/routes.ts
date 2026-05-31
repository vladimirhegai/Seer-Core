// Billing service — owns POST /api/charge and GET /users/:id
declare const app: any;

export function chargeHandler(req: any, res: any): unknown {
  return res.send({ charged: true });
}
app.post('/api/charge', chargeHandler);

export function getUser(req: any, res: any): unknown {
  return res.send({ id: req.params.id });
}
app.get('/users/:id', getUser);
