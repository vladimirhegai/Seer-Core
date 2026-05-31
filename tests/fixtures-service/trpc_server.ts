// Fixture: tRPC procedure DEFINITIONS (server side).
// Each procedure has a deterministic key (`getById`, `create`, `delete`) — the
// resolver matches client `trpc.user.getById.query()` against the procedure
// whose operation == 'getById'.

import { z } from 'zod';

declare const publicProcedure: any;
declare const protectedProcedure: any;
declare const router: any;

export function getUserById({ input }: any): any {
  return { id: input.id };
}

export function createUser({ input }: any): any {
  return { id: 'new', name: input.name };
}

export function deleteUser({ input }: any): any {
  return { ok: true };
}

export const userRouter = router({
  // operation = 'getById', method = QUERY
  getById: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(getUserById),

  // operation = 'create', method = MUTATION
  create: protectedProcedure
    .input(z.object({ name: z.string() }))
    .mutation(createUser),

  // operation = 'delete', method = MUTATION  (inline arrow handler)
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }: any) => deleteUser({ input })),
});
