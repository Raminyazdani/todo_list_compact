import {
  DomainError,
  type CommandName,
  type CommandOptions,
  type Principal,
} from "../../shared/contracts";
import { id } from "./core";

type Reservation = Readonly<{
  ownerId: string;
  actorId: string;
  taskId: string;
  idempotencyKey: string;
}>;
// The capability is an object identity, never a property from JSON/model input.
const reservations = new WeakMap<CommandOptions, Reservation>();

export function reserveTaskIdentity(): string {
  return id("T");
}

/** Trusted server orchestration reconstructs this from its owner-bound saved plan. */
export function withReservedTaskIdentity(
  options: CommandOptions,
  principal: Principal,
  reservedId: string,
): CommandOptions {
  if (
    principal.channel !== "AI" ||
    !principal.ownerId ||
    !principal.actorId ||
    !/^T-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      reservedId,
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Reserved task identity requires a trusted owner-bound AI plan.",
    );
  const branded = Object.freeze({ ...options });
  reservations.set(branded, {
    ownerId: principal.ownerId,
    actorId: principal.actorId,
    taskId: reservedId,
    idempotencyKey: options.idempotencyKey,
  });
  return branded;
}

export function reservedTaskIdentity(
  options: CommandOptions,
  principal: Principal,
  command: CommandName,
): string | undefined {
  const reservation = reservations.get(options);
  if (!reservation) return undefined;
  if (
    command !== "task_create" ||
    principal.channel !== "AI" ||
    principal.ownerId !== reservation.ownerId ||
    principal.actorId !== reservation.actorId ||
    options.idempotencyKey !== reservation.idempotencyKey
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "The reserved identity does not belong to this command and principal.",
      {},
      403,
    );
  return reservation.taskId;
}
