import { expect, it } from "vitest";
import {
  decryptBackup,
  encryptBackup,
  verifyByteChecksum,
} from "../../server/integrations/backup";
it("authenticated encryption round-trip keeps graph/checklist/source maps and rejects tampering/wrong key", async () => {
  const backup = {
    tasks: [{ id: "synthetic-one", notes: "متن فارسی" }],
    edges: [{ from: "synthetic-one", to: "synthetic-two" }],
    checklist_items: [{ checked: true }],
    source_mappings: [{ source_id: "synthetic-source" }],
  };
  const encrypted = await encryptBackup(
    backup,
    "synthetic-long-test-passphrase",
  );
  expect(JSON.stringify(encrypted)).not.toContain("synthetic-one");
  expect(
    await decryptBackup(encrypted, "synthetic-long-test-passphrase"),
  ).toEqual(backup);
  await expect(
    decryptBackup(encrypted, "synthetic-wrong-test-passphrase"),
  ).rejects.toThrow(/authentication/);
  const damaged = {
    ...encrypted,
    ciphertext: Buffer.from("wrong ciphertext").toString("base64"),
  };
  await expect(
    decryptBackup(damaged, "synthetic-long-test-passphrase"),
  ).rejects.toThrow(/authentication/);
  expect(
    verifyByteChecksum(
      Buffer.from("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    ),
  ).toBe(true);
});
