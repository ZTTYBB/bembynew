import { TelegramClient, Api, Logger, utils } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { TgProxy } from '../types';
import type { TgDeviceParams } from '../auth/tgAuth';
import { NewMessage, NewMessageEvent, Raw } from "telegram/events";
import {
  expandCommand,
  selectButtonWithAI,
  selectMultipleButtonsWithAI,
  parseMessages,
  waitForBotMessageEdit,
  waitForNewBotMessage,
  isAiBtn,
  parseAiBtnHint,
  hasAiInput,
  parseAiInputLength,
  recognizeCaptchaWithAI,
  buildCaptchaPrompt,
  findUrlButton,
  callAI,
  ALREADY_CHECKED_IN_RE,
  htmlToText,
} from "./checkin";
import { escapeHtml } from "../tg/htmlEscape";
import {
  cfFailureFallback,
  cfNoCandidatesMessage,
  cfNoteFailure,
  cfRefusedFor,
  loadCheckinUrl,
  newCfRunState,
  type CfRunState,
  type LoadOptions,
} from "./cloudflare";
import {
  openableBotMenuApp,
  openableButtonUrl,
  openableMiniAppUrl,
  webButtonOf,
  type WebButton,
} from "../tg/miniApp";
import { resolvePeerTarget } from "../tg/peerTarget";
import { cfMaxCandidates, cfProxyCandidatesFor, rememberCfProxy } from "../tg/proxyProviders";
import { cfTuning } from "./cfTuning";
import type { CustomAction, CustomConfig, CustomStepLog } from "../types";
import { setAccountTag } from "../db/accountAttributes";
import { extractTagValue } from "./tagValue";
import { assertSafeRegexSource } from "../util/regexSafety";
import {
  ADVANCED_ACTION_TYPES,
  AutomationFinish,
  assertJson,
  assertMutableVariableName,
  automationContext,
  boundedReplyText,
  evaluateCondition,
  expandActionVariables,
  expandRuntimeCommand,
  expandVariables,
  iterationCount,
  variableValue,
  type JsonValue,
} from "./automation";
import { warehouse, warehouseId } from "../db/warehouse";
import { db } from "../db/database";
import { claimWatchButtonForward } from "../db/watchButtonForwards";
import { claimWatchCode } from "../db/watchCodeClaims";
import { templateOptionVariables } from "./templateOptions";
import { CONNECT_TIMEOUT_MS, settleQuietly, withTimeout } from "../util/timeout";
import {
  forwardFingerprint,
  parseForwardCode,
  peerIdOf,
  renderForwardMessage,
  runWatchButtons,
  waitForPrivateDrop,
} from "./watchButtons";
import {
  runWatchCodes,
} from "./watchCodes";
import {
  extractMiniAppInitData,
  miniAppLogUrl,
  runMiniAppHttp,
  type MiniAppHttpAction,
} from "./miniAppHttp";

function parseTgReturnLink(link: string): { bot?: string; startCmd: string } | null {
  try {
    let clean = link.trim();
    if (/^\/[a-zA-Z0-9_]+\?/i.test(clean)) {
      clean = "https://t.me" + clean;
    }
    let url: URL | null = null;
    try {
      if (clean.startsWith("http://") || clean.startsWith("https://")) {
        url = new URL(clean);
      } else if (clean.startsWith("tg://")) {
        url = new URL(clean.replace("tg://resolve?", "https://t.me/?").replace("tg://", "https://t.me/"));
      }
    } catch {}

    if (url) {
      const domain = url.searchParams.get("domain") || url.pathname.replace(/^\/+/, "").split("/")[0];
      const startParam = url.searchParams.get("start") || url.searchParams.get("startapp");
      const bot = domain && !domain.includes(".") ? domain : undefined;
      const startCmd = startParam ? `/start ${startParam}` : "/start";
      return { bot, startCmd };
    }

    const m1 = /^\/?start(?:=|\s+)(.*)$/i.exec(clean);
    if (m1) {
      return { startCmd: m1[1] ? `/start ${m1[1].trim()}` : "/start" };
    }
    const m2 = /^\/?([a-zA-Z0-9_]+)\?(?:start|startapp)=([^&]+)/i.exec(clean);
    if (m2) {
      return { bot: m2[1], startCmd: `/start ${m2[2]}` };
    }
    if (clean.toLowerCase().startsWith("/start")) {
      return { startCmd: clean };
    }
  } catch {}
  return null;
}

export type CustomJobLog = {
  steps: CustomStepLog[];
};

// Opens a Cloudflare-gated URL (e.g. a "我不是机器人" button/answer) in the installed
// browser to pass the "I am not a bot" check, recording the outcome on the step.
// Returns the final page's visible text for success/fail matching.
async function passCloudflare(
  url: string,
  cfChallenge: boolean | undefined,
  step: CustomStepLog,
  webProxyUrl?: string,
  miniApp = false,
  extra: Pick<LoadOptions, "inAppClicks" | "solveQuestion" | "refreshUrl"> = {},
  cfRun: CfRunState = newCfRunState(),
): Promise<string> {
  if (!cfChallenge) {
    throw new Error(
      'This click opens a Cloudflare-protected page ("I am not a bot"). Enable "Solve Cloudflare challenge" for this action.',
    );
  }
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  })();
  const refused = cfRefusedFor(cfRun, host);
  const candidates = cfProxyCandidatesFor({ primaryUrl: webProxyUrl, host, exclude: refused });
  if (!candidates.length) {
    throw new Error(cfNoCandidatesMessage(cfRun, host));
  }
  const cf = await loadCheckinUrl(url, webProxyUrl, {
    miniApp,
    ...extra,
    // A Mini App runs entirely inside the browser, so keep what it saw
    screenshot: miniApp,
    // Cloudflare refuses some exit IPs outright, so the rest of the pool stands by --
    // minus the ones this run has already had refused
    proxyCandidates: candidates,
  });
  step.cfProxy = cf.proxyLabel;
  step.cfBuild = cf.browserTier;
  step.cfAttempts = cf.attempts;
  for (const id of cf.refusedProxyIds ?? []) refused.add(id);
  if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
  if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
  step.cfHost = cf.finalHost;
  step.cfChallenged = cf.challenged;
  step.cfPassed = cf.ok;
  step.cfMiniApp = miniApp || undefined;
  step.cfMiniAppAction = cf.inAppAction;
  step.cfPageTitle = cf.pageTitle;
  step.cfNavError = cf.navError;
  step.cfTrace = cf.trace;
  step.cfScreenshot = cf.screenshot;
  if (!cf.ok)
    throw new Error(cf.reason ?? cfFailureFallback(cf.challenged, true));
  return cf.text;
}

// A URL or Mini App button opens a page instead of firing a callback; Mini App
// buttons get their signed URL from Telegram first, exactly as a real client does.
// After a callback click the checkin may still hinge on a page: a URL the bot
// answered with, or a follow-up URL / Mini App button in its replies. Returns the
// page text (empty when there is nothing to open).
async function followUpCfText(
  client: TelegramClient,
  peer: Api.TypeEntityLike,
  answer: Api.messages.BotCallbackAnswer | null,
  responses: { msg: Api.Message }[],
  step: CustomStepLog,
  webProxyUrl?: string,
  cfRun: CfRunState = newCfRunState(),
): Promise<string> {
  const answerUrl = (answer as any)?.url as string | undefined;
  if (answerUrl) return passCloudflare(answerUrl, true, step, webProxyUrl, false, {}, cfRun);

  const hit = responses.map((r) => ({ msg: r.msg, web: findUrlButton(r.msg) })).find((h) => h.web);
  if (!hit?.web) return '';
  return (await openWebButton(client, hit.web, peer, hit.msg, true, step, webProxyUrl, cfRun)).text;
}

type WebButtonOutcome = {
  /** Text of the page that was opened, empty when nothing was loaded. */
  text: string;
  /** Set when a `?start=` deep link was followed, so the caller can re-anchor. */
  deepLinkSent?: { botUsername: string; msg: Api.Message };
};

async function openWebButton(
  client: TelegramClient,
  web: WebButton,
  peer: Api.TypeEntityLike,
  msg: Api.Message | null,
  cfChallenge: boolean | undefined,
  step: CustomStepLog,
  webProxyUrl?: string,
  cfRun: CfRunState = newCfRunState(),
): Promise<WebButtonOutcome> {
  // A `?start=` deep link is followed the way a real client does -- by sending the
  // command to that bot -- not by loading a page. Group bots use these to move a
  // verification into a private chat.
  if (web.startLink) {
    const { botUsername, startParam } = web.startLink;
    const sent = await client.sendMessage(botUsername, { message: `/start ${startParam}` });
    step.result = `Followed deep link: /start ${startParam} to @${botUsername}`;
    return { text: "", deepLinkSent: { botUsername, msg: sent } };
  }

  const { url, signed } = await openableButtonUrl(client, web, peer, msg ?? undefined);
  step.cfMiniAppSigned = web.miniApp ? signed : undefined;
  if (web.miniApp && !signed) {
    throw new Error(
      `Telegram would not sign the Mini App behind "${web.text}"; the app cannot be opened logged in`,
    );
  }
  return {
    text: await passCloudflare(url, cfChallenge, step, webProxyUrl, web.miniApp, {}, cfRun),
  };
}

export class CustomJobError extends Error {
  constructor(
    message: string,
    public readonly log: CustomJobLog,
  ) {
    super(message);
    this.name = "CustomJobError";
  }
}

// Marker of the last message we sent: anything the bot delivered after this point
// (higher id, or an edit stamped after our send) is a candidate reply. Anchoring on the
// sent message's server-side id/date avoids local clock skew.
type SendAnchor = {
  msgId: number;
  dateSec: number;
  isGroup: boolean;
  peerId?: string;
};

async function forwardPrivateDrop(
  client: TelegramClient,
  target: string,
  template: string | undefined,
  waitMs: number,
  sinceMs: number,
  sourcePeer: unknown,
  gift: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const sourcePeerId = peerIdOf(sourcePeer);
  if (!sourcePeerId) return false;
  const drop = await waitForPrivateDrop(client, sourcePeer, sinceMs, waitMs, signal);
  if (!drop) return false;
  const text = String(drop.message.message ?? "").trim();
  const code = parseForwardCode(text);
  if (!code) return false;
  const destination = await resolvePeerTarget(client, target);
  const fingerprint = forwardFingerprint({
    target,
    sourcePeerId: drop.sourcePeerId,
    sourceMessageId: drop.message.id,
    code,
  });
  // Claim before sending to make cross-account execution atomic. A failed send
  // intentionally consumes the claim rather than risking duplicate delivery on
  // an uncertain Telegram retry.
  if (!claimWatchButtonForward(db, {
    fingerprint,
    code,
    sourcePeerId: drop.sourcePeerId,
    sourceMessageId: drop.message.id,
    target,
  })) return true;
  const body = renderForwardMessage(template, {
    gift: gift.trim() || code,
    code,
    message: text,
  });
  await client.sendMessage(destination, { message: body });
  return true;
}

const hasInlineButtons = (m: Api.Message | null | undefined): boolean =>
  !!m && (m as any).replyMarkup instanceof Api.ReplyInlineMarkup;

const isGroupPeer = (peer: any): boolean =>
  peer instanceof Api.PeerChannel ||
  peer instanceof Api.PeerChat ||
  peer?.className === "PeerChannel" ||
  peer?.className === "PeerChat";

const peerKey = (peer: any): string | undefined => {
  if (!peer) return undefined;
  try {
    return utils.getPeerId(peer);
  } catch {
    if (peer.channelId != null) return String(peer.channelId);
    if (peer.chatId != null) return String(peer.chatId);
    if (peer.userId != null) return String(peer.userId);
    return undefined;
  }
};

const anchorFromSent = (sent: Api.Message): SendAnchor => ({
  msgId: sent.id,
  dateSec: sent.date ?? Math.floor(Date.now() / 1000),
  isGroup: isGroupPeer((sent as any).peerId),
  peerId: peerKey((sent as any).peerId),
});

const isEditUpdate = (update: any): boolean =>
  update?.className === "UpdateEditMessage" ||
  update?.className === "UpdateEditChannelMessage";

// Lowest message id an action will accept for a given scope. scope 0 (default)
// admits only messages newer than the anchor -- the reply to what we just sent,
// which stops a stale menu from an earlier turn being clicked. scope -N also
// admits the N most recent incoming messages that predate the anchor, for bots
// whose live menu sits on an earlier message. anchorId 0 (nothing sent yet)
// falls back to accepting everything.
async function resolveScopeFloor(
  client: TelegramClient,
  target: Api.TypeEntityLike,
  anchorId: number,
  scope?: number,
): Promise<number> {
  const freshFloor = anchorId + 1;
  if (!scope || scope >= 0) return freshFloor;
  const n = -scope;
  const recent = (await client
    .getMessages(target, { limit: n + 20 })
    .catch(() => [])) as Api.Message[];
  const prior = recent
    .filter((m) => m && !m.out && m.id <= anchorId)
    .map((m) => m.id)
    .sort((a, b) => b - a); // newest first
  if (!prior.length) return freshFloor;
  return prior[Math.min(n, prior.length) - 1];
}

// Authoritative membership check: GetParticipant throws USER_NOT_PARTICIPANT for pending
// join requests, unlike the Channel.left flag which can lag behind actual state.
async function isChannelMember(client: TelegramClient, channel: Api.Channel): Promise<boolean> {
  try {
    const result = await client.invoke(
      new Api.channels.GetParticipant({ channel, participant: "me" }),
    );
    return !(result.participant instanceof Api.ChannelParticipantLeft);
  } catch (err: any) {
    if (err?.message?.includes("USER_NOT_PARTICIPANT")) return false;
    throw err;
  }
}

const notMemberError = (err: unknown): boolean =>
  /USER_NOT_PARTICIPANT|USER_NOT_MUTUAL_CONTACT|CHANNEL_INVALID|CHAT_ID_INVALID/i.test(
    String((err as any)?.message ?? err),
  );

/**
 * Leaves an already-resolved group/channel. Telegram has two different leave
 * requests for modern channels/supergroups and legacy basic groups.
 */
async function leaveResolvedChat(
  client: TelegramClient,
  entity: Api.TypeEntityLike,
): Promise<boolean> {
  try {
    if (entity instanceof Api.Channel) {
      await client.invoke(new Api.channels.LeaveChannel({ channel: entity }));
      return true;
    }
    if (entity instanceof Api.Chat) {
      await client.invoke(
        new Api.messages.DeleteChatUser({
          chatId: (entity as any).id,
          userId: new Api.InputUserSelf(),
        }),
      );
      return true;
    }
    throw new Error("Only groups and channels can be left");
  } catch (err) {
    if (notMemberError(err)) return false;
    throw err;
  }
}

/**
 * Resolve a public/invite/message link and leave it. A private invite that
 * only previews a chat, or an expired/unresolvable link, is already "not a
 * member" for an idempotent leave action.
 */
export async function leaveChatTarget(
  client: TelegramClient,
  raw: string,
): Promise<boolean> {
  const inviteMatch = raw.match(
    /(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i,
  );
  if (inviteMatch) {
    try {
      const check = await client.invoke(
        new Api.messages.CheckChatInvite({ hash: inviteMatch[1] }),
      );
      if (check instanceof Api.ChatInvitePeek) return false;
      const entity = (check as any)?.chat as Api.TypeEntityLike | undefined;
      return entity ? leaveResolvedChat(client, entity) : false;
    } catch (err) {
      if (notMemberError(err) || /INVITE_HASH|INVITE_SLUG/i.test(String((err as any)?.message ?? err))) return false;
      throw err;
    }
  }

  // save_message_link stores channel posts as https://t.me/c/<id>/<message>.
  // Resolve the compact c<ID> form so those links can be fed directly here.
  const messageLink = raw.match(
    /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)?/i,
  );
  const target = messageLink ? `c${messageLink[1]}` : raw;
  try {
    const entity = await resolvePeerTarget(client, target);
    return await leaveResolvedChat(client, entity);
  } catch (err) {
    if (notMemberError(err) || /not joined|not a member|no chat with id/i.test(String((err as any)?.message ?? err))) {
      return false;
    }
    throw err;
  }
}

// Waits for a message carrying inline buttons in a specific chat (e.g. the group we just
// joined). Buttons can arrive on a brand-new message OR via an in-place edit of an
// existing message, so both update paths are watched.
async function waitForButtonsInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
  sinceSec = 0,
): Promise<Api.Message[]> {
  const chatPeerId = await client.getPeerId(chat);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];

    const cleanup = () => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      cleanup();
      if (!collected.includes(msg)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No message with buttons received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      // Match the chat by id here rather than through NewMessage({ chats }): that filter
      // stringifies an entity object to "[object Object]" and then throws an unhandled
      // rejection while resolving it on the next update -- immediate in a busy group.
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== chatPeerId) return;
      if (
        sinceSec &&
        Math.max(msg.editDate ?? 0, msg.date ?? 0) < sinceSec
      )
        return;
      collected.push(msg);
      if (hasInlineButtons(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== chatPeerId) return;
      if (
        sinceSec &&
        Math.max(msg.editDate ?? 0, msg.date ?? 0) < sinceSec
      )
        return;
      if (hasInlineButtons(msg)) succeed(msg);
    };

    client.addEventHandler(handler, new NewMessage({}));
    client.addEventHandler(editHandler, new Raw({}));
  });
}

// Waits for the next new message arriving in a specific chat. Never rejects -- resolves null
// on timeout or abort.
async function waitForNewMessageInChat(
  client: TelegramClient,
  chat: Api.TypeEntityLike,
  maxMs: number,
  signal?: AbortSignal,
): Promise<Api.Message | null> {
  // Resolve the chat id up front and match it manually. Passing an entity object into
  // NewMessage({ chats }) breaks GramJS -- its constructor stringifies each filter entry
  // to "[object Object]", then throws an unhandled rejection resolving it on the next update.
  const targetId = await client.getPeerId(chat).catch(() => null);
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const finish = (msg: Api.Message | null) => {
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      signal?.removeEventListener("abort", onAbort);
      resolve(msg);
    };
    const timer = setTimeout(() => finish(null), maxMs);
    const onAbort = () => finish(null);
    signal?.addEventListener("abort", onAbort, { once: true });
    const handler = async (event: NewMessageEvent) => {
      if (
        targetId != null &&
        event.message?.chatId?.toString() !== targetId.toString()
      )
        return;
      finish(event.message as Api.Message);
    };
    client.addEventHandler(handler, new NewMessage({}));
  });
}

export type VerificationChannelLink =
  | { kind: "invite"; hash: string }
  | { kind: "public"; username: string };

/**
 * Reads channel-looking Telegram links from a verification prompt. Telegram often
 * stores a visible link as a MessageEntityTextUrl, so looking only at the message
 * string misses the channel the bot is asking the user to join.
 */
export function extractVerificationChannelLinks(
  message: Api.Message | null | undefined,
): VerificationChannelLink[] {
  if (!message) return [];
  const text = message.message ?? "";
  const sources: string[] = [text];
  for (const entity of ((message as any).entities ?? []) as any[]) {
    const className = entity?.className;
    if (
      entity instanceof Api.MessageEntityTextUrl ||
      className === "MessageEntityTextUrl"
    ) {
      if (typeof entity.url === "string") sources.push(entity.url);
    } else if (
      entity instanceof Api.MessageEntityUrl ||
      className === "MessageEntityUrl"
    ) {
      const start = Number(entity.offset);
      const end = start + Number(entity.length);
      if (Number.isSafeInteger(start) && Number.isSafeInteger(end)) {
        sources.push(text.slice(start, end));
      }
    }
  }
  const markup = (message as any).replyMarkup;
  if (markup instanceof Api.ReplyInlineMarkup) {
    for (const row of markup.rows) {
      for (const button of row.buttons as any[]) {
        if (typeof button?.url === "string") sources.push(button.url);
      }
    }
  }

  const links: VerificationChannelLink[] = [];
  const seen = new Set<string>();
  const add = (link: VerificationChannelLink) => {
    const key = link.kind === "invite" ? `i:${link.hash}` : `u:${link.username.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };

  for (const source of sources) {
    // Invite links can also appear in the tg:// form when the visible text is
    // "加入频道". They carry no username and must be imported by hash.
    for (const match of source.matchAll(/tg:\/\/join\?invite=([A-Za-z0-9_-]+)/gi)) {
      add({ kind: "invite", hash: match[1] });
    }

    for (const match of source.matchAll(
      /(?:^|[^\w])((?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/[^\s<>"'`)\]}]+)/gi,
    )) {
      const value = match[1].replace(/[.,!?;:]+$/, "").replace(/\/+$/, "");
      const path = value
        .replace(/^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\//i, "")
        .split(/[?#]/, 1)[0];
      const parts = path.split("/").filter(Boolean);
      if (!parts.length) continue;
      if (parts[0].startsWith("+")) {
        add({ kind: "invite", hash: parts[0].slice(1) });
      } else if (
        parts[0].toLowerCase() === "joinchat" &&
        parts[1] &&
        /^[A-Za-z0-9_-]+$/.test(parts[1])
      ) {
        add({ kind: "invite", hash: parts[1] });
      } else if (
        parts.length === 1 &&
        /^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(parts[0]) &&
        !/^(?:addlist|joinchat|share|iv|s)$/i.test(parts[0])
      ) {
        // /c/<id>/<message> and other multi-segment Telegram URLs are
        // message links, not a channel to subscribe to.
        add({ kind: "public", username: parts[0] });
      }
    }
  }
  return links;
}

async function joinVerificationChannelLinks(
  client: TelegramClient,
  links: VerificationChannelLink[],
  signal?: AbortSignal,
): Promise<number> {
  let joined = 0;
  for (const link of links) {
    if (signal?.aborted) throw new Error("Job cancelled");
    try {
      if (link.kind === "invite") {
        await client.invoke(new Api.messages.ImportChatInvite({ hash: link.hash }));
      } else {
        const entity = await resolvePeerTarget(client, link.username);
        // A t.me username can point at a user or basic group. Only channel
        // entities are valid here; those links are ignored rather than trying
        // to send a JoinChannel request with the wrong peer type.
        if (!(entity instanceof Api.Channel)) continue;
        await client.invoke(new Api.channels.JoinChannel({ channel: entity }));
      }
      joined++;
    } catch (err: any) {
      const messageText = String(err?.message ?? err);
      if (/ALREADY_PARTICIPANT|USER_ALREADY_PARTICIPANT/i.test(messageText)) {
        joined++;
        continue;
      }
      if (/INVITE_REQUEST_SENT/i.test(messageText)) {
        throw new Error("Verification channel join request is pending approval");
      }
      throw err;
    }
  }
  return joined;
}

export function isReplyToMessage(message: Api.Message, anchorId: number): boolean {
  if (!anchorId) return true;
  const reply = (message as any).replyTo;
  return Number(reply?.replyToMsgId ?? (message as any).replyToMsgId) === anchorId;
}

// Some groups post an in-group verification message with a button that must be clicked to
// gain real access after joining. Best-effort: waits for that message, clicks the button whose
// text contains buttonMatch (or the sole button), and appends the outcome to step.result.
async function clickGroupVerification(
  client: TelegramClient,
  chat: Api.Channel,
  buttonMatch: string,
  maxMs: number,
  step: CustomStepLog,
  signal?: AbortSignal,
  sinceSec?: number,
): Promise<void> {
  const verificationDeadline = Date.now() + Math.max(0, maxMs);
  const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
    [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;

  // Waiter catches prompts that arrive (or get edited in) from now on; the scan catches a
  // prompt that landed in the gap before the listener attached. Whichever finds one first wins.
  const waitAbort = new AbortController();
  const forwardAbort = () => waitAbort.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  const waiterPromise = waitForButtonsInChat(
    client,
    chat,
    maxMs,
    waitAbort.signal,
    0,
    sinceSec ?? 0,
  )
    .then(findButtonsMsg)
    .catch(() => null);

  const earlyScan = client
    .getMessages(chat, { limit: 10 })
    .then(
      (recent) =>
        (recent as Api.Message[]).find(
          (m) =>
            m &&
            !m.out &&
            hasInlineButtons(m) &&
            (!sinceSec || Math.max(m.editDate ?? 0, m.date ?? 0) >= sinceSec),
        ) ?? null,
    )
    .catch(() => null);

  let buttonsMsg = await Promise.race([
    waiterPromise,
    earlyScan.then((m) => m ?? waiterPromise),
  ]);
  waitAbort.abort();
  signal?.removeEventListener("abort", forwardAbort);
  if (signal?.aborted) throw new Error("Job cancelled");

  // Last resort: scan history once more, but retain the join-time boundary
  // when this verification was triggered by a fresh join.
  if (!buttonsMsg) {
    const recent = (await client.getMessages(chat, { limit: 10 })) as Api.Message[];
    buttonsMsg = findButtonsMsg(
      recent.filter(
        (message) =>
          !sinceSec ||
          Math.max(message.editDate ?? 0, message.date ?? 0) >= sinceSec,
      ),
    );
  }

  if (!buttonsMsg) {
    step.result = `${step.result} (no verification prompt)`;
    return;
  }

  const match = buttonMatch.trim();
  // Keep the original verifyWaitMs as the total budget. If the prompt arrived
  // quickly, use the remaining time for a bot that edits a decoy button later;
  // if it arrived near the deadline, do not extend the action indefinitely.
  const refreshDeadline = verificationDeadline;
  const seenChannelLinks = new Map<string, VerificationChannelLink>();
  const rememberChannelLinks = (message: Api.Message) => {
    for (const link of extractVerificationChannelLinks(message)) {
      const key = link.kind === "invite"
        ? `i:${link.hash}`
        : `u:${link.username.toLowerCase()}`;
      seenChannelLinks.set(key, link);
    }
  };
  const findTarget = (message: Api.Message | null): any | undefined => {
    if (!hasInlineButtons(message)) return undefined;
    const rows = ((message as any).replyMarkup as Api.ReplyInlineMarkup).rows;
    const flat = rows.flatMap((r) => r.buttons);
    const found = match
      ? flat.find((b: any) => ((b.text as string) ?? "").includes(match))
      : undefined;
    // A named target must really match. Falling back to a sole button in that
    // case would press a decoy while a bot is waiting to edit it into the
    // requested verification control. With no target text, preserve the
    // convenient single-button behavior.
    return found ?? (!match && flat.length === 1 ? flat[0] : undefined);
  };

  let target = findTarget(buttonsMsg);
  rememberChannelLinks(buttonsMsg);
  // Some verification bots first show a decoy button, then edit this same
  // message a few seconds later. Re-fetch the message before deciding, and
  // keep polling for a bounded period so an edit can replace the decoy.
  while (!target && match && Date.now() < refreshDeadline) {
    const waitMs = Math.min(750, Math.max(0, refreshDeadline - Date.now()));
    if (waitMs > 0) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new Error("Job cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, waitMs);
      });
    }
    if (signal?.aborted) throw new Error("Job cancelled");
    const messageId: number = buttonsMsg!.id;
    const fresh: Api.Message | null = await client
      .getMessages(chat, { ids: [messageId] })
      .then((messages) => (messages as Api.Message[])?.[0] ?? null)
      .catch(() => null);
    if (fresh) {
      buttonsMsg = fresh;
      rememberChannelLinks(fresh);
      target = findTarget(fresh);
    }
  }

  if (seenChannelLinks.size) {
    const joined = await joinVerificationChannelLinks(
      client,
      [...seenChannelLinks.values()],
      signal,
    );
    if (joined) step.result = `${step.result} + joined verification channel(s)`;
  }

  if (!target) {
    step.result = `${step.result} (verification button not found)`;
    return;
  }

  const data = (target as Api.KeyboardButtonCallback).data;
  if (!data) {
    step.result = `${step.result} (verification button not clickable)`;
    return;
  }

  const peer = await client.getInputEntity(chat);
  step.clickedButton = (target as any).text as string;
  try {
    const answer = (await client.invoke(
      new Api.messages.GetBotCallbackAnswer({ peer, msgId: buttonsMsg!.id, data }),
    )) as Api.messages.BotCallbackAnswer;
    if (answer.message) step.callbackAnswer = answer.message;
    step.result = `${step.result} + verified`;
  } catch (err: any) {
    // The callback reached the bot but it never answered -- common for verification bots
    // that process the click without calling answerCallbackQuery. The click was delivered,
    // so treat the verification as done rather than failing the whole join.
    if (err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
      step.result = `${step.result} + verify clicked (no bot confirmation)`;
    } else {
      throw err;
    }
  }
}

// Collects messages from the target until one has buttons or timeout fires.
// When successContains/failContains are set, checks message text to resolve or reject early.
// Watches new messages AND in-place edits; when sinceAnchor is given, also scans recent
// history so a reply that landed before the listener attached is not lost.
async function waitForReply(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  successContains?: string,
  failContains?: string,
  signal?: AbortSignal,
  minId = 0,
  replyToId = 0,
  replyPeerId?: string,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    const useTextMatch = !!(successContains || failContains);
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const timer = setTimeout(() => {
      cleanup();
      if (useTextMatch) {
        reject(new Error(`Expected reply not received within ${maxMs}ms`));
      } else if (collected.length > 0) {
        resolve(collected);
      } else {
        reject(new Error(`No reply received within ${maxMs}ms`));
      }
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // Replace an earlier copy on edit, otherwise append
    const upsert = (msg: Api.Message) => {
      const i = collected.findIndex((c) => c.id === msg.id);
      if (i >= 0) collected[i] = msg;
      else collected.push(msg);
    };

    const consider = (msg: Api.Message) => {
      if (done) return;
      if (replyToId && !isReplyToMessage(msg, replyToId)) return;
      if (
        replyPeerId &&
        (!msg.peerId || peerKey(msg.peerId) !== replyPeerId)
      )
        return;
      upsert(msg);
      const text = msg.message ?? "";

      if (failContains && text.includes(failContains)) {
        cleanup();
        reject(
          new Error(`Reply indicates failure: "${failContains}" detected`),
        );
        return;
      }

      if (successContains) {
        if (text.includes(successContains)) {
          cleanup();
          resolve(collected);
        }
        // Keep waiting for a message that matches the success text
        return;
      }

      // failContains only (no successContains) -- any non-fail message is a success
      if (failContains) {
        cleanup();
        resolve(collected);
        return;
      }

      // No text matching -- original behaviour: resolve immediately on buttons, else rely on timeout
      if (hasInlineButtons(msg)) {
        cleanup();
        resolve(collected);
      }
    };

    const handler = async (event: NewMessageEvent) =>
      consider(event.message as Api.Message);

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      consider(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: pick up replies delivered in the send-to-listen gap
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const missed = (recent as Api.Message[])
            .filter(
              (m) =>
                m &&
                !m.out &&
                m.id >= minId &&
                (!replyToId || isReplyToMessage(m, replyToId)) &&
                (!replyPeerId ||
                  (m.peerId && peerKey(m.peerId) === replyPeerId)) &&
                !collected.some((c) => c.id === m.id),
            )
            .reverse(); // process oldest first
          for (const m of missed) consider(m);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

// Waits specifically for a message with inline buttons from the target. Buttons may show
// up on a brand-new message OR via an in-place edit of an earlier one; when sinceAnchor is
// given, recent history is also scanned to cover the gap before the listeners attached.
// excludeId skips one known message (e.g. the one whose buttons we already tried).
async function waitForButtonsMessage(
  client: TelegramClient,
  fromUsername: string,
  maxMs: number,
  signal?: AbortSignal,
  minId = 0,
  excludeId?: number,
): Promise<Api.Message[]> {
  const botPeerId = await client.getPeerId(fromUsername);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }

    const collected: Api.Message[] = [];
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      client.removeEventHandler(handler, new NewMessage({}));
      client.removeEventHandler(editHandler, new Raw({}));
      signal?.removeEventListener("abort", onAbort);
    };

    const succeed = (msg: Api.Message) => {
      if (done) return;
      cleanup();
      if (!collected.some((c) => c.id === msg.id)) collected.push(msg);
      resolve(collected);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`No message with buttons received within ${maxMs}ms`));
    }, maxMs);

    const onAbort = () => {
      cleanup();
      reject(new Error("Job cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const handler = async (event: NewMessageEvent) => {
      const msg = event.message as Api.Message;
      collected.push(msg);
      if (hasInlineButtons(msg)) succeed(msg);
    };

    const editHandler = async (update: any) => {
      if (!isEditUpdate(update)) return;
      const msg = update.message as Api.Message;
      if (!msg || msg.out) return;
      if (msg.id < minId) return; // out of scope (edit of a pre-anchor message)
      if (!msg.peerId || utils.getPeerId(msg.peerId) !== botPeerId) return;
      if (hasInlineButtons(msg)) succeed(msg);
    };

    client.addEventHandler(
      handler,
      new NewMessage({ fromUsers: [fromUsername] }),
    );
    client.addEventHandler(editHandler, new Raw({}));

    // Best-effort: a buttons message may have landed in the send-to-listen gap.
    // getMessages returns newest-first, so this seeds the most recent in-scope
    // match ("last available button").
    if (minId > 1) {
      client
        .getMessages(fromUsername, { limit: 10 })
        .then((recent) => {
          const seed = (recent as Api.Message[]).find(
            (m) =>
              m &&
              !m.out &&
              m.id !== excludeId &&
              m.id >= minId &&
              hasInlineButtons(m),
          );
          if (seed) succeed(seed);
        })
        .catch(() => {
          /* history scan is best-effort */
        });
    }
  });
}

/**
 * The first step that cannot run without a target bot, or null when the job is fine as it
 * stands. A custom job need not target one: its steps can each name their own contact, or
 * drive a page that never touches Telegram. Checked up front rather than failing later on a
 * peer that cannot be resolved from "".
 *
 * `open_mini_app_url` is deliberately not on the list. It is handed a full address, and one
 * is openable without a bot to sign it -- a `t.me/<bot>/<app>` link names its own bot, an
 * https one may already carry its account data, and an app that signs its own users in
 * needs neither. Naming no bot is the operator saying so; the step opens the address on
 * this account's browser and exit, and says in the log that it went unsigned.
 */
export function stepNeedingBot(
  actions: CustomAction[],
  botUsername: string,
): { at: number; type: CustomAction["type"] } | null {
  if (botUsername.trim()) return null;
  const at = actions.findIndex((a) => {
    switch (a.type) {
      case "if_check":
        return Boolean(stepNeedingBot(a.thenActions ?? [], botUsername) || stepNeedingBot(a.elseActions ?? [], botUsername));
      case "repeat":
      case "for_each":
        return Boolean(stepNeedingBot(a.actions ?? [], botUsername));
      case "set_variables":
      case "finish":
      case "save_message_link":
      case "save_data":
        return false;
      // Both need to know whose: one hunts a button in a conversation, the other asks a
      // bot what it pins beside the composer. Neither has anything to work from otherwise.
      case "open_mini_app":
      case "open_bot_menu_app":
        return !a.contact?.trim();
      case "open_mini_app_url":
      case "send_contact_message":
      case "join_group":
      case "subscribe_channel":
      case "watch_buttons":
      case "mini_app_http":
        return false;
      case "watch_codes":
        return !a.bot?.trim();
      case "leave_group":
      case "unsubscribe_channel":
      case "open_url":
      case "delay":
      case "save_tag":
        return false;
      default:
        return true;
    }
  });
  return at >= 0 ? { at, type: actions[at].type } : null;
}

export async function runCustom(
  apiId: number,
  apiHash: string,
  sessionString: string,
  botUsername: string,
  config: CustomConfig,
  signal?: AbortSignal,
  proxy?: TgProxy,
  deviceParams?: TgDeviceParams,
  webProxyUrl?: string,
  // Shared with the runner's outer retries, so an exit refused on an earlier attempt of
  // this run is not offered again and an action's browser budget spans its retries
  cfRun: CfRunState = newCfRunState(),
  accountId?: number,
  accountName?: string,
  accountPhone?: string,
): Promise<CustomJobLog> {
  const log: CustomJobLog = { steps: [] };
  const jobMaxRetries = config.maxRetries ?? 1;
  if (!Number.isInteger(jobMaxRetries) || jobMaxRetries < 1 || jobMaxRetries > 20) throw new Error("Job retries must be between 1 and 20");
  assertJson(config.actions, 4 * 1024 * 1024);
  if (!Array.isArray(config.actions)) throw new Error("Custom actions must be an array");

  const missing = stepNeedingBot(config.actions ?? [], botUsername);
  if (missing) {
    throw new Error(
      `Step ${missing.at + 1} (${missing.type}) needs a target bot, but this job has none. ` +
        "Set one on the job, or give the step its own contact.",
    );
  }

  const client = new TelegramClient(
    new StringSession(sessionString),
    apiId,
    apiHash,
    {
      connectionRetries: 5,
      autoReconnect: false,
      baseLogger: new Logger(LogLevel.NONE),
      ...(proxy ? { proxy } : {}),
      ...(deviceParams ?? {}),
    },
  );

  try {
    if (signal?.aborted) throw new Error("Job cancelled");
    await withTimeout(
      client.connect(),
      CONNECT_TIMEOUT_MS,
      "Telegram connect timed out (custom job)",
      signal,
    );

    let lastJobError: unknown = null;

    for (let jobAttempt = 1; jobAttempt <= jobMaxRetries; jobAttempt++) {
      if (signal?.aborted) throw new Error("Job cancelled");

      // State shared across actions within this job attempt
      let lastMessages: Api.Message[] = [];
      // Separate from the bot-only button cache: contact/page replies can also
      // supply a value to a following save_tag step.
      let tagReplyTexts: string[] = [];
      let lastButtonsMsg: Api.Message | null = null;
      let sendAnchor: SendAnchor | null = null;
      // Last message we sent to each specific contact, keyed by the trimmed
      // contact handle -- the scope anchor for click_message_button.
      const contactAnchors = new Map<string, SendAnchor>();
      const runtime = automationContext(
        { ...(config.variables ?? {}), ...templateOptionVariables(config) },
        signal,
      );
      if (accountId != null) runtime.set("account_id", accountId);
      let lastLinkMessage: Api.Message | null = null;
      const rememberLinkMessages = (messages: Api.Message[]): Api.Message[] => {
        if (messages.length) lastLinkMessage = messages.at(-1)!;
        return messages;
      };
      let stepNumber = 0;
      let jobAttemptFailed = false;

      const executeActions = async (actions: CustomAction[], depth = 0, parentPath = ""): Promise<void> => {
      if (!Array.isArray(actions)) throw new Error("Nested actions must be an array");
      for (let i = 0; i < actions.length; i++) {
        runtime.consume(depth);

        const original = actions[i];
        const action = ADVANCED_ACTION_TYPES.has(original.type)
          ? original
          : expandActionVariables(original, runtime.variables, [
              "content",
              "url",
              "command",
              "responseVariable",
              "statusVariable",
              // Web-step placeholders are expanded by runWebSteps after it has
              // established the current web_for_each element scope. Expanding this
              // tree here would stringify {item} before the marker can be resolved.
              ...(original.type === "open_url" ? ["steps"] : []),
            ]);
        const path = parentPath ? `${parentPath}.${i + 1}` : String(i + 1);
        const number = ++stepNumber;
        const actionMaxRetries =
          action.type !== "delay" && "maxRetries" in action
            ? (action.maxRetries ?? 0)
            : 0;
        if (!Number.isInteger(actionMaxRetries) || actionMaxRetries < 0 || actionMaxRetries > 20) throw new Error("Action retries must be between 0 and 20");

        let actionSucceeded = false;

        for (
          let actionAttempt = 1;
          actionAttempt <= actionMaxRetries + 1 && !actionSucceeded;
          actionAttempt++
        ) {
          if (actionAttempt > 1) runtime.consume(depth);
          const step: CustomStepLog = {
            step: number,
            actionType: action.type,
            label: "",
            path,
            ...(jobMaxRetries > 1 ? { jobAttempt } : {}),
            ...(actionMaxRetries > 0 ? { actionAttempt } : {}),
          };
          log.steps.push(step);
          const t0 = Date.now();

          try {
            if (action.type !== "delay" && action.type !== "save_tag" && action.type !== "save_data" && !ADVANCED_ACTION_TYPES.has(action.type)) {
              tagReplyTexts = [];
            }
            switch (action.type) {
              case "set_variables": {
                step.label = "Set variables";
                if (!Array.isArray(action.variables) || action.variables.length > 100) throw new Error("Set at most 100 variables per action");
                for (const assignment of action.variables) {
                  assertMutableVariableName(assignment.name);
                  let value: JsonValue = assignment.value;
                  if (assignment.source === "reply") {
                    value = assignment.regex
                      ? extractTagValue({ regex: assignment.regex }, tagReplyTexts)
                      : tagReplyTexts.join("\n");
                  } else if (typeof value === "string") {
                    const exact = value.match(/^\{([A-Za-z_][A-Za-z0-9_.]*)\}$/);
                    const resolved = exact ? variableValue(runtime.variables, exact[1]) : undefined;
                    value = resolved === undefined ? expandRuntimeCommand(value, runtime.variables, expandCommand) : resolved;
                  } else {
                    value = expandActionVariables(value, runtime.variables);
                  }
                  runtime.set(assignment.name, value);
                }
                step.result = `Set ${action.variables.length} variable(s)`;
                break;
              }
              case "if_check": {
                step.label = "Condition";
                const matched = evaluateCondition(action.condition, runtime.variables);
                step.result = matched ? "Matched" : "Not matched";
                await executeActions(matched ? action.thenActions : action.elseActions ?? [], depth + 1, `${path}.${matched ? "then" : "else"}`);
                break;
              }
              case "repeat": {
                const count = iterationCount(action.count);
                step.label = `Repeat ${count} time(s)`;
                const indexName = action.indexVariable || "loop_index";
                assertMutableVariableName(indexName);
                const previous = runtime.variables[indexName];
                try {
                  for (let index = 0; index < count && !jobAttemptFailed; index++) {
                    runtime.consume(depth);
                    runtime.set(indexName, index + 1);
                    await executeActions(action.actions, depth + 1, `${path}[${index + 1}]`);
                  }
                } finally {
                  if (previous === undefined) delete runtime.variables[indexName];
                  else runtime.set(indexName, previous);
                }
                step.result = `Repeated ${count} time(s)`;
                break;
              }
              case "for_each": {
                step.label = "For each item";
                const limit = iterationCount(action.maxIterations, 100);
                const itemName = action.itemVariable || "item";
                const indexName = action.indexVariable || "loop_index";
                const onError = action.onError ?? "stop";
                const delayMs = action.delayMs ?? 0;
                if (onError !== "stop" && onError !== "continue") {
                  throw new Error("For each error strategy must be stop or continue");
                }
                if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 3_600_000) {
                  throw new Error("For each delay must be between 0 and 3600000 ms");
                }
                assertMutableVariableName(itemName);
                assertMutableVariableName(indexName);
                if (itemName === indexName) throw new Error("Item and index variables must have different names");
                const previousItem = runtime.variables[itemName];
                const previousIndex = runtime.variables[indexName];
                let items: { value: JsonValue; recordId?: number }[];
                if (action.source === "warehouse") {
                  items = warehouse.records(warehouseId(action.folderId), action.onlyUnprocessed ?? true)
                    .map((record) => ({ value: record.data, recordId: record.id }));
                } else if (action.source === "variable") {
                  const value = variableValue(runtime.variables, action.variable ?? "");
                  if (!Array.isArray(value)) throw new Error("For each requires an array variable");
                  items = value.map((item) => ({ value: item }));
                } else throw new Error("Unsupported loop source");
                if (items.length > limit) throw new Error(`Loop contains ${items.length} items, above its ${limit} iteration limit`);
                let completed = 0;
                let failed = 0;
                try {
                  for (let index = 0; index < items.length && !jobAttemptFailed; index++) {
                    runtime.consume(depth);
                    runtime.set(itemName, items[index].value);
                    runtime.set(indexName, index + 1);
                    await executeActions(action.actions, depth + 1, `${path}[${index + 1}]`);
                    if (signal?.aborted) throw new Error("Job cancelled");
                    if (jobAttemptFailed) {
                      if (onError === "stop") break;
                      failed++;
                      // The nested action has already recorded its error in
                      // the step log. Clear the attempt flag so the next
                      // warehouse item can still run.
                      jobAttemptFailed = false;
                      lastJobError = null;
                    } else {
                      if (items[index].recordId && action.markProcessed) warehouse.setProcessed(items[index].recordId!, true);
                      completed++;
                    }
                    if (index < items.length - 1 && delayMs > 0) {
                      await new Promise<void>((resolve, reject) => {
                        if (signal?.aborted) {
                          reject(new Error("Job cancelled"));
                          return;
                        }
                        let timer: ReturnType<typeof setTimeout>;
                        const onAbort = () => {
                          clearTimeout(timer);
                          signal?.removeEventListener("abort", onAbort);
                          reject(new Error("Job cancelled"));
                        };
                        timer = setTimeout(() => {
                          signal?.removeEventListener("abort", onAbort);
                          resolve();
                        }, delayMs);
                        signal?.addEventListener("abort", onAbort, { once: true });
                      });
                    }
                  }
                } finally {
                  if (previousItem === undefined) delete runtime.variables[itemName]; else runtime.set(itemName, previousItem);
                  if (previousIndex === undefined) delete runtime.variables[indexName]; else runtime.set(indexName, previousIndex);
                }
                step.result = onError === "continue" && failed
                  ? `Completed ${completed}/${items.length} item(s), skipped ${failed}`
                  : `Completed ${completed}/${items.length} item(s)`;
                break;
              }
              case "finish": {
                step.label = "Finish workflow";
                if (action.status !== "success" && action.status !== "failed") throw new Error("Invalid finish status");
                const message = expandVariables(action.message ?? "", runtime.variables);
                step.result = message || action.status;
                if (action.status === "failed") step.error = message || "Finished as failed";
                throw new AutomationFinish(action.status, message);
              }
              case "save_message_link": {
                step.label = "Save message link";
                assertMutableVariableName(action.variable);
                const message = lastLinkMessage;
                const channelId = message?.peerId && "channelId" in message.peerId ? message.peerId.channelId.toString() : null;
                if (!message || !channelId) throw new Error("The latest message is not from a channel or supergroup; Telegram provides no message link for private chats");
                runtime.set(action.variable, `https://t.me/c/${channelId}/${message.id}`);
                step.result = `Saved link to ${action.variable}`;
                break;
              }
              case "save_data": {
                step.label = "Save data";
                if (!Number.isSafeInteger(action.folderId) || action.folderId < 1) {
                  throw new Error("Save data requires a valid warehouse folder");
                }
                if (typeof action.regex !== "string" || !action.regex.trim() || action.regex.length > 500) {
                  throw new Error("Save data requires a regular expression of at most 500 characters");
                }
                if (typeof action.key !== "string" || !action.key.trim() || action.key.length > 256 ||
                    typeof action.value !== "string" || action.value.length > 32_768) {
                  throw new Error("Save data key/value templates are invalid");
                }
                let pattern: RegExp;
                try {
                  assertSafeRegexSource(action.regex, "Save-data regular expression");
                  pattern = new RegExp(action.regex, "g");
                } catch (error) {
                  throw new Error(`Invalid save-data regular expression: ${error instanceof Error ? error.message : String(error)}`);
                }
                const source = tagReplyTexts.length
                  ? tagReplyTexts.join("\n")
                  : lastMessages.map((message) => message.message ?? "").join("\n");
                const entries: Array<{ name: string; data: Record<string, JsonValue> }> = [];
                const render = (template: string, match: RegExpExecArray): string =>
                  template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name: string) => {
                    if (name === "match") return match[0] ?? "";
                    if (name === "accountName") return accountName ?? "";
                    if (name === "accountPhone") return accountPhone ?? "";
                    return match.groups?.[name] ?? token;
                  });
                let match: RegExpExecArray | null;
                let count = 0;
                while ((match = pattern.exec(source)) !== null) {
                  if (++count > 500) throw new Error("Save data matched more than 500 records");
                  const recordName = render(action.key, match).trim();
                  if (!recordName) continue;
                  const rawValue = render(action.value, match);
                  let parsed: JsonValue;
                  try {
                    parsed = JSON.parse(rawValue) as JsonValue;
                  } catch {
                    parsed = rawValue;
                  }
                  const data = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                    ? parsed as Record<string, JsonValue>
                    : { value: parsed };
                  entries.push({ name: recordName, data });
                  if (match[0] === "") pattern.lastIndex++;
                }
                const saved = entries.length ? warehouse.saveData(action.folderId, entries) : { saved: 0, skipped: 0 };
                step.result = `Saved ${saved.saved} record(s); skipped ${saved.skipped} existing`;
                break;
              }
              case "enter_captcha": {
                const lengthHint = action.captchaLength
                  ? ` (${action.captchaLength} chars)`
                  : "";
                step.label = `Enter captcha${lengthHint}`;
                let msgs: Api.Message[];
                if (lastMessages.length > 0) {
                  msgs = lastMessages;
                } else {
                  msgs = await waitForReply(
                    client,
                    botUsername,
                    action.maxWaitMs,
                    undefined,
                    undefined,
                    signal,
                    sendAnchor ? sendAnchor.msgId + 1 : 0,
                    sendAnchor?.isGroup ? sendAnchor.msgId : 0,
                    sendAnchor?.isGroup ? sendAnchor.peerId : undefined,
                  );
                  lastMessages = rememberLinkMessages(msgs);
                }
                const parsed = await parseMessages(msgs, client, signal);
                if (parsed.html) step.preClickHtml = parsed.html;
                if (parsed.images[0]) step.preClickImage = parsed.images[0];
                if (parsed.hasMedia) step.preClickHasMedia = parsed.hasMedia;
                step.aiPrompt = buildCaptchaPrompt(action.captchaLength);
                const aiStart = Date.now();
                const aiResult = await recognizeCaptchaWithAI(
                  parsed.images,
                  action.captchaLength,
                )
                  .then((r) => {
                    step.aiResponse = r.response;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });
                if (
                  action.captchaLength &&
                  aiResult.text.length !== action.captchaLength
                ) {
                  throw new Error(
                    `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${action.captchaLength}`,
                  );
                }
                const sentCaptcha = await client.sendMessage(botUsername, {
                  message: aiResult.text,
                });
                lastLinkMessage = sentCaptcha;
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCaptcha);
                step.result = `Sent: "${aiResult.text}"`;
                break;
              }

              case "send_command": {
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
                const expanded = expandRuntimeCommand(content, runtime.variables, expandCommand);
                step.label = `Send: "${expanded}"`;
                const sentCmd = await client.sendMessage(botUsername, {
                  message: expanded,
                });
                lastLinkMessage = sentCmd;
                lastMessages = [];
                lastButtonsMsg = null;
                sendAnchor = anchorFromSent(sentCmd);
                step.result = "Sent";
                break;
              }

              case "send_contact_message": {
                const contact = action.contact.trim();
                const entity = await resolvePeerTarget(client, contact);
                let content = action.content;
                if (hasAiInput(content)) {
                  const length = parseAiInputLength(content);
                  const parsed = await parseMessages(
                    lastMessages,
                    client,
                    signal,
                  );
                  if (parsed.images[0]) step.preClickImage = parsed.images[0];
                  step.aiPrompt = buildCaptchaPrompt(length);
                  const aiStart = Date.now();
                  const aiResult = await recognizeCaptchaWithAI(
                    parsed.images,
                    length,
                  )
                    .then((r) => {
                      step.aiResponse = r.response;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  if (length && aiResult.text.length !== length) {
                    throw new Error(
                      `AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`,
                    );
                  }
                  content = content.replace(
                    /\{aiInput(?::\d+)?\}/,
                    aiResult.text,
                  );
                }
                const expanded = expandRuntimeCommand(content, runtime.variables, expandCommand);
                step.label = `Send to ${contact}: "${expanded}"`;
                const sentContact = await client.sendMessage(entity, {
                  message: expanded,
                });
                lastLinkMessage = sentContact;
                const contactAnchor = anchorFromSent(sentContact);
                contactAnchors.set(contact, contactAnchor);
                // When a contact explicitly names the job's target (for
                // example, a group used as botUsername), subsequent
                // wait_reply steps should use this exact sent message too.
                if (
                  contact.replace(/^@/, "").toLowerCase() ===
                  botUsername.replace(/^@/, "").toLowerCase()
                ) {
                  sendAnchor = contactAnchor;
                }
                step.result = "Sent";
                break;
              }

              case "wait_reply": {
                const { successContains, failContains } = action;
                const hints = [
                  successContains ? `success: "${successContains}"` : "",
                  failContains ? `fail: "${failContains}"` : "",
                ]
                  .filter(Boolean)
                  .join(", ");
                step.label = `Wait reply (max ${action.maxWaitMs}ms)${hints ? ` [${hints}]` : ""}`;
                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                const msgs = await waitForReply(
                  client,
                  botUsername,
                  action.maxWaitMs,
                  successContains,
                  failContains,
                  signal,
                  minId,
                  sendAnchor?.isGroup ? sendAnchor.msgId : 0,
                  sendAnchor?.isGroup ? sendAnchor.peerId : undefined,
                );
                lastMessages = rememberLinkMessages(msgs);
                tagReplyTexts = msgs.map((m) => m.message ?? "");
                step.msgCount = msgs.length;
                const btnMsg =
                  [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                if (btnMsg) lastButtonsMsg = btnMsg;
                const parsed = await parseMessages(msgs, client, signal);
                step.responseHtml = parsed.html || undefined;
                step.responseImage = parsed.images[0];
                step.responseHasMedia = parsed.hasMedia || undefined;
                step.responseButtons = parsed.buttons.length
                  ? parsed.buttons
                  : undefined;
                step.result = `Received ${msgs.length} message(s)`;
                break;
              }

              case "delay": {
                step.label = `Delay ${action.waitMs}ms`;
                if (!Number.isFinite(action.waitMs) || action.waitMs < 0) throw new Error("Delay must be a nonnegative finite number");
                await new Promise<void>((res, rej) => {
                  if (signal?.aborted) {
                    rej(new Error("Job cancelled"));
                    return;
                  }
                  let timer: ReturnType<typeof setTimeout>;
                  const onAbort = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", onAbort);
                    rej(new Error("Job cancelled"));
                  };
                  timer = setTimeout(() => {
                    signal?.removeEventListener("abort", onAbort);
                    res();
                  }, action.waitMs);
                  signal?.addEventListener("abort", onAbort, { once: true });
                });
                step.result = "Done";
                break;
              }

              case "save_tag": {
                step.label = `Save tag "${action.name}"`;
                if (!accountId) {
                  throw new Error("Save tag requires an account-linked job");
                }
                const name = action.name.trim();
                if (!name) throw new Error("Tag name is required");
                const value = extractTagValue(action, tagReplyTexts);
                setAccountTag(accountId, name, value);
                step.result = `Saved "${name}": ${value}`;
                break;
              }

              case "click_button": {
                step.label = `Click button "${action.button}"`;

                const minId = await resolveScopeFloor(
                  client,
                  botUsername,
                  sendAnchor?.msgId ?? 0,
                  action.scope,
                );
                // Ignore a cached buttons message that falls outside the scope
                // (e.g. a menu from before the command we just sent).
                let buttonsMsg: Api.Message | null =
                  lastButtonsMsg && lastButtonsMsg.id >= minId
                    ? lastButtonsMsg
                    : null;
                let preClickImages: string[] = [];
                if (buttonsMsg) {
                  // The bot may have edited the message since we captured it (swapped or
                  // added buttons); refresh so we click against the current markup
                  const currentId: number = buttonsMsg.id;
                  const fresh: Api.Message | null = await client
                    .getMessages(botUsername, { ids: [currentId] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                  if (hasInlineButtons(fresh)) {
                    buttonsMsg = fresh;
                    lastButtonsMsg = fresh;
                  }
                }
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsMessage(
                    client,
                    botUsername,
                    action.maxWaitMs,
                    signal,
                    minId,
                  );
                  lastMessages = rememberLinkMessages(msgs);
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                  if (buttonsMsg) lastButtonsMsg = buttonsMsg;
                  const preParsed = await parseMessages(msgs, client, signal);
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  if (!step.preClickHtml && !preClickImages.length) {
                    const parsed = await parseMessages(
                      [buttonsMsg],
                      client,
                      signal,
                    );
                    if (parsed.html) step.preClickHtml = parsed.html;
                    if (parsed.images.length) {
                      step.preClickImage = parsed.images[0];
                      preClickImages = parsed.images;
                    }
                    if (parsed.hasMedia)
                      step.preClickHasMedia = parsed.hasMedia;
                    if (parsed.buttons.length)
                      step.preClickButtons = parsed.buttons;
                  }
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                const peer = await client.getInputEntity(botUsername);
                const botPeerId = await client.getPeerId(botUsername);
                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs: Api.Message[] | null =
                        await waitForButtonsMessage(
                          client,
                          botUsername,
                          action.maxWaitMs,
                          signal,
                          minId,
                          buttonsMsg?.id,
                        ).catch(() => null);
                      if (msgs) {
                        lastMessages = rememberLinkMessages(msgs);
                        const bm: Api.Message | undefined = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) {
                          buttonsMsg = bm;
                          lastButtonsMsg = bm;
                        }
                      }
                    }
                  }

                  // The target may already have arrived on an earlier follow-up (e.g.
                  // a "Verify" prompt sent alongside other messages), so it isn't the
                  // "current" buttons message. Scan recent history before matching.
                  if (!markupContainsTarget(buttonsMsg)) {
                    const recent = (await client
                      .getMessages(botUsername, { limit: 8 })
                      .catch(() => [])) as Api.Message[];
                    const hit = recent.find((m) => markupContainsTarget(m));
                    if (hit) {
                      buttonsMsg = hit;
                      lastButtonsMsg = hit;
                    }
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                      // "Verify", a "打开小程序签到" app) carries the web address; open it
                      // in a browser to pass the Cloudflare check.
                      const web = webButtonOf(btn);
                      if (web) {
                        const opened = await openWebButton(
                          client, web, botUsername, buttonsMsg, action.cfChallenge, step, webProxyUrl, cfRun,
                        );
                        const cfText = opened.text;
                        tagReplyTexts = [cfText];
                        // Following a deep link starts a private chat with that bot;
                        // re-anchor so a later wait_reply looks past this send
                        if (opened.deepLinkSent) {
                          const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                          const anchor = anchorFromSent(sentMsg);
                          if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                            sendAnchor = anchor;
                          }
                          contactAnchors.set(linkBot, anchor);
                          contactAnchors.set(`@${linkBot}`, anchor);
                        }
                        clicked = true;
                        step.clickedButton = btnText;
                        // A deep-link button records its own result inside openWebButton
                        if (!step.result) step.result = `Opened "${btnText}"`;
                        if (action.failContains && cfText.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !cfText.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                        break;
                      }

                      // Abort controller scoped to this click attempt -- prevents stale listeners
                      // from interfering with later steps if GetBotCallbackAnswer throws.
                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        10_000,
                        clickAbort.signal,
                        botPeerId,
                      );
                      const newMsgPromise = waitForNewBotMessage(
                        client,
                        botUsername,
                        10_000,
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message, or acted via a Cloudflare page).
                        // Fall through and let the edit/new-message watchers below decide.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // Bots often edit the clicked message AND send a follow-up; when the
                      // first response carries no buttons, give the other source a short
                      // window -- the next step's buttons are usually there
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        lastMessages = rememberLinkMessages(responses.map((r) => r.msg));
                        tagReplyTexts = lastMessages.map((m) => m.message ?? "");
                        if (hasInlineButtons(primary.msg))
                          lastButtonsMsg = primary.msg;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(botUsername, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        lastMessages = rememberLinkMessages([fresh!]);
                        tagReplyTexts = [fresh!.message ?? ""];
                        if (hasInlineButtons(fresh)) lastButtonsMsg = fresh;
                        const parsed = await parseMessages(
                          lastMessages,
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A URL to open (callback answer or a follow-up "我不是机器人"
                      // button) completes the checkin only after passing Cloudflare.
                      let cfText = '';
                      // Only chase a Cloudflare URL from the response when this action
                      // opted in; otherwise an incidental URL/WebApp button (e.g. a
                      // "Verify" the user handles in a later action) must be ignored.
                      if (action.cfChallenge) {
                        cfText = await followUpCfText(
                          client, botUsername, answer, responses, step, webProxyUrl, cfRun,
                        );
                      }
                      if (cfText) tagReplyTexts.push(cfText);

                      // Check success/fail text in callback answer, response, or CF page
                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "click_message_button": {
                const contact = action.contact.trim();
                step.label = `Click button "${action.button}" from ${contact}`;

                const entity = await resolvePeerTarget(client, contact);
                const peer = await client.getInputEntity(entity);
                const chatPeerId = await client.getPeerId(entity);

                const minId = await resolveScopeFloor(
                  client,
                  entity,
                  contactAnchors.get(contact)?.msgId ?? 0,
                  action.scope,
                );
                const findButtonsMsg = (msgs: Api.Message[]): Api.Message | null =>
                  msgs.find((m) => m.id >= minId && hasInlineButtons(m)) ?? null;

                // Seed from the contact's most recent messages (newest first); otherwise wait
                // for an incoming message carrying buttons.
                let buttonsMsg: Api.Message | null = findButtonsMsg(
                  (await client.getMessages(entity, { limit: 10 })) as Api.Message[],
                );
                let preClickImages: string[] = [];
                if (!buttonsMsg) {
                  const msgs = await waitForButtonsInChat(
                    client,
                    entity,
                    action.maxWaitMs,
                    signal,
                    minId,
                  );
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                    null;
                }
                if (buttonsMsg) {
                  const preParsed = await parseMessages(
                    [buttonsMsg],
                    client,
                    signal,
                  );
                  if (preParsed.html) step.preClickHtml = preParsed.html;
                  if (preParsed.images.length) {
                    step.preClickImage = preParsed.images[0];
                    preClickImages = preParsed.images;
                  }
                  if (preParsed.hasMedia)
                    step.preClickHasMedia = preParsed.hasMedia;
                  if (preParsed.buttons.length)
                    step.preClickButtons = preParsed.buttons;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const btnMarkup = (buttonsMsg as any)
                  .replyMarkup as Api.ReplyInlineMarkup;
                const allBtnRows = btnMarkup.rows;
                const flat = allBtnRows.flatMap((row) =>
                  row.buttons.map((b: any) => b.text as string),
                );

                let targetText: string;
                let useExactMatch: boolean;

                if (action.button === "{anyBtn}") {
                  if (!flat.length)
                    throw new Error("No buttons available for {anyBtn}");
                  targetText = flat[Math.floor(Math.random() * flat.length)];
                  useExactMatch = true;
                } else if (isAiBtn(action.button)) {
                  const buttons: string[][] = allBtnRows.map((row) =>
                    row.buttons.map((b: any) => b.text as string),
                  );
                  const hint = parseAiBtnHint(action.button);
                  const aiStart = Date.now();
                  const aiResult = await selectButtonWithAI(
                    buttons,
                    step.preClickHtml ?? buttonsMsg.message ?? "",
                    preClickImages,
                    hint,
                    action.maxRetries,
                  )
                    .then((r) => {
                      step.aiPrompt = r.prompt;
                      step.aiResponse = r.response;
                      if (r.retries.length) step.aiRetries = r.retries;
                      return r;
                    })
                    .finally(() => {
                      step.aiDurationMs = Date.now() - aiStart;
                    });
                  targetText = aiResult.button;
                  useExactMatch = true;
                } else {
                  targetText = action.button;
                  useExactMatch = false;
                }

                let clicked = false;
                let retryCount = 0;

                const markupContainsTarget = (
                  m: Api.Message | null,
                ): boolean =>
                  hasInlineButtons(m) &&
                  ((m as any).replyMarkup as Api.ReplyInlineMarkup).rows.some(
                    (row) =>
                      row.buttons.some((b: any) => {
                        const t = ((b.text as string) ?? "");
                        return useExactMatch
                          ? t === targetText
                          : t.includes(targetText);
                      }),
                  );

                for (
                  let attempt = 0;
                  attempt <= action.maxRetries && !clicked;
                  attempt++
                ) {
                  if (attempt > 0) {
                    retryCount = attempt;
                    // Target may have appeared via an in-place edit of the message we
                    // already have -- refresh it before waiting for a different one
                    const fresh: Api.Message | null = await client
                      .getMessages(entity, { ids: [buttonsMsg!.id] })
                      .then((r) => (r as Api.Message[])?.[0] ?? null)
                      .catch(() => null);
                    if (hasInlineButtons(fresh)) buttonsMsg = fresh;
                    if (!markupContainsTarget(buttonsMsg)) {
                      const msgs = await waitForButtonsInChat(
                        client,
                        entity,
                        action.maxWaitMs,
                        signal,
                        minId,
                      ).catch(() => null);
                      if (msgs) {
                        const bm = [...msgs]
                          .reverse()
                          .find((m) => hasInlineButtons(m));
                        if (bm) buttonsMsg = bm;
                      }
                    }
                  }

                  // The target may already have arrived on an earlier follow-up, so it
                  // isn't the "current" buttons message. Scan recent chat history.
                  if (!markupContainsTarget(buttonsMsg)) {
                    const recent = (await client
                      .getMessages(entity, { limit: 8 })
                      .catch(() => [])) as Api.Message[];
                    const hit = recent.find((m) => markupContainsTarget(m));
                    if (hit) buttonsMsg = hit;
                  }

                  const rows = (
                    (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                  ).rows;
                  for (const row of rows) {
                    for (const btn of row.buttons) {
                      const btnText = (btn as any).text as string;
                      const matches = useExactMatch
                        ? btnText === targetText
                        : btnText.includes(targetText);
                      if (!matches) continue;

                      // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                      // "Verify", a "打开小程序签到" app) carries the web address; open it
                      // in a browser to pass the Cloudflare check.
                      const web = webButtonOf(btn);
                      if (web) {
                        const opened = await openWebButton(
                          client, web, entity, buttonsMsg, action.cfChallenge, step, webProxyUrl, cfRun,
                        );
                        const cfText = opened.text;
                        tagReplyTexts = [cfText];
                        // Following a deep link starts a private chat with that bot;
                        // re-anchor so a later wait_reply looks past this send
                        if (opened.deepLinkSent) {
                          const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                          const anchor = anchorFromSent(sentMsg);
                          if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                            sendAnchor = anchor;
                          }
                          contactAnchors.set(linkBot, anchor);
                          contactAnchors.set(`@${linkBot}`, anchor);
                        }
                        clicked = true;
                        step.clickedButton = btnText;
                        // A deep-link button records its own result inside openWebButton
                        if (!step.result) step.result = `Opened "${btnText}"`;
                        if (action.failContains && cfText.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !cfText.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                        break;
                      }

                      const clickAbort = new AbortController();
                      const forwardAbort = () => clickAbort.abort();
                      signal?.addEventListener("abort", forwardAbort, {
                        once: true,
                      });

                      const editPromise = waitForBotMessageEdit(
                        client,
                        buttonsMsg!.id,
                        10_000,
                        clickAbort.signal,
                        chatPeerId,
                      );
                      const newMsgPromise = waitForNewMessageInChat(
                        client,
                        entity,
                        10_000,
                        clickAbort.signal,
                      );

                      const callbackData = (btn as Api.KeyboardButtonCallback)
                        .data;
                      const preClickEditDate = (buttonsMsg as any).editDate as
                        | number
                        | undefined;
                      let answer: Api.messages.BotCallbackAnswer | null = null;
                      let callbackTimedOut = false;
                      try {
                        answer = (await client.invoke(
                          new Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg!.id,
                            data: callbackData,
                          }),
                        )) as Api.messages.BotCallbackAnswer;
                      } catch (err: any) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                        // called answerCallbackQuery -- the action may still have taken effect
                        // (e.g. the bot edited the message, or acted via a Cloudflare page).
                        // Fall through and let the edit/new-message watchers below decide.
                        if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                          clickAbort.abort();
                          signal?.removeEventListener("abort", forwardAbort);
                          throw err;
                        }
                        callbackTimedOut = true;
                      }

                      if (answer?.message) step.callbackAnswer = answer.message;
                      clicked = true;
                      step.retryCount = retryCount;

                      const taggedEdit = editPromise.then((m) => ({
                        msg: m,
                        src: "edit" as const,
                      }));
                      const taggedNew = newMsgPromise.then((m) => ({
                        msg: m,
                        src: "new_message" as const,
                      }));
                      const first = await Promise.race([taggedEdit, taggedNew]);
                      // When the first response carries no buttons, give the other source
                      // a short window in case it delivers the next step's buttons
                      let second:
                        | { msg: Api.Message | null; src: "edit" | "new_message" }
                        | null = null;
                      if (first.msg && !hasInlineButtons(first.msg)) {
                        const other =
                          first.src === "edit" ? taggedNew : taggedEdit;
                        second = await Promise.race([
                          other,
                          new Promise<null>((r) =>
                            setTimeout(() => r(null), 1_500),
                          ),
                        ]);
                      }
                      clickAbort.abort();
                      signal?.removeEventListener("abort", forwardAbort);

                      const responses = [first, second].filter(
                        (
                          r,
                        ): r is { msg: Api.Message; src: "edit" | "new_message" } =>
                          !!r?.msg && !signal?.aborted,
                      );
                      if (responses.length) {
                        const primary =
                          responses.find((r) => hasInlineButtons(r.msg)) ??
                          responses[0];
                        step.responseSource = primary.src;
                        rememberLinkMessages(responses.map((r) => r.msg));
                        tagReplyTexts = responses.map((r) => r.msg.message ?? "");
                        const parsed = await parseMessages(
                          responses.map((r) => r.msg),
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A timed-out callback only counts as a failure if the bot never
                      // reacted. If no edit/new message was seen live, re-fetch the clicked
                      // message: a changed editDate proves the bot processed the click.
                      if (callbackTimedOut && !responses.length) {
                        const fresh: Api.Message | null = await client
                          .getMessages(entity, { ids: [buttonsMsg!.id] })
                          .then((r) => (r as Api.Message[])?.[0] ?? null)
                          .catch(() => null);
                        const freshEditDate = (fresh as any)?.editDate as
                          | number
                          | undefined;
                        const wasEdited =
                          !!fresh &&
                          !!freshEditDate &&
                          freshEditDate !== preClickEditDate;
                        if (!wasEdited)
                          throw new Error(
                            `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                          );
                        step.responseSource = "edit";
                        rememberLinkMessages([fresh!]);
                        tagReplyTexts = [fresh!.message ?? ""];
                        const parsed = await parseMessages(
                          [fresh!],
                          client,
                          signal,
                        );
                        step.responseHtml = parsed.html || undefined;
                        step.responseImage = parsed.images[0];
                        step.responseHasMedia = parsed.hasMedia || undefined;
                        step.responseButtons = parsed.buttons.length
                          ? parsed.buttons
                          : undefined;
                      }

                      // A URL to open (callback answer or a follow-up "我不是机器人"
                      // button) completes the checkin only after passing Cloudflare.
                      let cfText = '';
                      // Only chase a Cloudflare URL from the response when this action
                      // opted in; otherwise an incidental URL/WebApp button (e.g. a
                      // "Verify" the user handles in a later action) must be ignored.
                      if (action.cfChallenge) {
                        cfText = await followUpCfText(
                          client, entity, answer, responses, step, webProxyUrl, cfRun,
                        );
                      }
                      if (cfText) tagReplyTexts.push(cfText);

                      if (action.successContains || action.failContains) {
                        const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                        if (action.failContains && texts.includes(action.failContains)) {
                          throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                        }
                        if (action.successContains && !texts.includes(action.successContains)) {
                          throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                        }
                      }

                      step.clickedButton = btnText;
                      step.result = `Clicked "${btnText}"`;
                      break;
                    }
                    if (clicked) break;
                  }
                }

                if (!clicked)
                  throw new Error(
                    `Button "${targetText!}" not found after ${action.maxRetries + 1} attempt(s)`,
                  );
                break;
              }

              case "ai_multiple_btn": {
                const contact = action.contact?.trim() ?? "";
                const botMode = contact.length === 0;
                step.label = botMode
                  ? "AI multi-click buttons"
                  : `AI multi-click buttons from ${contact}`;

                // Chat context: the job's bot by default, otherwise a named contact.
                const target: Api.TypeEntityLike = botMode
                  ? botUsername
                  : await resolvePeerTarget(client, contact);
                const peer = await client.getInputEntity(target);
                const editPeerId = await client.getPeerId(target);
                const anchor = botMode
                  ? sendAnchor
                  : (contactAnchors.get(contact) ?? null);
                const minId = await resolveScopeFloor(
                  client,
                  target,
                  anchor?.msgId ?? 0,
                  action.scope,
                );

                const refetch = (id: number): Promise<Api.Message | null> =>
                  client
                    .getMessages(target, { ids: [id] })
                    .then((r) => (r as Api.Message[])?.[0] ?? null)
                    .catch(() => null);
                const waitButtons = (
                  excludeId?: number,
                ): Promise<Api.Message[]> =>
                  botMode
                    ? waitForButtonsMessage(
                        client,
                        botUsername,
                        action.maxWaitMs,
                        signal,
                        minId,
                        excludeId,
                      )
                    : waitForButtonsInChat(
                        client,
                        target,
                        action.maxWaitMs,
                        signal,
                        minId,
                      );
                const waitNewMsg = (
                  timeoutMs: number,
                ): Promise<Api.Message | null> =>
                  botMode
                    ? waitForNewBotMessage(
                        client,
                        botUsername,
                        timeoutMs,
                        signal,
                      )
                    : waitForNewMessageInChat(
                        client,
                        target,
                        timeoutMs,
                        signal,
                      );

                // ── Obtain the message carrying the buttons ──
                let buttonsMsg: Api.Message | null = null;
                let preClickImages: string[] = [];
                if (botMode) {
                  buttonsMsg =
                    lastButtonsMsg && lastButtonsMsg.id >= minId
                      ? lastButtonsMsg
                      : null;
                  if (buttonsMsg) {
                    const fresh = await refetch(buttonsMsg.id);
                    if (hasInlineButtons(fresh)) {
                      buttonsMsg = fresh;
                      lastButtonsMsg = fresh;
                    }
                  }
                } else {
                  const recent = (await client.getMessages(target, {
                    limit: 10,
                  })) as Api.Message[];
                  buttonsMsg =
                    recent.find((m) => m.id >= minId && hasInlineButtons(m)) ??
                    null;
                }
                if (!buttonsMsg) {
                  const msgs = await waitButtons();
                  rememberLinkMessages(msgs);
                  if (botMode) lastMessages = msgs;
                  buttonsMsg =
                    [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                  if (buttonsMsg && botMode) lastButtonsMsg = buttonsMsg;
                }
                if (!buttonsMsg)
                  throw new Error("No message with buttons available");

                const preParsed = await parseMessages(
                  [buttonsMsg],
                  client,
                  signal,
                );
                if (preParsed.html) step.preClickHtml = preParsed.html;
                if (preParsed.images.length) {
                  step.preClickImage = preParsed.images[0];
                  preClickImages = preParsed.images;
                }
                if (preParsed.hasMedia) step.preClickHasMedia = preParsed.hasMedia;
                if (preParsed.buttons.length)
                  step.preClickButtons = preParsed.buttons;

                // ── AI picks the ordered list of buttons to click ──
                const buttonRows: string[][] = (
                  (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                ).rows.map((row) => row.buttons.map((b: any) => b.text as string));
                const aiStart = Date.now();
                const aiResult = await selectMultipleButtonsWithAI(
                  buttonRows,
                  step.preClickHtml ?? buttonsMsg.message ?? "",
                  preClickImages,
                  action.hint,
                  action.maxRetries,
                )
                  .then((r) => {
                    step.aiPrompt = r.prompt;
                    step.aiResponse = r.response;
                    if (r.retries.length) step.aiRetries = r.retries;
                    return r;
                  })
                  .finally(() => {
                    step.aiDurationMs = Date.now() - aiStart;
                  });

                // Clicks one button by exact text against the current message, refreshing the
                // markup on retry, and advances buttonsMsg to the reply so the next click sees
                // the updated markup. Throws if the button never clicks (aborts the action).
                const clickTarget = async (
                  targetText: string,
                ): Promise<{ clickedText: string; responseText: string }> => {
                  let clicked = false;
                  let retryCount = 0;
                  let clickedText = "";
                  let responseText = "";

                  const markupHasTarget = (m: Api.Message | null): boolean =>
                    hasInlineButtons(m) &&
                    (
                      (m as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows.some((row) =>
                      row.buttons.some(
                        (b: any) => ((b.text as string) ?? "") === targetText,
                      ),
                    );

                  for (
                    let attempt = 0;
                    attempt <= action.maxRetries && !clicked;
                    attempt++
                  ) {
                    if (attempt > 0) {
                      retryCount = attempt;
                      const fresh = await refetch(buttonsMsg!.id);
                      if (hasInlineButtons(fresh)) {
                        buttonsMsg = fresh;
                        if (botMode) lastButtonsMsg = fresh;
                      }
                      if (!markupHasTarget(buttonsMsg)) {
                        const msgs = await waitButtons(buttonsMsg?.id).catch(
                          () => null,
                        );
                        if (msgs) {
                          rememberLinkMessages(msgs);
                          if (botMode) lastMessages = msgs;
                          const bm = [...msgs]
                            .reverse()
                            .find((m) => hasInlineButtons(m));
                          if (bm) {
                            buttonsMsg = bm;
                            if (botMode) lastButtonsMsg = bm;
                          }
                        }
                      }
                    }

                    const rows = (
                      (buttonsMsg as any).replyMarkup as Api.ReplyInlineMarkup
                    ).rows;
                    for (const row of rows) {
                      for (const btn of row.buttons) {
                        const btnText = (btn as any).text as string;
                        if (btnText !== targetText) continue;

                        const clickAbort = new AbortController();
                        const forwardAbort = () => clickAbort.abort();
                        signal?.addEventListener("abort", forwardAbort, {
                          once: true,
                        });

                        const editPromise = waitForBotMessageEdit(
                          client,
                          buttonsMsg!.id,
                          10_000,
                          clickAbort.signal,
                          editPeerId,
                        );
                        const newMsgPromise = waitNewMsg(10_000);

                        const callbackData = (btn as Api.KeyboardButtonCallback)
                          .data;
                        const preClickEditDate = (buttonsMsg as any).editDate as
                          | number
                          | undefined;
                        let answer: Api.messages.BotCallbackAnswer | null = null;
                        let callbackTimedOut = false;
                        try {
                          answer = (await client.invoke(
                            new Api.messages.GetBotCallbackAnswer({
                              peer,
                              msgId: buttonsMsg!.id,
                              data: callbackData,
                            }),
                          )) as Api.messages.BotCallbackAnswer;
                        } catch (err: any) {
                          if (
                            !err?.message?.includes("BOT_RESPONSE_TIMEOUT")
                          ) {
                            clickAbort.abort();
                            signal?.removeEventListener("abort", forwardAbort);
                            throw err;
                          }
                          callbackTimedOut = true;
                        }

                        if (answer?.message)
                          step.callbackAnswer = answer.message;
                        clicked = true;
                        step.retryCount = retryCount;

                        const taggedEdit = editPromise.then((m) => ({
                          msg: m,
                          src: "edit" as const,
                        }));
                        const taggedNew = newMsgPromise.then((m) => ({
                          msg: m,
                          src: "new_message" as const,
                        }));
                        const first = await Promise.race([
                          taggedEdit,
                          taggedNew,
                        ]);
                        let second:
                          | {
                              msg: Api.Message | null;
                              src: "edit" | "new_message";
                            }
                          | null = null;
                        if (first.msg && !hasInlineButtons(first.msg)) {
                          const other =
                            first.src === "edit" ? taggedNew : taggedEdit;
                          second = await Promise.race([
                            other,
                            new Promise<null>((r) =>
                              setTimeout(() => r(null), 1_500),
                            ),
                          ]);
                        }
                        clickAbort.abort();
                        signal?.removeEventListener("abort", forwardAbort);

                        const responses = [first, second].filter(
                          (
                            r,
                          ): r is {
                            msg: Api.Message;
                            src: "edit" | "new_message";
                          } => !!r?.msg && !signal?.aborted,
                        );
                        if (responses.length) {
                          const primary =
                            responses.find((r) => hasInlineButtons(r.msg)) ??
                            responses[0];
                          step.responseSource = primary.src;
                          rememberLinkMessages(responses.map((r) => r.msg));
                          tagReplyTexts = responses.map((r) => r.msg.message ?? "");
                          if (hasInlineButtons(primary.msg)) {
                            buttonsMsg = primary.msg;
                            if (botMode) lastButtonsMsg = primary.msg;
                          }
                          if (botMode)
                            lastMessages = responses.map((r) => r.msg);
                          const parsed = await parseMessages(
                            responses.map((r) => r.msg),
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        if (callbackTimedOut && !responses.length) {
                          const fresh = await refetch(buttonsMsg!.id);
                          const freshEditDate = (fresh as any)?.editDate as
                            | number
                            | undefined;
                          const wasEdited =
                            !!fresh &&
                            !!freshEditDate &&
                            freshEditDate !== preClickEditDate;
                          if (!wasEdited)
                            throw new Error(
                              `Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`,
                            );
                          step.responseSource = "edit";
                          rememberLinkMessages([fresh!]);
                          tagReplyTexts = [fresh!.message ?? ""];
                          if (hasInlineButtons(fresh)) {
                            buttonsMsg = fresh;
                            if (botMode) lastButtonsMsg = fresh;
                          }
                          if (botMode) lastMessages = [fresh!];
                          const parsed = await parseMessages(
                            [fresh!],
                            client,
                            signal,
                          );
                          step.responseHtml = parsed.html || undefined;
                          step.responseImage = parsed.images[0];
                          step.responseHasMedia = parsed.hasMedia || undefined;
                          step.responseButtons = parsed.buttons.length
                            ? parsed.buttons
                            : undefined;
                        }

                        // Success/fail text is judged by the caller: the success indicator
                        // typically only appears after the whole sequence is clicked.
                        responseText = [
                          answer?.message ?? "",
                          ...responses.map((r) => r.msg.message ?? ""),
                        ]
                          .filter(Boolean)
                          .join("\n");

                        clickedText = btnText;
                        step.clickedButton = btnText;
                        break;
                      }
                      if (clicked) break;
                    }
                  }

                  if (!clicked)
                    throw new Error(
                      `Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`,
                    );
                  return { clickedText, responseText };
                };

                // ── Click each selected button in order, gap between clicks ──
                const clickedButtons: string[] = [];
                step.clickedButtons = clickedButtons;
                for (let k = 0; k < aiResult.buttons.length; k++) {
                  if (k > 0 && action.gapMs > 0) {
                    await new Promise<void>((res, rej) => {
                      if (signal?.aborted) {
                        rej(new Error("Job cancelled"));
                        return;
                      }
                      const timer = setTimeout(res, action.gapMs);
                      signal?.addEventListener(
                        "abort",
                        () => {
                          clearTimeout(timer);
                          rej(new Error("Job cancelled"));
                        },
                        { once: true },
                      );
                    });
                  }
                  const { clickedText, responseText } = await clickTarget(
                    aiResult.buttons[k],
                  );
                  clickedButtons.push(clickedText);

                  // failContains aborts as soon as any reply signals failure; successContains
                  // is only required on the final reply, since bots usually confirm success
                  // once the whole sequence is done.
                  if (
                    action.failContains &&
                    responseText.includes(action.failContains)
                  ) {
                    throw new Error(
                      `Reply indicates failure: "${action.failContains}" detected`,
                    );
                  }
                  const isLast = k === aiResult.buttons.length - 1;
                  if (
                    isLast &&
                    action.successContains &&
                    !responseText.includes(action.successContains)
                  ) {
                    throw new Error(
                      `Expected success indicator "${action.successContains}" not found in response`,
                    );
                  }
                }

                step.result = `Clicked ${clickedButtons.length} button(s): ${clickedButtons
                  .map((b) => `"${b}"`)
                  .join(", ")}`;
                break;
              }

              case "watch_buttons": {
                const groupId = action.groupId.trim();
                if (!groupId) throw new Error("Watch buttons requires a group");
                const group = await resolvePeerTarget(client, groupId);
                const groupPeer = await client.getInputEntity(group);
                const thank = (action.thankYou ?? []).map((value) => value.trim()).filter(Boolean);
                const minDelay = Math.max(0, Math.min(action.thankDelayMinMs ?? 0, 60_000));
                const maxDelay = Math.max(minDelay, Math.min(action.thankDelayMaxMs ?? minDelay, 120_000));
                let thanked = 0;
                let forwarded = 0;
                // A long-lived watch can produce thousands of callbacks. Keep only
                // promises that are still in flight; completed acknowledgements and
                // forwards must not accumulate for the whole watch budget.
                const postTasks = new Set<Promise<void>>();
                const MAX_POST_TASKS = 2_000;
                const postErrors: string[] = [];
                const recordPostError = (message: string) => {
                  if (postErrors.length < MAX_POST_TASKS) postErrors.push(message);
                };
                const trackPostTask = (task: Promise<void>) => {
                  if (postTasks.size >= MAX_POST_TASKS) return;
                  postTasks.add(task);
                  task.finally(() => postTasks.delete(task)).catch(() => {});
                };
                step.label = `Watch buttons in ${groupId}`;
                const watched = await runWatchButtons(
                  client,
                  action,
                  signal,
                  async (click) => {
                    if (action.forwardPrivateTo?.trim()) {
                      // Forwarding waits for a private drop in parallel. Awaiting it
                      // here would pause the group worker for up to 20 seconds and
                      // could miss another batch opening during that window.
                      const task = forwardPrivateDrop(
                          client,
                          action.forwardPrivateTo.trim(),
                          action.forwardTemplate,
                          action.forwardWaitMs ?? 20_000,
                          Number(click.message.date ?? Math.floor(Date.now() / 1000)) * 1000,
                          (click.message as any).fromId,
                          click.message.message ?? click.button,
                          signal,
                        ).then((sent) => {
                          if (sent) forwarded++;
                        }).catch((error) => {
                          recordPostError(`Forward failed: ${error instanceof Error ? error.message : String(error)}`);
                        });
                      trackPostTask(task);
                    }
                    if (!thank.length && !action.thankAiHint) return;
                    if (action.thankWhenContains && !String(click.callbackAnswer ?? "").includes(action.thankWhenContains)) return;
                    // Delay/AI generation/send runs independently so a slow
                    // supplier cannot pause the long-lived group listener.
                    const task = (async () => {
                      const delay = maxDelay > minDelay
                        ? minDelay + Math.floor(Math.random() * (maxDelay - minDelay + 1))
                        : minDelay;
                      if (delay) await new Promise<void>((resolve, reject) => {
                        const timer = setTimeout(() => {
                          signal?.removeEventListener("abort", abort);
                          resolve();
                        }, delay);
                        const abort = () => {
                          clearTimeout(timer);
                          signal?.removeEventListener("abort", abort);
                          reject(new Error("Job cancelled"));
                        };
                        signal?.addEventListener("abort", abort, { once: true });
                      });
                      let text = thank.length
                        ? thank[Math.floor(Math.random() * thank.length)]
                        : action.thankAiHint!;
                      if (!thank.length && action.thankAiHint) {
                        // AI thanks are best-effort: a missing/slow supplier must
                        // not turn a successfully clicked drop into a failed job.
                        const prompt =
                          `Write one short, natural thank-you in the same language as this hint. ` +
                          `Do not mention AI, do not use quotes, and keep it under 120 characters.\n` +
                          `Hint: ${action.thankAiHint}\n` +
                          `Button result: ${click.callbackAnswer ?? click.button}`;
                        try {
                          const generated = (await callAI([], prompt, 80)).response.trim();
                          if (generated) text = generated.slice(0, 512);
                        } catch {
                          // Keep the hint itself as a deterministic fallback.
                        }
                      }
                      await client.sendMessage(groupPeer, action.thankAsReply
                        ? { message: text, replyTo: click.message.id }
                        : { message: text });
                      thanked++;
                    })().catch((error) => {
                      recordPostError(`Thank-you failed: ${error instanceof Error ? error.message : String(error)}`);
                    });
                    trackPostTask(task);
                  },
                  async (item) => {
                    if (/^(?:Button|Callback) .*(?:failed|Failed)/.test(item.reason)) {
                      recordPostError(item.reason);
                    }
                  },
                );
                if (signal?.aborted) throw new Error("Job cancelled");
                await Promise.allSettled(postTasks);
                if (postErrors.length) {
                  step.watchPostErrors = [...new Set(postErrors)].slice(0, 50);
                  step.error = step.watchPostErrors.join("; ");
                }
                step.watchClicks = watched.clicks.map((click) => {
                  const seconds = Number(click.message.date);
                  return {
                    messageId: click.message.id,
                    ...(Number.isFinite(seconds) ? { messageDate: new Date(seconds * 1000).toISOString() } : {}),
                    button: click.button,
                    ...(click.callbackAnswer ? { callbackAnswer: click.callbackAnswer } : {}),
                    durationMs: click.durationMs,
                  };
                });
                step.clickedButton = watched.clicks.at(-1)?.button;
                step.result = `Watched ${watched.clicks.length} click(s), skipped ${watched.skipped.length}, thanked ${thanked}, forwarded ${forwarded}`;
                break;
              }

              case "watch_codes": {
                const groupId = action.groupId.trim();
                // `{code}` is a per-candidate placeholder, not the value left by a
                // previous watch_codes step. Preserve it while still expanding the
                // other runtime/built-in placeholders in the command template.
                const watchVariables = { ...runtime.variables };
                delete watchVariables.code;
                const watchConfig = {
                  ...action,
                  ...(action.command
                    ? {
                        command: expandRuntimeCommand(
                          action.command,
                          watchVariables,
                          expandCommand,
                        ),
                      }
                    : {}),
                };
                // The reply that follows a winning code is the input to the
                // next action. Keep the override as the active target so a
                // following wait_reply/click_button observes that bot too.
                if (action.bot?.trim()) botUsername = action.bot.trim();
                const actionBot = botUsername;
                if (!groupId) throw new Error("Watch codes requires a source group");
                if (!actionBot) throw new Error("Watch codes requires a target bot");
                step.label = `Watch codes in ${groupId}`;
                // Claims are made before a command is sent. If Telegram times out
                // after accepting the request, another account must not spend the
                // same one-time code a second time.
                const watched = await runWatchCodes(
                  client,
                  watchConfig,
                  actionBot,
                  signal,
                  (code, source) => claimWatchCode(db, {
                    code,
                    sourcePeerId: source.peerId,
                    sourceMessageId: source.messageId,
                  }),
                );
                const successful = watched.success;
                if (!successful?.sent) {
                  const attempts = watched.attempts.filter((item) => !item.skipped).length;
                  throw new Error(
                    `No usable code succeeded during the watch (${attempts} attempted, ` +
                    `${watched.attempts.length - attempts} skipped)`,
                  );
                }
                runtime.set("code", successful.code);
                lastMessages = rememberLinkMessages(successful.replies);
                tagReplyTexts = successful.replies.map((message) => message.message ?? "");
                lastButtonsMsg = [...successful.replies].reverse().find((message) => hasInlineButtons(message)) ?? null;
                sendAnchor = anchorFromSent(successful.sent);
                const parsed = await parseMessages(successful.replies, client, signal);
                step.responseHtml = parsed.html || undefined;
                step.responseImage = parsed.images[0];
                step.responseHasMedia = parsed.hasMedia || undefined;
                step.responseButtons = parsed.buttons.length ? parsed.buttons : undefined;
                step.msgCount = successful.replies.length;
                step.result = `Code accepted (${watched.attempts.length} candidate(s), ` +
                  `${watched.attempts.filter((item) => item.skipped).length} skipped)`;
                break;
              }

              case "join_group": {
                const raw = action.groupId.trim();
                step.label = `Join group: ${raw}`;
                const endIfAlreadyMember = () => {
                  if (action.alreadyMemberEndsTask) {
                    throw new AutomationFinish("success", "Already a member");
                  }
                };

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already a member
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already a member (verified)";
                      endIfAlreadyMember();
                      break;
                    }
                  }

                  let pendingApproval = false;
                  let alreadyMember = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Joined via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                      alreadyMember = true;
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }
                  if (alreadyMember) endIfAlreadyMember();

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");
                } else {
                  // A username, or an ID naming a group the account is already in
                  const entity = await resolvePeerTarget(client, raw);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already a member (verified)";
                      endIfAlreadyMember();
                      break;
                    }
                  }
                  // A basic group cannot be joined by ID or name; being in the chat list is
                  // the only way one was reachable in the first place
                  if (entity instanceof Api.Chat) {
                    step.result = "Already a member";
                    endIfAlreadyMember();
                    break;
                  }

                  let pendingApproval = false;
                  let freshlyJoined = false;
                  let alreadyMember = false;
                  // Small tolerance for clock skew against Telegram server time
                  const joinStartSec = Math.floor(Date.now() / 1000) - 10;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Joined";
                    freshlyJoined = true;
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already a member";
                      alreadyMember = true;
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Join not confirmed: request is still pending approval");
                  if (alreadyMember) endIfAlreadyMember();

                  // Only wait for the in-group verification prompt on a genuine fresh join --
                  // an already-joined account won't get a new prompt, so don't stall on it.
                  if (action.verifyButton && freshlyJoined && entity instanceof Api.Channel) {
                    await clickGroupVerification(
                      client,
                      entity,
                      action.verifyButton,
                      action.verifyWaitMs ?? 30000,
                      step,
                      signal,
                      joinStartSec,
                    );
                  }
                }
                break;
              }

              case "subscribe_channel": {
                const raw = action.channelId.trim();
                step.label = `Subscribe to channel: ${raw}`;

                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                if (inviteMatch) {
                  const hash = inviteMatch[1];

                  if (action.checkMembership) {
                    // CheckChatInvite returns ChatInviteAlready when the user is already subscribed
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.messages.ImportChatInvite({ hash }));
                    step.result = "Subscribed via invite link";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval) {
                    const check = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
                    if (!(check instanceof Api.ChatInviteAlready || check instanceof Api.ChatInvitePeek)) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                } else {
                  // A username, or an ID naming a channel the account is already in
                  const entity = await resolvePeerTarget(client, raw);

                  if (action.checkMembership && entity instanceof Api.Channel) {
                    if (await isChannelMember(client, entity)) {
                      step.result = "Already subscribed (verified)";
                      break;
                    }
                  }

                  let pendingApproval = false;
                  try {
                    await client.invoke(new Api.channels.JoinChannel({ channel: entity as any }));
                    step.result = "Subscribed";
                  } catch (err: any) {
                    if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                      step.result = "Already subscribed";
                    } else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    } else {
                      throw err;
                    }
                  }

                  if (action.checkMembership && !pendingApproval && entity instanceof Api.Channel) {
                    if (!(await isChannelMember(client, entity))) {
                      step.result = "Join request sent (pending approval)";
                      pendingApproval = true;
                    }
                  }

                  if (pendingApproval && action.checkMembership)
                    throw new Error("Subscription not confirmed: request is still pending approval");
                }
                break;
              }

              case "leave_group":
              case "unsubscribe_channel": {
                const raw = (action.type === "leave_group"
                  ? action.groupId
                  : action.channelId
                ).trim();
                if (!raw) throw new Error("A group or channel is required");
                step.label = action.type === "leave_group"
                  ? `Leave group: ${raw}`
                  : `Unsubscribe channel: ${raw}`;
                const left = await leaveChatTarget(client, raw);
                step.result = left
                  ? action.type === "leave_group"
                    ? "Left group"
                    : "Unsubscribed"
                  : action.type === "leave_group"
                    ? "Already not a member"
                    : "Already not subscribed";
                break;
              }

              case "open_mini_app": {
                const target = action.contact?.trim() || botUsername;
                const wantBtn = action.button?.trim();
                step.label = `Open Mini App${wantBtn ? ` "${wantBtn}"` : ""} from ${target}`;

                // Pass `target` through rather than pre-resolving it: GramJS resolves
                // and caches the peer itself, and the extra ResolveUsername round-trip
                // is what tends to time out here.
                const msgs = (await client.getMessages(target, { limit: 10 })) as Api.Message[];
                let hit: { web: WebButton; msg: Api.Message } | undefined;
                for (const m of msgs) {
                  const web = findUrlButton(m, wantBtn);
                  if (web?.miniApp) {
                    hit = { web, msg: m };
                    break;
                  }
                }
                if (!hit) {
                  throw new Error(
                    `No Mini App button${wantBtn ? ` matching "${wantBtn}"` : ""} in the last 10 messages from ${target}`,
                  );
                }

                step.clickedButton = hit.web.text;
                const { url, signed } = await openableButtonUrl(client, hit.web, target, hit.msg);
                step.cfMiniApp = true;
                step.cfMiniAppSigned = signed;
                if (!signed) {
                  throw new Error(
                    `Telegram would not sign the Mini App behind "${hit.web.text}"; it cannot be opened logged in`,
                  );
                }

                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();

                // The budget covers this action's whole browser life, retries included
                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `mini:${path}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  proxyId: action.proxyId,
                  tryAll: action.tryAllProxies ?? true,
                  // An exit that was already refused this run is not offered again, so a
                  // retry moves further into the pool instead of replaying the same few
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                  maxWaitMs: budgetLeft,
                  // The browser side is invisible from here, so keep what it saw
                  screenshot: true,
                  solveQuestion: async (question) => {
                    const prompt =
                      `A Telegram Mini App is asking a verification question before it will ` +
                      `complete a checkin. The screen reads:\n\n${question}\n\n` +
                      `Reply with ONLY the answer to type into the input, nothing else.`;
                    const { response } = await callAI([], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  // Backs the {aiBtn} in-app step: the model is shown the marked-up app
                  // page and names the control to press
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  // Cloudflare judges the exit IP too, so the action can pin an exit of
                  // its own and decide whether the rest of the pool stands by
                  proxyCandidates: candidates,
                  // Init data ages, so each attempt gets a freshly signed URL
                  refreshUrl: async () =>
                    (await openableButtonUrl(client, hit!.web, target, hit!.msg)).url,
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfMiniAppAction = cf.inAppAction;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                tagReplyTexts = [cf.text];
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                step.result = cf.inAppAction
                  ? `Opened "${hit.web.text}", pressed "${cf.inAppAction}"`
                  : `Opened "${hit.web.text}" (nothing pressed inside the app)`;

                if (cf.returnTgLink) {
                  const returnParsed = parseTgReturnLink(cf.returnTgLink);
                  if (returnParsed) {
                    const returnTarget = returnParsed.bot || target;
                    console.log(`[custom] Mini App return link detected, auto-sending ${returnParsed.startCmd} to ${returnTarget}`);
                    try {
                      const returnReplyPromise = waitForReply(client, returnTarget, 15_000, undefined, undefined, signal);
                      await client.sendMessage(returnTarget, { message: returnParsed.startCmd });
                      const returnMsgs = await returnReplyPromise;
                      if (returnMsgs.length) {
                        const parsedReply = await parseMessages(returnMsgs, client, signal);
                        const replyText = htmlToText(parsedReply.html || "");
                        tagReplyTexts.push(replyText);
                        step.result = (step.result ? `${step.result} | ` : "") + `Return: ${returnParsed.startCmd} -> ${replyText.slice(0, 80)}`;
                      }
                    } catch (err: any) {
                      console.warn(`[custom] Mini App return auto-completion warning: ${err?.message ?? err}`);
                    }
                  }
                }

                if (ALREADY_CHECKED_IN_RE.test(cf.text) || (cf.inAppAction && /已签到|已打卡|已完成|already/i.test(cf.inAppAction))) {
                  step.result = (step.result ? `${step.result} | ` : "") + "今日已签 (提前完成)";
                  throw new AutomationFinish("success", "今日已签到");
                }

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found in the Mini App page`,
                  );
                }
                break;
              }

              case "mini_app_http": {
                const rawUrl = expandRuntimeCommand(action.url ?? "", runtime.variables, expandCommand).trim();
                if (!rawUrl) throw new Error("Mini App HTTP requires a URL");
                const owner = action.bot?.trim() || botUsername.trim();
                const resolved = await openableMiniAppUrl(client, rawUrl, owner || undefined);
                const hasInitData =
                  Boolean(extractMiniAppInitData(resolved.url) || extractMiniAppInitData(rawUrl));
                if (!resolved.signed && !hasInitData) {
                  throw new Error(
                    "Telegram would not sign this Mini App URL and it has no tgWebAppData; " +
                      "set the owning bot or provide a signed URL.",
                  );
                }
                step.label = `HTTP ${action.method ?? "GET"} ${miniAppLogUrl(rawUrl)}`;
                // URL is intentionally excluded from the generic action expansion so that
                // built-in Telegram placeholders can be resolved here before signing. Pass the
                // resolved address into the HTTP primitive; otherwise variable URLs would be
                // signed correctly but the request would still use the literal template.
                const httpAction = { ...action, url: rawUrl } as MiniAppHttpAction;
                const result = await runMiniAppHttp(httpAction, {
                  signedUrl: resolved.url,
                  signed: resolved.signed || hasInitData,
                  signal,
                });
                if (action.responseVariable) runtime.set(action.responseVariable, result.body);
                if (action.statusVariable) runtime.set(action.statusVariable, result.status);
                // Keep the persisted run log useful without treating an HTTP response as a
                // Telegram message or retaining an entire potentially sensitive payload.
                step.responseHtml = escapeHtml(result.preview).replace(/\n/g, "<br>");
                step.result =
                  `HTTP ${result.status} (${result.bytes} bytes)` +
                  `${action.responseVariable ? ` -> {${action.responseVariable}}` : ""}`;
                break;
              }

              case "open_bot_menu_app":
              case "open_mini_app_url": {
                // Both open a signed Mini App in the browser and differ only in where the
                // address comes from -- one is typed, the other asked of the bot -- so the
                // resolution is per type and everything past it is shared.
                let url: string;
                let unsigned = false;
                // Init data ages, so each browser attempt is signed afresh
                let refresh: () => Promise<string>;

                if (action.type === "open_bot_menu_app") {
                  const owner = action.contact?.trim() || botUsername.trim();
                  if (!owner) {
                    throw new Error(
                      "This action needs the bot whose menu button to open. Set one on the " +
                        "job, or give the step its own contact.",
                    );
                  }
                  const app = await openableBotMenuApp(client, owner);
                  if (!app) {
                    throw new Error(
                      `${owner} pins no Mini App beside the composer, so it has no menu ` +
                        "button to open. Use “Open Mini App by URL” with its address instead.",
                    );
                  }
                  step.label = `Open "${app.text}" (${owner} menu button)`;
                  step.cfMiniApp = true;
                  step.cfMiniAppSigned = app.signed;
                  if (!app.signed) {
                    throw new Error(
                      `Telegram would not sign ${owner}'s menu Mini App, so it cannot be ` +
                        "opened logged in.",
                    );
                  }
                  url = app.url;
                  refresh = async () => (await openableBotMenuApp(client, owner))?.url ?? app.url;
                } else {
                  // Placeholders expand as they do for a command, so one template URL can
                  // still carry a per-run value
                  const rawUrl = expandRuntimeCommand(action.url ?? "", runtime.variables, expandCommand).trim();
                  if (!rawUrl) throw new Error("This action needs a Mini App URL");
                  // Blank names the job's own bot, which is the common case: a template set
                  // up for one bot works for every account linked to it
                  const owner = action.contact?.trim() || botUsername.trim();
                  step.label = `Open Mini App ${miniAppLogUrl(rawUrl)}`;

                  // An address that already carries its account data needs no signing: it
                  // is what Telegram would have handed back anyway
                  const carriesAccount = /[#&]tgWebAppData=/.test(rawUrl);
                  const resolved = await openableMiniAppUrl(client, rawUrl, owner || undefined);
                  step.cfMiniApp = true;
                  step.cfMiniAppSigned = resolved.signed || carriesAccount;

                  // Naming a bot and being refused by it is a misconfiguration worth
                  // stopping for. Naming none is a deliberate choice -- the page is opened
                  // on this account's browser and exit as it stands, which some apps need.
                  if (!resolved.signed && owner) {
                    throw new Error(
                      `Telegram would not sign this Mini App URL through ${owner}, so it cannot be ` +
                        "opened logged in. Check the bot owns the app, use its t.me/<bot>/<app> link, " +
                        "or clear the contact to open the address as it stands.",
                    );
                  }
                  url = resolved.url;
                  unsigned = !resolved.signed && !carriesAccount;
                  refresh = async () =>
                    (await openableMiniAppUrl(client, rawUrl, owner || undefined)).url;
                }

                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();

                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `mini:${path}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  proxyId: action.proxyId,
                  tryAll: action.tryAllProxies ?? true,
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  miniApp: true,
                  inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                  maxWaitMs: budgetLeft,
                  screenshot: true,
                  solveQuestion: async (question) => {
                    const prompt =
                      `A Telegram Mini App is asking a verification question before it will ` +
                      `complete a checkin. The screen reads:\n\n${question}\n\n` +
                      `Reply with ONLY the answer to type into the input, nothing else.`;
                    const { response } = await callAI([], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
                    step.aiPrompt = prompt;
                    step.aiResponse = response;
                    return response;
                  },
                  proxyCandidates: candidates,
                  refreshUrl: refresh,
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfMiniAppAction = cf.inAppAction;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                tagReplyTexts = [cf.text];
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                // Said plainly: an app that turns out to need an account will fail inside
                // the page, and "opened, nothing pressed" alone would not explain why
                const how = unsigned ? " (no bot named, so opened without account data)" : "";
                step.result = cf.inAppAction
                  ? `Opened the Mini App, pressed "${cf.inAppAction}"${how}`
                  : `Opened the Mini App (nothing pressed inside it)${how}`;

                if (cf.returnTgLink) {
                  const returnParsed = parseTgReturnLink(cf.returnTgLink);
                  if (returnParsed) {
                    const returnTarget = returnParsed.bot || botUsername;
                    console.log(`[custom] Mini App return link detected, auto-sending ${returnParsed.startCmd} to ${returnTarget}`);
                    try {
                      const returnReplyPromise = waitForReply(client, returnTarget, 15_000, undefined, undefined, signal);
                      await client.sendMessage(returnTarget, { message: returnParsed.startCmd });
                      const returnMsgs = await returnReplyPromise;
                      if (returnMsgs.length) {
                        const parsedReply = await parseMessages(returnMsgs, client, signal);
                        const replyText = htmlToText(parsedReply.html || "");
                        tagReplyTexts.push(replyText);
                        step.result = (step.result ? `${step.result} | ` : "") + `Return: ${returnParsed.startCmd} -> ${replyText.slice(0, 80)}`;
                      }
                    } catch (err: any) {
                      console.warn(`[custom] Mini App return auto-completion warning: ${err?.message ?? err}`);
                    }
                  }
                }

                if (ALREADY_CHECKED_IN_RE.test(cf.text) || (cf.inAppAction && /已签到|已打卡|已完成|already/i.test(cf.inAppAction))) {
                  step.result = (step.result ? `${step.result} | ` : "") + "今日已签 (提前完成)";
                  throw new AutomationFinish("success", "今日已签到");
                }

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found in the Mini App page`,
                  );
                }
                break;
              }

              case "open_url": {
                // Placeholders are expanded the same way a command's are, so a URL can carry
                // a random query value per run
                const url = expandRuntimeCommand(action.url ?? "", runtime.variables, expandCommand).trim();
                const webSteps = action.steps ?? [];
                const cfHost = (() => {
                  try {
                    return new URL(url).host;
                  } catch {
                    return "";
                  }
                })();
                // Named before the checks below, so a misconfigured URL still logs a step
                // that says which one it was
                step.label = `Open ${cfHost || url || "(no URL)"}${webSteps.length ? ` (${webSteps.length} page step${webSteps.length > 1 ? "s" : ""})` : ""}`;
                if (!url) throw new Error("No URL configured for this step");
                if (!/^https?:\/\//i.test(url))
                  throw new Error(`URL must start with http:// or https:// (got "${url}")`);

                // The budget covers this action's whole browser life, retries included
                const tune = cfTuning();
                const budgetMs =
                  action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                const budgetKey = `url:${path}`;
                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                cfRun.deadlines.set(budgetKey, actionDeadline);
                const budgetLeft = actionDeadline - Date.now();
                if (budgetLeft < tune.minActionMs) {
                  throw new Error(
                    `Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`,
                  );
                }

                const refused = cfRefusedFor(cfRun, cfHost);
                const candidates = cfProxyCandidatesFor({
                  primaryUrl: webProxyUrl,
                  host: cfHost,
                  proxyId: action.proxyId,
                  tryAll: action.tryAllProxies ?? true,
                  exclude: refused,
                  max: action.tryAllProxies === false ? 1 : cfMaxCandidates(),
                });
                if (!candidates.length) {
                  throw new Error(
                    cfNoCandidatesMessage(cfRun, cfHost),
                  );
                }

                const cf = await loadCheckinUrl(url, webProxyUrl, {
                  webSteps,
                  webVariables: runtime.variables,
                  setWebVariable: (name, value) => runtime.set(name, value),
                  signal,
                  maxWaitMs: budgetLeft,
                  screenshot: true,
                  proxyCandidates: candidates,
                  // The vision model lives on this side of the browser, so the page steps
                  // reach it through a callback rather than the solver importing it
                  aiLocate: async (image, prompt) => {
                    const { response } = await callAI([image], prompt, 512);
                    return response;
                  },
                });
                step.cfHost = cf.finalHost;
                step.cfChallenged = cf.challenged;
                step.cfPassed = cf.ok;
                step.cfProxy = cf.proxyLabel;
                step.cfBuild = cf.browserTier;
                step.cfAttempts = cf.attempts;
                step.cfPageTitle = cf.pageTitle;
                step.cfNavError = cf.navError;
                step.cfTrace = cf.trace;
                step.cfScreenshot = cf.screenshot;
                step.webSteps = cf.webSteps;
                for (const id of cf.refusedProxyIds ?? []) refused.add(id);
                if (!cf.ok) cfNoteFailure(cfRun, cf.finalHost, cf.reason);
                if (cf.ok && cf.proxyId) rememberCfProxy(cf.finalHost, cf.proxyId);
                step.responseHtml = escapeHtml(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                tagReplyTexts = [cf.text];
                if (!cf.ok) {
                  throw new Error(
                    cf.reason ?? cfFailureFallback(cf.challenged, true),
                  );
                }
                const ran = (cf.webSteps ?? []).filter((s) => s.outcome).length;
                step.result = webSteps.length
                  ? `Opened ${cf.finalHost}, ran ${ran}/${cf.webSteps?.length ?? 0} page step(s)`
                  : `Opened ${cf.finalHost}`;

                if (action.failContains && cf.text.includes(action.failContains)) {
                  throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                }
                if (action.successContains && !cf.text.includes(action.successContains)) {
                  throw new Error(
                    `Expected success indicator "${action.successContains}" not found on the page`,
                  );
                }
                break;
              }
              default:
                throw new Error(`Unsupported custom action: ${(action as any).type}`);
            }

            if (step.callbackAnswer) tagReplyTexts.push(step.callbackAnswer);
            const reply = boundedReplyText(tagReplyTexts.join("\n"));
            runtime.set("reply_text", reply.text);
            if (reply.truncated) step.replyTextTruncated = true;
            actionSucceeded = true;

            if (ALREADY_CHECKED_IN_RE.test(reply.text) || (step.callbackAnswer && ALREADY_CHECKED_IN_RE.test(step.callbackAnswer))) {
              console.log(`[custom] Bot reply indicates already checked in today: "${(reply.text || step.callbackAnswer || '').slice(0, 80)}"`);
              step.result = (step.result ? `${step.result} | ` : "") + "今日已签 (智能短路提前完成)";
              throw new AutomationFinish("success", "今日已签到");
            }
          } catch (err: any) {
            // Cancellation is never retried
            if (err?.message === "Job cancelled" || err instanceof AutomationFinish) throw err;

            step.error = err?.message ?? String(err);
            step.errorName = err?.name ?? err?.constructor?.name;
            if (Array.isArray(err?.aiRetries) && err.aiRetries.length)
              step.aiRetries = err.aiRetries;
            if (err?.aiPrompt != null && step.aiPrompt == null)
              step.aiPrompt = err.aiPrompt;
            if (err?.aiResponse != null && step.aiResponse == null)
              step.aiResponse = err.aiResponse;

            if (actionAttempt > actionMaxRetries) {
              // All action retries exhausted -- fail this job attempt
              jobAttemptFailed = true;
              lastJobError = err;
            }
          } finally {
            step.durationMs = Date.now() - t0;
          }
        }

        if (jobAttemptFailed) break;
      }
      };
      await executeActions(config.actions);

      if (!jobAttemptFailed) {
        lastJobError = null;
        break;
      }
    }

    if (lastJobError) throw lastJobError;
  } catch (err: any) {
    if (err?.message === "Job cancelled") throw err;
    if (err instanceof AutomationFinish && err.status === "success") return log;
    throw new CustomJobError(err?.message ?? String(err), log);
  } finally {
    // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14)
    await settleQuietly(client.destroy());
  }

  return log;
}
