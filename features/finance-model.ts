/** Browser input helpers; money is stored and submitted as integer euro cents. */
export function normalizeFinanceDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u200e\u200f\u061c]/g, "")
    .trim();
}

export function parseEuroCents(
  value: string,
  options: { nullable?: boolean; signed?: boolean } = {},
): number | null {
  let text = normalizeFinanceDigits(value);
  if (!text) {
    if (options.nullable) return null;
    throw new Error("مبلغ را وارد کن. / Enter an amount.");
  }
  const negative = text.startsWith("-");
  if (text.startsWith("-") || text.startsWith("+")) text = text.slice(1);
  if (negative && !options.signed)
    throw new Error("مبلغ باید مثبت باشد. / Amount must be positive.");
  if (!/^[0-9.,٬٫]+$/.test(text))
    throw new Error("مبلغ معتبر نیست. / Invalid amount.");

  let whole: string;
  let fraction: string;
  const grouped = (part: string, separator: string) => {
    const groups = part.split(separator);
    if (
      groups.length < 2 ||
      !/^\d{1,3}$/.test(groups[0]) ||
      groups.slice(1).some((group) => !/^\d{3}$/.test(group))
    )
      throw new Error(
        "جداکنندهٔ هزارگان معتبر نیست. / Invalid digit grouping.",
      );
    return groups.join("");
  };
  if (text.includes("٫")) {
    const parts = text.split("٫");
    if (parts.length !== 2 || /[.,]/.test(text))
      throw new Error(
        "جداکنندهٔ اعشار معتبر نیست. / Invalid decimal separator.",
      );
    whole = parts[0].includes("٬") ? grouped(parts[0], "٬") : parts[0];
    fraction = parts[1];
  } else if (text.includes("٬")) {
    const parts = text.split(".");
    if (parts.length > 2 || text.includes(","))
      throw new Error(
        "جداکنندهٔ اعشار معتبر نیست. / Invalid decimal separator.",
      );
    whole = grouped(parts[0], "٬");
    fraction = parts[1] ?? "";
  } else if (text.includes(".") && text.includes(",")) {
    const decimal = text.lastIndexOf(".") > text.lastIndexOf(",") ? "." : ",";
    const grouping = decimal === "." ? "," : ".";
    const parts = text.split(decimal);
    if (parts.length !== 2)
      throw new Error(
        "جداکنندهٔ اعشار معتبر نیست. / Invalid decimal separator.",
      );
    whole = grouped(parts[0], grouping);
    fraction = parts[1];
  } else {
    const parts = text.split(/[.,]/);
    if (parts.length > 2)
      throw new Error(
        "مبلغ را بدون جداکنندهٔ هزارگان بنویس. / Omit grouping separators.",
      );
    whole = parts[0];
    fraction = parts[1] ?? "";
  }
  if (!/^\d+$/.test(whole) || !/^\d{0,2}$/.test(fraction))
    throw new Error(
      "مبلغ حداکثر دو رقم اعشار دارد. / Use at most two decimal places.",
    );
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("مبلغ بیش از حد بزرگ است. / Amount is too large.");
  return Number(negative ? -result : result);
}

export function euroInput(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (!Number.isSafeInteger(value)) throw new Error("Invalid cents value");
  const absolute = Math.abs(value);
  return `${value < 0 ? "-" : ""}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

export function financeMonth(value: string): string {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value))
    throw new Error("ماه معتبر نیست. / Invalid month.");
  return value;
}

export function shiftFinanceMonth(value: string, delta: number): string {
  financeMonth(value);
  if (!Number.isInteger(delta))
    throw new Error("Month shift must be an integer");
  const [year, month] = value.split("-").map(Number);
  const shifted = year * 12 + month - 1 + delta;
  const nextYear = Math.floor(shifted / 12);
  if (nextYear < 1 || nextYear > 9999) throw new Error("Month is out of range");
  return `${String(nextYear).padStart(4, "0")}-${String((shifted % 12) + 1).padStart(2, "0")}`;
}

export function financeToday(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Resubmit only the fields edited by the user after a revision conflict. */
export function financeEditInput(
  input: Record<string, unknown>,
  original: Record<string, unknown>,
  requiredKeys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => requiredKeys.includes(key) || value !== original[key],
    ),
  );
}
