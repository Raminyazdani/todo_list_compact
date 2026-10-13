import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createAuth } from "../../server/auth/config";
import { getAuthPool } from "../../server/auth/db";
import {
  admitPrivatePath,
  replacePinnedContents,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";
type Credentials = {
  email: string;
  password: string;
  origin: string;
  status?: string;
  user_id?: string;
  owner_id?: string;
  created_at: string;
  note?: string;
};
type EnrollmentServices = {
  findOwner(email: string): Promise<{ id: string } | null>;
  signup(email: string, password: string): Promise<{ id: string }>;
  signin(email: string, password: string): Promise<{ id: string }>;
};
const liveServices: EnrollmentServices = {
  async findOwner(email) {
    return (
      (
        await getAuthPool().query(
          'SELECT id FROM "user" WHERE lower(email)=lower($1)',
          [email],
        )
      ).rows[0] ?? null
    );
  },
  async signup(email, password) {
    return (
      await createAuth(true).api.signUpEmail({
        body: { email, password, name: "Ramin" },
      })
    ).user;
  },
  async signin(email, password) {
    return (
      await createAuth(false).api.signInEmail({ body: { email, password } })
    ).user;
  },
};
export async function enrollOwner(
  output: string,
  services = liveServices,
  repositoryRoot = process.cwd(),
) {
  const path = await admitPrivatePath(output, { repositoryRoot });
  const email = process.env.OWNER_EMAIL?.toLowerCase(),
    origin = process.env.BETTER_AUTH_URL,
    ownerId = process.env.OWNER_ID;
  if (!email || !origin || !ownerId)
    throw new Error("Owner enrollment configuration is incomplete.");
  let credentials: Credentials | undefined;
  try {
    credentials = await withPrivateFile(
      path,
      async (file) => JSON.parse(await file.readFile("utf8")),
      { repositoryRoot },
    );
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const existing = await services.findOwner(email);
  if (credentials) {
    if (
      credentials.email?.toLowerCase() !== email ||
      credentials.origin !== origin ||
      typeof credentials.password !== "string" ||
      credentials.password.length < 16 ||
      (credentials.owner_id && credentials.owner_id !== ownerId) ||
      ![undefined, "pending", "enrolled"].includes(credentials.status)
    )
      throw new Error(
        "Private enrollment identity does not match the configured owner.",
      );
    if (existing && credentials.user_id && existing.id !== credentials.user_id)
      throw new Error(
        "Private owner identity does not match the enrolled account.",
      );
    if (!existing && credentials.status !== "pending")
      throw new Error(
        "Existing credentials retained; use supported recovery for the missing owner.",
      );
  } else {
    if (existing)
      throw new Error(
        "Owner already exists; use supported recovery without replacing credentials.",
      );
    credentials = {
      email,
      password: randomBytes(32).toString("base64url"),
      origin,
      owner_id: ownerId,
      status: "pending",
      created_at: new Date().toISOString(),
      note: "Private initial login. Add a passkey and change the password after first login.",
    };
    await writeExclusivePrivateJson(path, credentials, { repositoryRoot });
  }
  const retained = credentials;
  if (!existing) await services.signup(email, retained.password);
  const owner = existing ?? (await services.findOwner(email));
  if (!owner)
    throw new Error(
      "Owner creation is unconfirmed; private pending credentials retained.",
    );
  const signedIn = await services.signin(email, retained.password);
  if (signedIn.id !== owner.id)
    throw new Error("Supported sign-in did not verify the configured owner.");
  if (retained.status === "pending") {
    await withPrivateFile(
      path,
      async (file) => {
        const current = JSON.parse(await file.readFile("utf8")) as Credentials;
        if (
          current.password !== retained.password ||
          current.email !== retained.email ||
          current.status !== "pending"
        )
          throw new Error(
            "Pending credentials changed; preserve for supported recovery.",
          );
        await replacePinnedContents(
          file,
          JSON.stringify(
            { ...current, status: "enrolled", user_id: owner.id },
            null,
            2,
          ) + "\n",
        );
      },
      { repositoryRoot },
    );
  }
  return {
    enrolled: true,
    recovered_pending: existing !== null && retained.status === "pending",
    credentials_retained: true,
  };
}
async function main() {
  try {
    await enrollOwner(process.argv[2]);
    console.log(
      "Owner verified; private credentials retained without exposing values.",
    );
  } finally {
    await getAuthPool().end();
  }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  main().catch(() => {
    console.error(
      "Owner enrollment stopped; private pending credentials preserved and no existing account overwritten.",
    );
    process.exitCode = 1;
  });
