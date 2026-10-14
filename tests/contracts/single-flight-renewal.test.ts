import { expect, it } from "vitest";
import { singleFlightRenewal } from "./single-flight-renewal";

it("five expired readers share one renewal and late readers reuse its connection", async () => {
  const expired = { valid: false },
    fresh = { valid: true };
  let active = expired,
    calls = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const renew = singleFlightRenewal(
    () => active,
    (value) => value.valid,
    async () => {
      calls += 1;
      await barrier;
      active = fresh;
      return fresh;
    },
  );
  const readers = Array.from({ length: 5 }, () => renew(expired));
  expect(calls).toBe(1);
  release();
  expect(await Promise.all(readers)).toEqual(Array(5).fill(fresh));
  expect(await renew(expired)).toBe(fresh);
  expect(calls).toBe(1);
});

it("an uncertain failed renewal is not automatically repeated by other expired callers", async () => {
  const expired = { valid: false };
  const failure = new Error("SYNTHETIC_UNCERTAIN_REGISTRATION");
  let calls = 0;
  const renew = singleFlightRenewal(
    () => expired,
    (value) => value.valid,
    async () => {
      calls += 1;
      throw failure;
    },
  );
  const outcomes = await Promise.allSettled(
    Array.from({ length: 5 }, () => renew(expired)),
  );
  expect(
    outcomes.every(
      (result) => result.status === "rejected" && result.reason === failure,
    ),
  ).toBe(true);
  await expect(renew(expired)).rejects.toBe(failure);
  expect(calls).toBe(1);
});

it("separate roles renew independently without widening a role's scope", async () => {
  const expiredWriter = { scope: "tasks:write", valid: false },
    expiredReader = { scope: "tasks:read", valid: false };
  let writer = expiredWriter,
    reader = expiredReader;
  const renewWriter = singleFlightRenewal(
    () => writer,
    (value) => value.valid,
    async (previous) => (writer = { ...previous, valid: true }),
  );
  const renewReader = singleFlightRenewal(
    () => reader,
    (value) => value.valid,
    async (previous) => (reader = { ...previous, valid: true }),
  );
  const results = await Promise.all([
    renewWriter(expiredWriter),
    renewReader(expiredReader),
  ]);
  expect(results.map((value) => value.scope)).toEqual([
    "tasks:write",
    "tasks:read",
  ]);
});
