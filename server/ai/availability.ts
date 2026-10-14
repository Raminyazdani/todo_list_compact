import { IN_APP_AI_ENABLED } from "@/shared/product-features";
import { DomainError } from "@/shared/contracts";

export function requireInAppAi() {
  if (!IN_APP_AI_ENABLED)
    throw new DomainError(
      "FEATURE_DISABLED",
      "دستیار داخل برنامه فعلاً غیرفعال است. اتصال MCP در دسترس است.",
      {},
      503,
    );
}
