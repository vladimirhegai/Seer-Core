// Track G — handler side of the rendezvous. Registers /api/charge.

declare const app: any;

export function chargeHandler(req: any, res: any): unknown {
  return res.send({ charged: true });
}

app.post('/api/charge', chargeHandler);

// And a parameterised route for /users/:id
export function getUser(req: any, res: any): unknown {
  return res.send({ id: req.params.id });
}
app.get('/users/:id', getUser);
