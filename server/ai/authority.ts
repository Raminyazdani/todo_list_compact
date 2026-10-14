import {
  DomainError,
  type CommandName,
  type Principal,
} from "@/shared/contracts";
import { requiredToolScopes } from "@/server/mcp/catalog";

export function requireAiScope(principal: Principal): void {
  if (
    !principal.scopes.includes("admin:manage") &&
    !principal.scopes.includes("ai:invoke")
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "استفاده از دستیار به مجوز جداگانهٔ صاحب حساب نیاز دارد.",
      {},
      403,
    );
}
/** Cached receipts require the same current business permission as a new write. */
export function requireAiActionScopes(
  actions: ReadonlyArray<{ command: CommandName }>,
  principal: Principal,
): void {
  if (principal.scopes.includes("admin:manage")) return;
  for (const action of actions)
    if (
      requiredToolScopes(action.command, false).some(
        (scope) => !principal.scopes.includes(scope),
      )
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "مجوز فعلی برای عملیات این پیشنهاد کافی نیست.",
        {},
        403,
      );
}
