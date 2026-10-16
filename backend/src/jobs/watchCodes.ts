import { Api, TelegramClient } from "telegram";
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import { resolvePeerTarget } from "../tg/peerTarget";
import { peerIdOf } from "./watchButtons";
import { assertSafeRegexSource } from "../util/regexSafety";

export type WatchCodesConfig = {
  /** Group/channel where codes are posted. */
  groupId: string;
  /** JavaScript regexp, optionally written as /pattern/flags. */
  regex: string;
  /** Command sent to the bot. {code} is replaced for each candidate. */
  command?: string;
  /** Optional bot override; otherwise the custom job's bot is used. */
  bot?: string;
  /** How long to keep the group listener open. Defaults to 15 hours. */
  maxWaitMs?: number;
  /** Codes older than this at listener start are ignored. Defaults to 10 minutes. */
  maxCodeAgeMs?: number;
  /** How long to wait for the bot after each command. */
  replyWaitMs?: number;
  /** Text which confirms a code. `a|b` accepts either marker. */
  successContains?: string;
  /** Text which rejects a code. `a|b` rejects on either marker. */
  failContains?: string;
};

export type WatchCodeMessage = {
  message: Api.Message;
  code: string;
};

export type WatchCodeAttempt = {
  code: string;
  sourceMessage: Api.Message;
  sent?: Api.Message;
  replies: Api.Message[];
  success: boolean;
  skipped?: boolean;
  error?: string;
};

export type WatchCodesRun = {
  attempts: WatchCodeAttempt[];
  success?: WatchCodeAttempt;
};

export type WatchCodeClaim = (
  code: string,
  source: { peerId?: string; messageId?: number | null },
) => boolean | Promise<boolean>;

const DEFAULT_WATCH_MS = 15 * 60 * 60_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_REPLY_MS = 40_000;
const MAX_WATCH_MS = 24 * 60 * 60_000;
const MAX_REPLY_MS = 10 * 60_000;
const MAX_RETAINED_ATTEMPTS = 2_000;
const MAX_SEEN_REVISIONS = 10_000;
const MAX_REPLIES_PER_ATTEMPT = 200;

function retainRecent<T>(items: T[], item: T, max: number): void {
  items.push(item);
  if (items.length > max) items.splice(0, items.length - max);
}

function parseRegexSource(pattern: string): { source: string; flags: string } {
  const value = pattern.trim();
  if (!value) throw new Error("Watch codes requires a regular expression");
  // The release UI accepts /pattern/i as a convenience. Only valid JS flags
  // are passed through; duplicate flags are rejected by RegExp itself.
  const slash = value.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  return slash
    ? { source: slash[1], flags: slash[2] }
    : { source: value, flags: "" };
}

export function compileWatchCodeRegex(pattern: string): RegExp {
  const parsed = parseRegexSource(pattern);
  if (pattern.trim().length > 500) {
    throw new Error("Watch-codes regular expression must be at most 500 characters");
  }
  assertSafeRegexSource(parsed.source, "Watch-codes regular expression");
  try {
    return new RegExp(parsed.source, parsed.flags);
  } catch (error) {
    throw new Error(`Invalid watch-codes regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Extracts capture group 1 when present, otherwise the complete match.
 * A new regexp is compiled per call so a global pattern cannot leak lastIndex
 * between incoming messages.
 */
export function extractWatchCode(pattern: string | RegExp, text: string): string | null {
  const regex = typeof pattern === "string" ? compileWatchCodeRegex(pattern) : new RegExp(pattern.source, pattern.flags);
  regex.lastIndex = 0;
  const match = regex.exec(text);
  const value = match?.[1] ?? match?.[0] ?? "";
  const code = value.trim();
  return code || null;
}

export function normaliseWatchCode(code: string): string {
  return code.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function renderWatchCodeCommand(command: string | undefined, code: string): string {
  const template = command?.trim() || "/start {code}";
  return template.replace(/\{code\}/gi, code);
}

export function messageTimeMs(message: Api.Message): number {
  return Number(message.date ?? Math.floor(Date.now() / 1000)) * 1_000;
}

function containsMarker(text: string, marker: string | undefined): boolean {
  const values = (marker ?? "").split("|").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 && values.some((value) => text.includes(value));
}

function editUpdate(update: any): boolean {
  return update?.className === "UpdateEditMessage" ||
    update?.className === "UpdateEditChannelMessage";
}

function samePeer(message: Api.Message, botPeerId: string): boolean {
  const peer = peerIdOf((message as any).peerId);
  // A bot can also post in groups/channels while we are waiting. Matching on
  // `fromId` alone would treat one of those unrelated messages as the reply to
  // our command and could accept a code early. Telegram's private bot reply is
  // in the bot's peer, so require that conversation explicitly.
  return peer === botPeerId;
}

type ReplyResult = { messages: Api.Message[]; success: boolean };

/**
 * Wait for a reply to one command. A reply that contains failContains always
 * rejects; with no success marker, the first ordinary reply is considered an
 * accepted code. This keeps the action useful for bots that only say "invalid"
 * on failure.
 */
async function waitForCodeReply(
  client: TelegramClient,
  bot: string,
  sent: Api.Message,
  maxMs: number,
  successContains: string | undefined,
  failContains: string | undefined,
  signal?: AbortSignal,
): Promise<ReplyResult> {
  const botPeerId = await client.getPeerId(bot).catch(() => peerIdOf((sent as any).peerId) ?? "");
  const sentAt = messageTimeMs(sent);
  const sentId = Number(sent.id ?? 0);
  const collected: Api.Message[] = [];
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveResult!: (value: ReplyResult) => void;
  let rejectResult!: (error: Error) => void;
  const builder = new NewMessage({});
  const rawBuilder = new Raw({});

  const cleanup = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    client.removeEventHandler(onMessage, builder);
    client.removeEventHandler(onEdit, rawBuilder);
    signal?.removeEventListener("abort", onAbort);
  };
  const finish = (success: boolean) => {
    cleanup();
    resolveResult({ messages: collected, success });
  };
  const onAbort = () => {
    cleanup();
    rejectResult(new Error("Job cancelled"));
  };
  const consider = (message: Api.Message) => {
    if (done || message.out || !message.id || !samePeer(message, botPeerId)) return;
    // Telegram dates have one-second precision, so allow a small overlap with
    // the sent message while still excluding old history.
    if (messageTimeMs(message) < sentAt - 1_500) return;
    if (Number(message.id) <= sentId && peerIdOf((message as any).peerId) === botPeerId) return;
    if (!collected.some((item) => item.id === message.id)) {
      retainRecent(collected, message, MAX_REPLIES_PER_ATTEMPT);
    }
    const text = message.message ?? "";
    if (containsMarker(text, failContains)) {
      finish(false);
    } else if (
      containsMarker(text, successContains) ||
      (!successContains && !containsMarker(text, failContains))
    ) {
      finish(true);
    }
  };
  const onMessage = async (event: NewMessageEvent) => consider(event.message as Api.Message);
  const onEdit = async (update: any) => {
    if (editUpdate(update)) consider(update.message as Api.Message);
  };

  const result = new Promise<ReplyResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
    timer = setTimeout(() => finish(false), maxMs);
  });
  client.addEventHandler(onMessage, builder);
  client.addEventHandler(onEdit, rawBuilder);
  signal?.addEventListener("abort", onAbort, { once: true });
  // An abort that happened before listener registration does not emit a second
  // event. Reject immediately rather than waiting for the reply timeout.
  if (signal?.aborted) {
    onAbort();
    return result;
  }

  // Recover a reply that arrived between sendMessage and listener setup.
  const recent = await client.getMessages(bot, { limit: 50 }).catch(() => [] as Api.Message[]);
  for (const message of (recent as Api.Message[]).reverse()) {
    consider(message);
    if (done) break;
  }
  return result;
}

/**
 * Listen for group messages, claim each new code once across all accounts, and
 * send candidates to the target bot in order until one is accepted.
 */
export async function runWatchCodes(
  client: TelegramClient,
  config: WatchCodesConfig,
  botUsername: string,
  signal: AbortSignal | undefined,
  claimCode: WatchCodeClaim,
): Promise<WatchCodesRun> {
  const groupId = config.groupId.trim();
  if (!groupId) throw new Error("Watch codes requires a source group");
  const bot = (config.bot?.trim() || botUsername.trim());
  if (!bot) throw new Error("Watch codes requires a target bot");
  if (config.command != null && config.command.length > 1_024) {
    throw new Error("Watch codes command is too long");
  }
  const regex = compileWatchCodeRegex(config.regex);
  const group = await resolvePeerTarget(client, groupId);
  const groupPeerId = peerIdOf(group);
  if (!groupPeerId) throw new Error("Watch codes could not resolve the source group");

  const watchMs = Math.max(1_000, Math.min(Number(config.maxWaitMs) || DEFAULT_WATCH_MS, MAX_WATCH_MS));
  // Treat malformed values as the documented default.  `Math.min(NaN, ...)`
  // otherwise stays NaN, and every age comparison becomes false, allowing
  // arbitrarily old messages from the initial history read through.
  const configuredMaxAge = config.maxCodeAgeMs == null
    ? DEFAULT_MAX_AGE_MS
    : Number(config.maxCodeAgeMs);
  const maxAgeMs = Number.isFinite(configuredMaxAge)
    ? Math.max(0, Math.min(configuredMaxAge, MAX_WATCH_MS))
    : DEFAULT_MAX_AGE_MS;
  const replyMs = Math.max(100, Math.min(Number(config.replyWaitMs) || DEFAULT_REPLY_MS, MAX_REPLY_MS));
  const startedAt = Date.now();
  const startedSecond = Math.floor(startedAt / 1_000) * 1_000;
  const deadline = startedAt + watchMs;
  const pending = new Map<number, Api.Message>();
  const seen = new Set<string>();
  const attempts: WatchCodeAttempt[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let success: WatchCodeAttempt | undefined;
  const newBuilder = new NewMessage({});
  const rawBuilder = new Raw({});
  // Telegram message dates have only second precision. A zero age window means
  // "start watching now", so keep a message-id watermark for history polling
  // and let actual update events through even when their rounded date is just
  // before the listener's millisecond start time.
  let historyWatermarkId = 0;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    client.removeEventHandler(onMessage, newBuilder);
    client.removeEventHandler(onEdit, rawBuilder);
    signal?.removeEventListener("abort", onAbort);
    wake?.();
  };
  const onAbort = () => cleanup();
  const queue = (message: Api.Message, source: "history" | "event" = "history") => {
    if (closed || message.out || !message.id || peerIdOf((message as any).peerId) !== groupPeerId) return;
    if (source === "event") {
      if (maxAgeMs > 0 && messageTimeMs(message) < startedAt - maxAgeMs) return;
    } else if (maxAgeMs === 0) {
      const editedAt = Number((message as any).editDate ?? 0) * 1_000;
      // History polling is only a fallback for dropped updates. With no grace
      // period, accept a newly-created id or an edit observed after startup,
      // but never replay the initial history window.
      if (Number(message.id) <= historyWatermarkId && editedAt < startedSecond) return;
    } else if (messageTimeMs(message) < startedAt - maxAgeMs) {
      return;
    }
    pending.set(Number(message.id), message);
    while (pending.size > 500) pending.delete(pending.keys().next().value as number);
    wake?.();
  };
  const onMessage = async (event: NewMessageEvent) => queue(event.message as Api.Message, "event");
  const onEdit = async (update: any) => {
    if (editUpdate(update)) queue(update.message as Api.Message, "event");
  };
  const process = async (message: Api.Message): Promise<void> => {
    const current = await client.getMessages(group, { ids: [message.id] })
      .then((messages) => (messages as Api.Message[])?.[0] ?? message)
      .catch(() => message);
    // For a zero age window the queue has already separated startup history
    // from live events using the message-id watermark. Applying the
    // millisecond/date check again here would drop same-second events because
    // Telegram timestamps are rounded to seconds.
    if (maxAgeMs > 0 && messageTimeMs(current) < startedAt - maxAgeMs) return;
    const revision = `${current.id}:${(current as any).editDate ?? ""}:${current.message ?? ""}`;
    if (seen.has(revision)) return;
    seen.add(revision);
    while (seen.size > MAX_SEEN_REVISIONS) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    const code = extractWatchCode(regex, current.message ?? "");
    if (!code) return;
    const source = { peerId: groupPeerId, messageId: Number(current.id) };
    if (!(await claimCode(code, source))) {
      retainRecent(
        attempts,
        { code, sourceMessage: current, replies: [], success: false, skipped: true },
        MAX_RETAINED_ATTEMPTS,
      );
      return;
    }
    const attempt: WatchCodeAttempt = { code, sourceMessage: current, replies: [], success: false };
    retainRecent(attempts, attempt, MAX_RETAINED_ATTEMPTS);
    try {
      const sent = await client.sendMessage(bot, {
        message: renderWatchCodeCommand(config.command, code),
      });
      attempt.sent = sent as Api.Message;
      const reply = await waitForCodeReply(
        client,
        bot,
        sent as Api.Message,
        replyMs,
        config.successContains,
        config.failContains,
        signal,
      );
      attempt.replies = reply.messages;
      attempt.success = reply.success;
      if (reply.success) success = attempt;
    } catch (error) {
      attempt.error = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) throw error;
    }
  };

  try {
    client.addEventHandler(onMessage, newBuilder);
    client.addEventHandler(onEdit, rawBuilder);
    // Include recent messages from the ten-minute grace period, but never
    // older history. Reversed order means the earliest code is tried first.
    const recent = await client.getMessages(group, { limit: 100 }).catch(() => [] as Api.Message[]);
    historyWatermarkId = (recent as Api.Message[]).reduce(
      (max, message) => Math.max(max, Number(message.id) || 0),
      0,
    );
    for (const message of (recent as Api.Message[]).reverse()) queue(message, "history");

    while (!closed && !signal?.aborted && Date.now() < deadline && !success) {
      const next = pending.values().next().value as Api.Message | undefined;
      if (next) {
        pending.delete(Number(next.id));
        await process(next);
        continue;
      }
      // Poll a bounded history window as a fallback for dropped updates and
      // edited messages. `seen` makes this inexpensive for long watches.
      const fresh = await client.getMessages(group, { limit: 50 }).catch(() => [] as Api.Message[]);
      for (const message of (fresh as Api.Message[]).reverse()) queue(message, "history");
      if (pending.size || success) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, Math.min(1_000, Math.max(1, deadline - Date.now())));
      });
      wake = null;
    }
    if (signal?.aborted) throw new Error("Job cancelled");
    return { attempts, success };
  } finally {
    cleanup();
  }
}
