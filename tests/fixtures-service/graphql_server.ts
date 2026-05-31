// Fixture: Apollo-style resolver map. Each resolver field becomes a route
// with operation = field name.

import { db } from './_helpers';

export function userResolver(_: unknown, args: { id: string }): unknown {
  return db.users.find(args.id);
}

export function createUserResolver(_: unknown, args: { name: string }): unknown {
  return db.users.create(args.name);
}

export function onUserCreatedResolver(): AsyncIterableIterator<unknown> {
  return db.users.subscribe();
}

export const resolvers = {
  Query: {
    user: userResolver,
    users: () => db.users.list(),
  },
  Mutation: {
    createUser: createUserResolver,
    deleteUser: (_: unknown, args: { id: string }) => db.users.remove(args.id),
  },
  Subscription: {
    onUserCreated: onUserCreatedResolver,
  },
};
