import { open, readFile } from "node:fs/promises";
import { extname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type {
  FinanceImportDTO,
  FinanceImportPreviewDTO,
} from "../../shared/contracts";
import {
  canonicalFinanceJson,
  prepareFinanceSource,
  reconcileFinanceSource,
  type FinanceMarkdownMapping,
} from "../../server/integrations/finance-source";
import { boundedSignIn } from "../ops/bounded-signin.mjs";
import {
  admitPrivatePath,
  replacePinnedContents,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "../ops/private-paths.mjs";

type ObjectValue = Record<string, unknown>;
interface Credentials {
  origin: string;
  email: string;
  password: string;
  user_id: string;
  owner_id: string;
}
interface Journal {
  format: "ramin-life-os-finance-cutover/1";
  origin: string;
  owner_id: string;
  actor_id: string;
  document_hash: string;
  payload_hash: string;
  operation_key: string;
  status:
    | "preparing"
    | "conflicts"
    | "previewed"
    | "attempted"
    | "confirmed"
    | "verified"
    | "reconciliation_required";
  counts: Record<"accounts" | "categories" | "plans" | "transactions", number>;
  preview?: FinanceImportPreviewDTO;
  result?: ObjectValue;
  reconciliation?: ReturnType<typeof reconcileFinanceSource>;
}
export interface FinanceImportDependencies {
  repositoryRoot?: string;
  fetch?: typeof fetch;
  signIn?: typeof boundedSignIn;
  now?: () => number;
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("FINANCE_IMPORT_INVALID_RESPONSE");
  return value as ObjectValue;
}
async function privateText(
  path: string,
  repositoryRoot?: string,
  max = 2_000_000,
) {
  const target = await admitPrivatePath(path, {
    repositoryRoot,
    mustExist: true,
  });
  const text = await readFile(target, "utf8");
  if (Buffer.byteLength(text, "utf8") > max)
    throw new Error("FINANCE_IMPORT_PRIVATE_INPUT_TOO_LARGE");
  return text;
}
async function privateJson(
  path: string,
  repositoryRoot?: string,
  max?: number,
) {
  return JSON.parse(
    (await privateText(path, repositoryRoot, max)).replace(/^\uFEFF/, ""),
  );
}
async function exclusiveOrIdentical(
  path: string,
  value: unknown,
  repositoryRoot?: string,
  compact = false,
) {
  try {
    if (compact) {
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized, "utf8") > 2_000_000)
        throw new Error("FINANCE_IMPORT_PRIVATE_OUTPUT_TOO_LARGE");
      const target = await admitPrivatePath(path, { repositoryRoot });
      const file = await open(target, "wx", 0o600);
      try {
        await admitPrivatePath(target, { repositoryRoot, mustExist: true });
        await file.writeFile(serialized);
        await file.sync();
      } finally {
        await file.close();
      }
    } else await writeExclusivePrivateJson(path, value, { repositoryRoot });
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ))
      throw error;
    if (
      canonicalFinanceJson(await privateJson(path, repositoryRoot)) !==
      canonicalFinanceJson(value)
    )
      throw new Error("FINANCE_IMPORT_OUTPUT_EXISTS_WITH_DIFFERENT_CONTENT");
  }
}
function publicReceipt(journal: Journal) {
  return {
    status: journal.status,
    counts: journal.counts,
    can_commit: journal.preview?.can_commit ?? false,
    conflicts: journal.preview?.conflicts.length ?? 0,
    reconciliation_verified: journal.reconciliation?.verified === true,
    source_written: false,
  };
}
function origin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FINANCE_IMPORT_ORIGIN_INVALID");
  }
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("FINANCE_IMPORT_ORIGIN_INVALID");
  return value;
}
/** Reads source evidence only; a pinned external mapping is required for prose Markdown. */
async function normalize(
  args: string[],
  dependencies: FinanceImportDependencies,
) {
  const [sourcePath, outputPath, mappingPath, ...extra] = args;
  if (!sourcePath || !outputPath || extra.length)
    throw new Error("FINANCE_IMPORT_NORMALIZE_ARGUMENTS_REQUIRED");
  const repositoryRoot = dependencies.repositoryRoot;
  const sourceFile = await admitPrivatePath(sourcePath, {
    repositoryRoot,
    mustExist: true,
  });
  const outputFile = await admitPrivatePath(outputPath, { repositoryRoot });
  if (sourceFile.toLowerCase() === outputFile.toLowerCase())
    throw new Error("FINANCE_IMPORT_SOURCE_MUST_STAY_READ_ONLY");
  const extension = extname(sourceFile).toLowerCase();
  if (![".json", ".md", ".markdown"].includes(extension))
    throw new Error("FINANCE_IMPORT_SOURCE_EXTENSION_REQUIRED");
  if (extension === ".json" && mappingPath)
    throw new Error("FINANCE_IMPORT_JSON_MAPPING_NOT_APPLIED");
  const source = await privateText(sourceFile, repositoryRoot);
  const prepared = prepareFinanceSource(source, {
    kind: extension === ".json" ? "json" : "markdown",
    ...(mappingPath
      ? {
          mapping: (await privateJson(
            mappingPath,
            repositoryRoot,
          )) as FinanceMarkdownMapping,
        }
      : {}),
  });
  await exclusiveOrIdentical(outputFile, prepared.data, repositoryRoot, true);
  await exclusiveOrIdentical(
    outputFile + ".receipt.json",
    {
      format: "ramin-life-os-finance-normalization/1",
      document_hash: prepared.document_hash,
      payload_hash: prepared.payload_hash,
      mapping_hash: prepared.mapping_hash,
      counts: prepared.counts,
      used_cells: prepared.used_cells,
    },
    repositoryRoot,
  );
  return {
    status: "normalized",
    counts: prepared.counts,
    source_written: false,
  };
}
function assertPreview(value: unknown): FinanceImportPreviewDTO {
  const input = object(value);
  if (
    typeof input.preview_id !== "string" ||
    !input.preview_id ||
    input.preview_id.length > 512 ||
    typeof input.expires_at !== "string" ||
    !Number.isFinite(Date.parse(input.expires_at)) ||
    typeof input.can_commit !== "boolean" ||
    !Array.isArray(input.conflicts) ||
    typeof input.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.source_hash)
  )
    throw new Error("FINANCE_IMPORT_INVALID_PREVIEW");
  return input as unknown as FinanceImportPreviewDTO;
}

/** Explicit owner cutover. All mutations use the same authorized REST/domain service. */
export async function financeImportCli(
  args: string[],
  dependencies: FinanceImportDependencies = {},
) {
  const [mode, ...rest] = args;
  if (mode === "--normalize") return normalize(rest, dependencies);
  const [rawOrigin, credentialsPath, sourcePath, journalPath, ...extra] = rest;
  if (
    !["--preview", "--commit"].includes(mode) ||
    !rawOrigin ||
    !credentialsPath ||
    !sourcePath ||
    !journalPath ||
    extra.length
  )
    throw new Error("FINANCE_IMPORT_EXPLICIT_ARGUMENTS_REQUIRED");
  const target = origin(rawOrigin),
    repositoryRoot = dependencies.repositoryRoot;
  await admitPrivatePath(journalPath, { repositoryRoot });
  const credentials = object(
    await privateJson(credentialsPath, repositoryRoot, 65536),
  ) as unknown as Credentials;
  if (
    credentials.origin !== target ||
    !credentials.email ||
    !credentials.password ||
    !credentials.user_id ||
    !credentials.owner_id
  )
    throw new Error("FINANCE_IMPORT_OWNER_CREDENTIALS_REQUIRED");
  const source = await privateText(sourcePath, repositoryRoot);
  const prepared = prepareFinanceSource(source, { kind: "json" });
  const request = dependencies.fetch ?? fetch;
  const signedIn = await (dependencies.signIn ?? boundedSignIn)(
    target,
    credentials,
    { fetch: request },
  );
  if (!signedIn.ok) throw new Error("FINANCE_IMPORT_SIGN_IN_FAILED");
  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("FINANCE_IMPORT_SESSION_REQUIRED");
  const query = async (operation: string, input: ObjectValue = {}) => {
    let response: Response;
    try {
      response = await request(target + "/api/v1/query", {
        method: "POST",
        redirect: "error",
        headers: {
          Cookie: cookie,
          Origin: target,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ operation, input }),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error("FINANCE_IMPORT_QUERY_TRANSPORT_FAILED");
    }
    if (!response.ok)
      throw new Error("FINANCE_IMPORT_QUERY_FAILED_" + response.status);
    try {
      return object(object(await response.json()).data);
    } catch {
      throw new Error("FINANCE_IMPORT_INVALID_QUERY_RESPONSE");
    }
  };
  const identity = await query("whoami");
  if (
    (identity.actor_id ?? identity.actorId) !== credentials.user_id ||
    (identity.owner_id ?? identity.ownerId) !== credentials.owner_id
  )
    throw new Error("FINANCE_IMPORT_IDENTITY_MISMATCH");
  const intent = {
    origin: target,
    owner_id: credentials.owner_id,
    actor_id: credentials.user_id,
    document_hash: prepared.document_hash,
    payload_hash: prepared.payload_hash,
  };
  let journal: Journal;
  try {
    journal = (await privateJson(journalPath, repositoryRoot)) as Journal;
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    if (mode !== "--preview")
      throw new Error("FINANCE_IMPORT_SUCCESSFUL_PREVIEW_REQUIRED");
    journal = {
      format: "ramin-life-os-finance-cutover/1",
      ...intent,
      operation_key: randomUUID(),
      status: "preparing",
      counts: prepared.counts,
    };
    await writeExclusivePrivateJson(journalPath, journal, { repositoryRoot });
  }
  if (
    journal.format !== "ramin-life-os-finance-cutover/1" ||
    !Object.entries(intent).every(
      ([key, value]) => journal[key as keyof Journal] === value,
    ) ||
    typeof journal.operation_key !== "string" ||
    journal.operation_key.length < 8
  )
    throw new Error("FINANCE_IMPORT_RETAINED_INTENT_MISMATCH");
  return withPrivateFile(
    journalPath,
    async (file) => {
      const pinned = JSON.parse(await file.readFile("utf8")) as Journal;
      if (canonicalFinanceJson(pinned) !== canonicalFinanceJson(journal))
        throw new Error("FINANCE_IMPORT_RECEIPT_CHANGED");
      const save = () =>
        replacePinnedContents(file, JSON.stringify(journal, null, 2) + "\n");
      if (mode === "--preview") {
        if (journal.status !== "preparing") return publicReceipt(journal);
        journal.preview = assertPreview(
          await query("finance_import_preview", { data: prepared.data }),
        );
        journal.status = journal.preview.can_commit ? "previewed" : "conflicts";
        await save();
        return publicReceipt(journal);
      }
      if (
        !journal.preview?.can_commit ||
        ![
          "previewed",
          "attempted",
          "confirmed",
          "verified",
          "reconciliation_required",
        ].includes(journal.status)
      )
        throw new Error("FINANCE_IMPORT_SUCCESSFUL_PREVIEW_REQUIRED");
      if (
        journal.status === "previewed" &&
        Date.parse(journal.preview.expires_at) <=
          (dependencies.now ?? Date.now)()
      )
        throw new Error("FINANCE_IMPORT_PREVIEW_EXPIRED_NEW_REVIEW_REQUIRED");
      // The original preview/key survive a timeout. A retry never creates another intent.
      if (["previewed", "attempted"].includes(journal.status)) {
        journal.status = "attempted";
        await save();
        let response: Response;
        try {
          response = await request(target + "/api/v1/commands", {
            method: "POST",
            redirect: "error",
            headers: {
              Cookie: cookie,
              Origin: target,
              "Content-Type": "application/json",
              "Idempotency-Key": journal.operation_key,
              "If-Match": "0",
            },
            body: JSON.stringify({
              command: "finance_import_commit",
              input: { preview_id: journal.preview.preview_id },
            }),
            signal: AbortSignal.timeout(60000),
          });
        } catch {
          throw new Error("FINANCE_IMPORT_OUTCOME_UNCERTAIN_RETAIN_RECEIPT");
        }
        if (!response.ok)
          throw new Error("FINANCE_IMPORT_COMMAND_FAILED_" + response.status);
        let result: ObjectValue;
        try {
          result = object(object(await response.json()).data);
        } catch {
          throw new Error("FINANCE_IMPORT_OUTCOME_UNCERTAIN_RETAIN_RECEIPT");
        }
        if (
          typeof result.operation_id !== "string" ||
          object(result.data).source_hash !== journal.preview.source_hash
        )
          throw new Error("FINANCE_IMPORT_OUTCOME_UNCERTAIN_RETAIN_RECEIPT");
        journal.result = result;
        journal.status = "confirmed";
        await save();
      }
      const exported = (await query(
        "finance_export",
      )) as unknown as FinanceImportDTO;
      // Export can include unrelated owner records; compare this import's stable keys.
      if (
        exported.format !== "ramin-life-os/finance/1" ||
        exported.currency !== "EUR" ||
        ![
          exported.accounts,
          exported.categories,
          exported.plans,
          exported.transactions,
        ].every(Array.isArray)
      )
        throw new Error("FINANCE_IMPORT_INVALID_EXPORT");
      // A bounded export denial/incomplete envelope must never become verified zero.
      prepareFinanceSource(JSON.stringify(exported), { kind: "json" });
      journal.reconciliation = reconcileFinanceSource(prepared.data, exported);
      journal.status = journal.reconciliation.verified
        ? "verified"
        : "reconciliation_required";
      await save();
      return publicReceipt(journal);
    },
    { repositoryRoot },
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  financeImportCli(process.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error: unknown) => {
      const code =
        error instanceof Error && /^FINANCE_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "FINANCE_IMPORT_FAILED_OR_UNCERTAIN_RETAIN_RECEIPT";
      console.error(
        code + "; retain the private receipt for an identical retry",
      );
      process.exitCode = 1;
    });
}
