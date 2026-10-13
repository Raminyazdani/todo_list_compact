import type {
  CommandName,
  QueryName,
  CommandOptions,
  MutationResult,
} from "./contracts";
export class LifeOsClient {
  constructor(
    private origin: string,
    private authorization?: string,
  ) {}
  async query<T>(
    operation: QueryName,
    input: Record<string, unknown> = {},
  ): Promise<T> {
    const serialized = JSON.stringify(input);
    const path = `/api/v1/query?operation=${operation}&input=${encodeURIComponent(serialized)}`;
    if (
      new URL(path, this.origin).href.length > 12000 ||
      operation === "time_entry_import_preview"
    )
      return this.request("/api/v1/query", {
        method: "POST",
        body: JSON.stringify({ operation, input }),
      });
    return this.request(path, { method: "GET" });
  }
  async execute(
    command: CommandName,
    input: Record<string, unknown>,
    options: CommandOptions,
  ): Promise<MutationResult> {
    return this.request("/api/v1/commands", {
      method: "POST",
      headers: {
        "Idempotency-Key": options.idempotencyKey,
        ...(options.expectedRevision !== undefined
          ? { "If-Match": String(options.expectedRevision) }
          : {}),
      },
      body: JSON.stringify({ command, input }),
    });
  }
  private async request<T>(path: string, options: RequestInit): Promise<T> {
    const response = await fetch(new URL(path, this.origin), {
      ...options,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(this.authorization ? { Authorization: this.authorization } : {}),
        ...options.headers,
      },
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(result.error?.message ?? "Request failed"),
        {
          code: result.error?.code,
          details: result.error?.details,
          status: response.status,
        },
      );
    return result.data;
  }
}
