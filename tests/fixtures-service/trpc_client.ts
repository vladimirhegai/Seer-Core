// Fixture: tRPC CLIENT CALLS. Each call goes through the trpc proxy and
// terminates in one of {query, mutate, useQuery, useMutation, subscribe}.

declare const trpc: any;
declare const api: any;
declare const someOtherObject: any;

export async function fetchUser(id: string): Promise<unknown> {
  // operation = 'user.getById' — last segment 'getById' matches userRouter.getById
  return trpc.user.getById.query({ id });
}

export async function createUserClient(name: string): Promise<unknown> {
  return trpc.user.create.mutate({ name });
}

export async function deleteUserClient(id: string): Promise<unknown> {
  return trpc.user.delete.mutate({ id });
}

// React-Query hook variants — useQuery / useMutation map to query / mutation.
export function useUser(id: string): unknown {
  return trpc.user.getById.useQuery({ id });
}

export function useCreateUser(): unknown {
  return trpc.user.create.useMutation();
}

// 'api' proxy variant — many monorepos name the root 'api'.
export function viaApi(id: string): unknown {
  return api.user.getById.query({ id });
}

// Negative case: an unrelated object that happens to have a .query method —
// must NOT be classified as a tRPC client call (root name isn't a known proxy).
export function notATrpcCall(): unknown {
  return someOtherObject.foo.bar.query({});
}
