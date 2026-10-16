import type { Tx } from '@ubos/database';

/**
 * Thrown inside a login transaction after failure records (lockout counter, audit) were written.
 * `authTransaction` commits the transaction first and only then rejects the request, so those records persist.
 */
export class CommitThenThrow extends Error {
  constructor(public readonly error: unknown) {
    super('commit-then-throw');
  }
}

export async function authTransaction<T>(run: (fn: (tx: Tx) => Promise<T>) => Promise<T>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let deferred: unknown;
  const result = await run(async (tx) => {
    try {
      return await fn(tx);
    } catch (e) {
      if (e instanceof CommitThenThrow) {
        deferred = e.error;
        return undefined as T;
      }
      throw e;
    }
  });
  if (deferred) throw deferred;
  return result;
}

