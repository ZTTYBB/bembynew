/**
 * Messenger's active folder is a view preference, not Telegram data. Keep it
 * per account so switching accounts cannot make a folder from one account
 * appear selected for another.
 */
export type MessengerFolderSelection = "all" | number;

export function parseMessengerFolderSelection(value: unknown): MessengerFolderSelection {
  if (value === "all") return "all";
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return "all";
}

export function readMessengerFolder(
  storage: Pick<Storage, "getItem">,
  key: string,
  accountId: number,
): MessengerFolderSelection {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return "all";
  try {
    const raw = storage.getItem(key);
    if (!raw) return "all";
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "all";
    return parseMessengerFolderSelection((parsed as Record<string, unknown>)[String(accountId)]);
  } catch {
    return "all";
  }
}

export function writeMessengerFolder(
  storage: Pick<Storage, "getItem" | "setItem">,
  key: string,
  accountId: number,
  selection: MessengerFolderSelection,
): void {
  if (!Number.isSafeInteger(accountId) || accountId <= 0) return;
  try {
    const raw = storage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const values: Record<string, unknown> =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { ...(parsed as Record<string, unknown>) }
        : {};
    values[String(accountId)] = parseMessengerFolderSelection(selection);
    storage.setItem(key, JSON.stringify(values));
  } catch {
    // localStorage may be unavailable or full; folder selection still works
    // for the current tab when persistence is unavailable.
  }
}

/**
 * A saved folder can outlive the Telegram folder itself. Restore it only if
 * the current account still exposes that folder; otherwise use the all view.
 */
export function restoreMessengerFolder(
  saved: MessengerFolderSelection,
  availableFolderIds: ReadonlySet<number>,
): MessengerFolderSelection {
  return saved === "all" || availableFolderIds.has(saved) ? saved : "all";
}
