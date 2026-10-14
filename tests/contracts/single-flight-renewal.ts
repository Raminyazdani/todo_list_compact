/** Test operators may renew an expired role once, including concurrent readers. */
export function singleFlightRenewal<T>(
  current: () => T | undefined,
  valid: (connection: T) => boolean,
  renew: (previous: T) => Promise<T>,
) {
  let pending: Promise<T> | undefined;
  let failed: { previous: T; error: unknown } | undefined;
  return async (previous: T): Promise<T> => {
    const active = current();
    if (active !== undefined && active !== previous && valid(active))
      return active;
    if (failed?.previous === previous) throw failed.error;
    if (pending) return pending;
    const request = renew(previous);
    pending = request;
    try {
      return await request;
    } catch (error) {
      failed = { previous, error };
      throw error;
    } finally {
      if (pending === request) pending = undefined;
    }
  };
}
