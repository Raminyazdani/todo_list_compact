/** Bound each canonical request, while permitting a complete self-produced backup. */
export function splitTimeImport(data: Record<string, unknown>) {
  const legacy = data.version === 1 && data.format === undefined;
  if (
    (!legacy && data.format !== "ramin-life-os-time/1") ||
    !Array.isArray(data.entries) ||
    (data.drafts !== undefined && !Array.isArray(data.drafts))
  )
    throw new Error(
      "Unsupported work-time backup / قالب پشتیبان ساعات معتبر نیست",
    );
  const items = [
    ...data.entries.map((value) => ({ key: "entries", value })),
    ...(Array.isArray(data.drafts)
      ? data.drafts.map((value) => ({ key: "drafts", value }))
      : []),
  ];
  const base = () =>
    legacy
      ? { version: 1, entries: [] as unknown[] }
      : {
          format: "ramin-life-os-time/1",
          timezone: data.timezone ?? "Europe/Berlin",
          entries: [] as unknown[],
          drafts: [] as unknown[],
        };
  const batches: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = base(),
    count = 0;
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  let size = bytes(current);
  for (const item of items) {
    const currentItems = current[item.key] as unknown[] | undefined;
    if (!currentItems)
      throw new Error(
        "Legacy drafts must remain in their original entries list.",
      );
    const cost = bytes(item.value) + 2;
    if (count >= 1000 || size + cost > 1_800_000) {
      if (!count)
        throw new Error("A single work record exceeds the request limit.");
      batches.push(current);
      current = base();
      count = 0;
      size = bytes(current);
    }
    if (size + cost > 1_800_000)
      throw new Error("A single work record exceeds the request limit.");
    (current[item.key] as unknown[]).push(item.value);
    count++;
    size += cost;
  }
  if (count || !batches.length) batches.push(current);
  return batches;
}
