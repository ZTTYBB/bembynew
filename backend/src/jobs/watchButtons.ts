import { Api, TelegramClient, utils } from "telegram";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import { resolvePeerTarget } from "../tg/peerTarget";
import { CONNECT_TIMEOUT_MS, withTimeout } from "../util/timeout";

/**
 * The public shape accepted by the custom action. Keeping this type local makes the
 * listener useful to callers that build a config without importing the whole job model.
 */
export type WatchButtonsConfig = {
  groupId: string;
  button: string;
  alsoWatchButtons?: string[];
  maxWaitMs?: number;
  minShare?: number;
  thankYou?: string[];
  thankAiHint?: string;
  thankDelayMinMs?: number;
  thankDelayMaxMs?: number;
  thankAsReply?: boolean;
  thankWhenContains?: string;
  forwardPrivateTo?: string;
  forwardTemplate?: string;
  forwardWaitMs?: number;
};

export type WatchButtonClick = {
  message: Api.Message;
  button: string;
  callbackAnswer?: string;
  durationMs: number;
};

export type WatchButtonsRun = {
  clicks: WatchButtonClick[];
  skipped: Array<{ message: Api.Message; reason: string }>;
  forwarded: number;
};

export type PrivateDrop = {
  message: Api.Message;
  sourcePeerId: string;
};

const numberPattern = String.raw`([0-9]{1,3}(?:[,.][0-9]{3})*(?:[.,][0-9]+)?|[0-9]+(?:[.,][0-9]+)?)`;
const MAX_RETAINED_WATCH_RESULTS = 2_000;

function retainRecent<T>(items: T[], item: T): void {
  items.push(item);
  if (items.length > MAX_RETAINED_WATCH_RESULTS) {
    items.splice(0, items.length - MAX_RETAINED_WATCH_RESULTS);
  }
}

function parseNumber(raw: string): number | null {
  const compact = raw.trim().replace(/\s/g, "");
  if (!compact) return null;
  // A comma is a thousands separator when followed by exactly three digits and
  // there is no decimal marker. Otherwise treat the final comma/dot as decimal.
  const normalized = compact.includes(",") && compact.includes(".")
    ? compact.lastIndexOf(",") > compact.lastIndexOf(".")
      ? compact.replace(/\./g, "").replace(",", ".")
      : compact.replace(/,/g, "")
    : /,\d{1,2}$/.test(compact)
      ? compact.replace(",", ".")
      : compact.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads a red-packet message's total and share count. No amount means the message
 * is not filtered: code batches and ordinary button drops should still be watched.
 */
export function parseRedPacketShare(text: string): { total: number; shares: number; perShare: number } | null {
  const source = text.replace(/\u00a0/g, " ");
  const totalMatch =
    source.match(new RegExp(`(?:总额|总积分|total|amount|积分)\\s*[:：=]?\\s*${numberPattern}`, "i")) ??
    source.match(new RegExp(`${numberPattern}\\s*(?:积分|points?)`, "i"));
  const shareMatch =
    source.match(new RegExp(`(?:共|(?<!积)分|份数|shares?|people|人数)\\s*[:：=]?\\s*([0-9]{1,6})`, "i")) ??
    source.match(/([0-9]{1,6})\s*(?:份|人|shares?|people)/i);
  if (!totalMatch || !shareMatch) return null;
  const total = parseNumber(totalMatch[1]);
  const shares = Number(shareMatch[1]);
  if (total == null || !Number.isSafeInteger(shares) || shares <= 0) return null;
  return { total, shares, perShare: total / shares };
}

/** Extracts a countdown in seconds from common Chinese and English bot text. */
export function parseButtonCountdown(text: string): number | null {
  const match = text.match(
    /(?:倒计时|剩余|再等|after|countdown|opens?\s+in|retry\s+in)[^\d]{0,12}(\d{1,6})\s*(秒|分钟?|min(?:ute)?s?|sec(?:ond)?s?|s)?/i,
  );
  if (!match) return null;
  const seconds = Number(match[1]) * (/分钟?|min(?:ute)?s?/i.test(match[2] ?? "") ? 60 : 1);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 24 * 60 * 60 ? seconds : null;
}

export function peerIdOf(peer: unknown): string | undefined {
  if (!peer) return undefined;
  try {
    return utils.getPeerId(peer as any);
  } catch {
    const value = peer as any;
    if (value.channelId != null) return String(value.channelId);
    if (value.chatId != null) return String(value.chatId);
    if (value.userId != null) return String(value.userId);
    return undefined;
  }
}

function inlineButtons(message: Api.Message | null): Array<{ text: string; data?: Buffer }> {
  const markup = (message as any)?.replyMarkup;
  if (!(markup instanceof Api.ReplyInlineMarkup)) return [];
  return markup.rows.flatMap((row: any) => row.buttons as any[]).map((button: any) => ({
    text: String(button.text ?? ""),
    data: button.data,
  }));
}

function hasInlineButtons(message: Api.Message | null | undefined): boolean {
  return inlineButtons(message ?? null).length > 0;
}

function messageDate(message: Api.Message): number {
  return Number(message.date ?? Math.floor(Date.now() / 1000)) * 1000;
}

/**
 * A long-lived listener can outlive the connection that created it. GramJS
 * leaves `autoReconnect` disabled for job clients, so make a bounded reconnect
 * attempt before a history read or callback invocation. We only act when GramJS
 * explicitly reports `connected === false`; test doubles and clients that have
 * not exposed a state yet are left alone.
 */
async function ensureConnected(
  client: TelegramClient,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error("Job cancelled");
  const state = (client as any).connected;
  if (state !== false) return;
  const reconnect = (client as any).connect;
  if (typeof reconnect !== "function") {
    throw new Error("Telegram connection is unavailable");
  }
  await withTimeout(
    Promise.resolve(reconnect.call(client)),
    CONNECT_TIMEOUT_MS,
    "Telegram reconnect timed out (watch buttons)",
    signal,
  );
  if ((client as any).connected === false) {
    throw new Error("Telegram reconnect did not restore the connection");
  }
}

/**
 * Pull a stable code out of a private reply. Bots use several labels for the
 * same masked value; when no label is present, the complete trimmed message is
 * the safest fallback because it still gives the operator something useful to
 * forward and provides a deterministic de-duplication key.
 */
export function parseForwardCode(text: string): string | null {
  const source = text.replace(/\u00a0/g, " ").trim();
  if (!source) return null;
  const token = String.raw`([A-Za-z0-9_*#xX•·-]{3,})`;
  const labelled = source.match(
    new RegExp(`(?:gift\\s+code|验证码|口令|密码|群猜码|遮码)\\s*(?:(?:is|是)\\s+|[:：=#-]\\s*)${token}`, "i"),
  ) ?? source.match(new RegExp(`\\bcode\\s*(?:[:：=#-]\\s*|(?:is|是)\\s+)${token}`, "i"));
  if (labelled?.[1]) return labelled[1].trim();
  // A plain response is retained as-is. This avoids treating an English
  // sentence's first word (for example "Your") as the de-duplication code.
  return source;
}

export function normaliseForwardCode(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function forwardFingerprint(input: {
  target: string;
  sourcePeerId: string;
  sourceMessageId?: number | null;
  code?: string | null;
}): string {
  const code = input.code ? normaliseForwardCode(input.code) : "";
  // A code identifies the drop across accounts and destinations. Including the
  // target would let two accounts post the same masked code twice when their
  // jobs point at different forwarding groups.
  if (code) return `code:${code}`;
  const target = input.target.trim().toLocaleLowerCase();
  return `drop:${target}:${input.sourcePeerId}:${input.sourceMessageId ?? "unknown"}`;
}

export function renderForwardMessage(
  template: string | undefined,
  values: { gift: string; code: string; message: string },
): string {
  const source = template?.trim() || "{message}";
  return source
    .replace(/\{gift\}/gi, values.gift)
    .replace(/\{code\}/gi, values.code)
    .replace(/\{message\}/gi, values.message)
    .trim();
}

/**
 * Wait for a fresh private reply from the bot that supplied a clicked button.
 * The source ID check is intentionally strict: a busy account must not forward
 * an unrelated DM that happened to arrive during the twenty-second window.
 */
export async function waitForPrivateDrop(
  client: TelegramClient,
  sourcePeer: unknown,
  startedAtMs: number,
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<PrivateDrop | null> {
  const sourcePeerId = peerIdOf(sourcePeer);
  if (!sourcePeerId) return null;
  const entity = await client.getInputEntity(sourcePeer as any).catch(() => null);
  if (!entity) return null;
  const budget = Math.max(100, Math.min(Number(timeoutMs) || 20_000, 120_000));
  const deadline = Date.now() + budget;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: ((value: PrivateDrop | null) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const builder = new NewMessage({});

  const matches = (message: Api.Message | undefined): message is Api.Message => {
    if (!message || message.out || !message.id) return false;
    if (peerIdOf((message as any).peerId) !== sourcePeerId) return false;
    if (peerIdOf((message as any).fromId) !== sourcePeerId) return false;
    // Telegram message dates are second-granularity; allow the current second
    // when the caller supplied a millisecond timestamp.
    return messageDate(message) >= startedAtMs - 1_500;
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    client.removeEventHandler(onMessage, builder);
    signal?.removeEventListener("abort", onAbort);
  };
  const complete = (message: Api.Message | null) => {
    cleanup();
    finish?.(message ? { message, sourcePeerId } : null);
  };
  const onAbort = () => {
    cleanup();
    fail?.(new Error("Job cancelled"));
  };
  const onMessage = async (event: NewMessageEvent) => {
    const message = event.message as Api.Message;
    if (matches(message)) complete(message);
  };

  client.addEventHandler(onMessage, builder);
  signal?.addEventListener("abort", onAbort, { once: true });
  const result = new Promise<PrivateDrop | null>((resolve, reject) => {
    finish = resolve;
    fail = reject;
    timer = setTimeout(() => complete(null), Math.max(1, deadline - Date.now()));
  });
  // AbortSignal does not dispatch an event to listeners registered after it was
  // already aborted. Handle that boundary explicitly so a cancellation that
  // races the callback setup does not wait for the full forwarding timeout.
  if (signal?.aborted) {
    onAbort();
    return result;
  }

  // The update can arrive between the button callback and handler setup, so
  // inspect a short history window as well as listening for new-message pushes.
  const recent = await client.getMessages(entity, { limit: 50 }).catch(() => [] as Api.Message[]);
  const found = (recent as Api.Message[]).filter(matches).sort((a, b) => messageDate(b) - messageDate(a))[0];
  if (found) complete(found);
  return result;
}

function chooseButton(message: Api.Message, names: string[]): { text: string; data: Buffer } | null {
  const normalized = names.map((name) => name.trim()).filter(Boolean);
  if (!normalized.length) return null;
  for (const button of inlineButtons(message)) {
    if (!(button.data instanceof Buffer)) continue;
    if (normalized.some((name) => button.text.includes(name))) return button as { text: string; data: Buffer };
  }
  return null;
}

function isEditUpdate(update: any): boolean {
  return update?.className === "UpdateEditMessage" || update?.className === "UpdateEditChannelMessage";
}

/**
 * Watch a group until the budget expires. New messages and edits are both queued, and
 * every open message is re-read periodically so a dropped Telegram update cannot make a
 * batch invisible. A single worker serialises callback clicks per account.
 */
export async function runWatchButtons(
  client: TelegramClient,
  config: WatchButtonsConfig,
  signal?: AbortSignal,
  onClick?: (click: WatchButtonClick) => Promise<void> | void,
  onSkip?: (item: { message: Api.Message; reason: string }) => Promise<void> | void,
): Promise<WatchButtonsRun> {
  await ensureConnected(client, signal);
  const group = await resolvePeerTarget(client, config.groupId.trim());
  const targetPeerId = peerIdOf(group);
  if (!targetPeerId) throw new Error("Watch buttons could not resolve the target group");
  const names = [config.button, ...(config.alsoWatchButtons ?? [])].map((x) => x.trim()).filter(Boolean);
  if (!names.length) throw new Error("Watch buttons requires at least one button");
  // Config can arrive through imported JSON/API and bypass the UI's numeric
  // validation.  Keep NaN/Infinity from turning the deadline into NaN (which
  // would make the listener exit immediately) or an unbounded wait.
  const configuredWait = config.maxWaitMs ?? 15 * 60 * 60_000;
  const budget = Number.isFinite(configuredWait)
    ? Math.max(1_000, Math.min(configuredWait, 24 * 60 * 60_000))
    : 15 * 60 * 60_000;
  const minShare = Number.isFinite(config.minShare) && (config.minShare ?? 0) > 0 ? Number(config.minShare) : 0;
  const deadline = Date.now() + budget;
  const pending = new Map<number, Api.Message>();
  const processed = new Map<number, string>();
  const openIds = new Set<number>();
  const clicks: WatchButtonClick[] = [];
  const skipped: Array<{ message: Api.Message; reason: string }> = [];
  const countdownUntilByMessage = new Map<number, number>();
  const countdownRevisionByMessage = new Map<number, string>();
  // Callbacks (thank-you/forwarding hooks) must not hold the single click worker
  // while they perform network I/O. Keep their promises so a generic caller still
  // gets completion/error semantics when the watch exits.
  const postTasks = new Set<Promise<void>>();
  const postFailures: Array<{ message: Api.Message; reason: string }> = [];
  let running = false;
  let closed = false;
  let resolveWork: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // GramJS removes handlers by matching the exact builder object. Reusing these
  // instances prevents cleanup from accidentally removing unrelated listeners
  // attached to the same Telegram client.
  const newMessageBuilder = new NewMessage({});
  const rawBuilder = new Raw({});

  const cleanup = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    client.removeEventHandler(onNewMessage, newMessageBuilder);
    client.removeEventHandler(onEdit, rawBuilder);
    signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    cleanup();
    resolveWork?.();
  };
  const queue = (message: Api.Message) => {
    if (closed || message.out || !message.id || peerIdOf((message as any).peerId) !== targetPeerId) return;
    // A watch is about callback-button messages. Keep edits for messages already seen,
    // but do not retain every ordinary chat message for fifteen hours.
    if (!hasInlineButtons(message) && !openIds.has(message.id)) return;
    pending.set(message.id, message);
    openIds.add(message.id);
    while (openIds.size > 200) {
      const oldest = openIds.values().next().value as number | undefined;
      if (oldest == null) break;
      openIds.delete(oldest);
      pending.delete(oldest);
      processed.delete(oldest);
      countdownUntilByMessage.delete(oldest);
      countdownRevisionByMessage.delete(oldest);
    }
    resolveWork?.();
  };
  const onNewMessage = async (event: NewMessageEvent) => queue(event.message as Api.Message);
  const onEdit = async (update: any) => {
    if (!isEditUpdate(update)) return;
    const message = update.message as Api.Message;
    if (message && !message.out) queue(message);
  };

  client.addEventHandler(onNewMessage, newMessageBuilder);
  client.addEventHandler(onEdit, rawBuilder);

  const processMessage = async (message: Api.Message) => {
    await ensureConnected(client, signal);
    const current = await client.getMessages(group, { ids: [message.id] })
      .then((messages) => (messages as Api.Message[])?.[0] ?? message)
      .catch(() => message);
    openIds.add(current.id);
    const button = chooseButton(current, names);
    if (!button) {
      if (!hasInlineButtons(current)) {
        openIds.delete(current.id);
        processed.delete(current.id);
        countdownUntilByMessage.delete(current.id);
        countdownRevisionByMessage.delete(current.id);
      }
      return;
    }
    const revision = `${(current as any).editDate ?? ""}|${current.message ?? ""}|${button.data.toString("base64")}`;
    const countdown = parseButtonCountdown(current.message ?? "");
    if (
      countdown != null &&
      countdownRevisionByMessage.get(current.id) !== revision
    ) {
      countdownRevisionByMessage.set(current.id, revision);
      countdownUntilByMessage.set(current.id, Math.max(
        countdownUntilByMessage.get(current.id) ?? 0,
        Date.now() + countdown * 1_000,
      ));
    }
    const share = minShare ? parseRedPacketShare(current.message ?? "") : null;
    if (processed.get(current.id) === revision) return;
    if (minShare && share && share.perShare < minShare) {
      processed.set(current.id, revision);
      const item = { message: current, reason: `Skipped: each share ${share.perShare} is below ${minShare}` };
      retainRecent(skipped, item);
      await onSkip?.(item);
      return;
    }
    if (Date.now() < (countdownUntilByMessage.get(current.id) ?? 0)) return;
    processed.set(current.id, revision);
    const start = Date.now();
    await ensureConnected(client, signal);
    const peer = await client.getInputEntity(group);
    let answer: Api.messages.BotCallbackAnswer | undefined;
    try {
      await ensureConnected(client, signal);
      answer = await client.invoke(new Api.messages.GetBotCallbackAnswer({
        peer,
        msgId: current.id,
        data: button.data,
      })) as Api.messages.BotCallbackAnswer;
    } catch (error) {
      // Marking the message as seen prevents an edit storm from repeatedly firing the
      // same callback. The error is exposed as a rejected worker item to the caller.
      throw new Error(`Button "${button.text}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const click: WatchButtonClick = {
      message: current,
      button: button.text,
      callbackAnswer: answer?.message ?? undefined,
      durationMs: Date.now() - start,
    };
    retainRecent(clicks, click);
    // Do not await a thank-you/forwarding hook here: a slow supplier or a
    // private-message wait must not stop the listener from seeing the next batch.
    // We still await tracked tasks once the watch budget ends, preserving the
    // previous API's completion semantics without serialising clicks.
    if (onClick) {
      try {
        const result = onClick(click);
        if (result && typeof (result as Promise<void>).then === "function") {
          const task = Promise.resolve(result);
          const recordFailure = (error: unknown) => {
            retainRecent(postFailures, {
              message: current,
              reason: error instanceof Error ? error.message : String(error),
            });
          };
          // A broken/slow callback must not turn a busy 15-hour listener into
          // an unbounded promise registry. Older callbacks still run, but
          // once the cap is reached only their failure is retained.
          if (postTasks.size < MAX_RETAINED_WATCH_RESULTS) {
            postTasks.add(task);
            task.catch(recordFailure).finally(() => postTasks.delete(task));
          } else {
            task.catch(recordFailure);
          }
        }
      } catch (error) {
        retainRecent(postFailures, {
          message: current,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const worker = async () => {
    if (running) return;
    running = true;
    try {
      while (!closed && !signal?.aborted && Date.now() < deadline) {
        const next = pending.values().next().value as Api.Message | undefined;
        if (next) {
          pending.delete(next.id);
          try {
            await processMessage(next);
          } catch (error) {
            // A single stale/edit race must not terminate a 15-hour watch. Report it as a
            // skipped item and continue with later messages.
            const item = { message: next, reason: error instanceof Error ? error.message : String(error) };
            retainRecent(skipped, item);
            await onSkip?.(item);
          }
          continue;
        }
        // Telegram may drop an edit update when a busy group is reconnecting. Re-read
        // every still-open message before sleeping so a newly reopened batch is seen.
        for (const id of openIds) {
          if (closed || signal?.aborted || Date.now() >= deadline) break;
          await ensureConnected(client, signal).catch((error) => {
            if (signal?.aborted) throw error;
          });
          const fresh = await client.getMessages(group, { ids: [id] })
            .then((messages) => (messages as Api.Message[])?.[0] ?? null)
            .catch(() => null);
          if (!fresh || !hasInlineButtons(fresh)) continue;
          // Do not put an unchanged message back on the queue on every poll.
          // Besides wasting API calls, that creates a tight microtask loop when
          // a mock/client returns an already-resolved getMessages promise.
          const button = chooseButton(fresh, names);
          if (!button) continue;
          if (Date.now() < (countdownUntilByMessage.get(id) ?? 0)) continue;
          const revision = `${(fresh as any).editDate ?? ""}|${fresh.message ?? ""}|${button.data.toString("base64")}`;
          if (processed.get(id) === revision) continue;
          pending.set(id, fresh);
        }
        await new Promise<void>((resolve) => {
          resolveWork = resolve;
          timer = setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now())));
        });
        resolveWork = null;
      }
    } finally {
      running = false;
    }
  };

  try {
    // Seed only recent open messages; messages older than the watch start are deliberately
    // ignored. The edit poll keeps their IDs alive for later batches without replaying them.
    await ensureConnected(client, signal);
    const recent = await client.getMessages(group, { limit: 50 }).catch(() => [] as Api.Message[]);
    const startedAt = Date.now();
    for (const message of (recent as Api.Message[]).reverse()) {
      if (messageDate(message) >= startedAt - 2_000) queue(message);
    }
    await worker();
  } finally {
    cleanup();
  }
  // Callback hooks are intentionally concurrent with the worker. Wait for the
  // bounded post-work they registered, then surface any rejected hook as a skip.
  // Cancellation wins this wait: a caller must be able to release its job slot
  // even when a third-party callback forgot to observe the same signal.
  if (signal) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      Promise.allSettled(postTasks).then(finish, finish);
      if (signal.aborted) finish();
    });
  } else {
    await Promise.allSettled([...postTasks]);
  }
  for (const failure of postFailures) {
    const item = { message: failure.message, reason: `Callback failed: ${failure.reason}` };
    retainRecent(skipped, item);
    await onSkip?.(item);
  }
  if (signal?.aborted) throw new Error("Job cancelled");
  return { clicks, skipped, forwarded: 0 };
}

