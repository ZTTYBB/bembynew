import type {
  Job,
  TgAccount,
  EmbywatchConfig,
  EmbywatchLog,
  TgProxy,
  CheckinConfig,
  AutoregConfig,
} from "../types";
import { runCheckin, CheckinError, type CheckinAttemptLog } from "./checkin";
import { EmbywatchError, resolveProxyLabel, runEmbywatch } from "./embywatch";
import { newCfRunState } from "./cloudflare";
import { runCustom, CustomJobError, type CustomJobLog } from "./custom";
import { runAutoreg, AutoregJobError, type AutoregJobLog } from "./autoreg";
import { mergeEmbyTemplateConfig, parseEmbyConfig } from "./embyTemplate";
import { mergeCustomTemplateConfig, templateOptionVariables } from "./templateOptions";
import { db } from "../db/database";
import { resolveAppClientParams } from "../tg/appClient";

/** Looks a proxy id up in the settings list. */
function proxyUrlById(proxyId: string | null | undefined): string | undefined {
  if (!proxyId) return undefined;
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get("proxies") as { value: string } | undefined;
    if (!row?.value) return undefined;
    const list = JSON.parse(row.value) as Array<{ id: string; url: string }>;
    return list.find((p) => p.id === proxyId)?.url;
  } catch {
    return undefined;
  }
}

/** The proxy id a job or its template carries, if any. */
function configProxyId(
  jobConfig: string | null,
  templateId: number | null | undefined,
): string | undefined {
  const readProxyId = (raw: string | null | undefined): string | undefined => {
    if (!raw) return undefined;
    try {
      let c = JSON.parse(raw);
      if (typeof c === "string") c = JSON.parse(c);
      return c?.proxyId || undefined;
    } catch {
      return undefined;
    }
  };

  let fromTemplate: string | undefined;
  if (templateId) {
    const row = db
      .prepare("SELECT config FROM job_templates WHERE id = ?")
      .get(templateId) as { config: string | null } | undefined;
    fromTemplate = readProxyId(row?.config);
  }
  return fromTemplate ?? readProxyId(jobConfig);
}

/**
 * Exit for this account's Telegram connection: the account's own proxy, and nothing
 * else. Every other place a session is used (login, status checks, the messenger) goes
 * through the account proxy too, so anything else here would put one auth key behind two
 * IPs -- which Telegram answers with AUTH_KEY_DUPLICATED and an invalidated session. A
 * job/template proxy is for the browser side instead (see resolveWebProxyUrl).
 */
function resolveTgProxyUrl(
  accountProxyId: string | null | undefined,
  job: Job,
): string | undefined {
  const configured = configProxyId(job.config, job.templateId);
  if (configured && configured !== accountProxyId) {
    console.warn(
      `[runner] Job "${job.name}": proxy "${configured}" is set on the job/template but the ` +
        `Telegram connection follows the account's proxy (${accountProxyId ?? "none"}); the job ` +
        `proxy is used for the browser only. Set it on the account (and re-authenticate) to ` +
        `route Telegram through it.`,
    );
  }
  return proxyUrlById(accountProxyId);
}

/**
 * Exit for the browser side (Cloudflare challenges, Mini Apps): the job's or template's
 * proxy when one is set, otherwise the account's. Cloudflare judges the exit IP, so this
 * one is meant to be chosen per job, and the browser holds no Telegram session.
 */
function resolveWebProxyUrl(
  accountProxyId: string | null | undefined,
  job: Job,
): string | undefined {
  return proxyUrlById(configProxyId(job.config, job.templateId) ?? accountProxyId);
}

export function parseTgProxy(
  proxyUrl: string | undefined,
): TgProxy | undefined {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const proto = u.protocol.replace(":", "");
    if (proto !== "socks5" && proto !== "socks4" && proto !== "socks")
      return undefined;
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      socksType: proto === "socks4" ? 4 : 5,
      username: u.username || undefined,
      password: u.password || undefined,
    };
  } catch {
    return undefined;
  }
}

export type JobDetailLog =
  | CheckinAttemptLog
  | EmbywatchLog
  | CustomJobLog
  | AutoregJobLog;

const RETRY_DELAY_MS = 5_000;

function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Job cancelled"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Job cancelled"));
      },
      { once: true },
    );
  });
}

export async function runJob(
  job: Job,
  account: TgAccount | null,
  detailLogs?: JobDetailLog[],
  signal?: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  // Browser exits refused during this run, shared by every attempt below: retrying a
  // proxy Cloudflare has already turned down only replays the refusal
  const cfRun = newCfRunState();

  for (let attempt = 1; attempt <= job.retryMax; attempt++) {
    if (signal?.aborted) throw new Error("Job cancelled");
    try {
      switch (job.jobType) {
        case "checkin": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          // Telegram follows the account's exit; the browser may use the job's
          const checkinProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const checkinProxyUrl = resolveWebProxyUrl(account.proxyId, job);
          const checkinDevice = resolveAppClientParams(account.id, account.appClientId);
          let checkinCfg: CheckinConfig = {};
          try {
            // For template-linked jobs, use template config as base then overlay job config
            if (job.templateId) {
              const tplRow = db
                .prepare("SELECT config FROM job_templates WHERE id = ?")
                .get(job.templateId) as { config: string | null } | undefined;
              if (tplRow?.config) {
                let t = JSON.parse(tplRow.config);
                if (typeof t === "string") t = JSON.parse(t);
                checkinCfg = { ...checkinCfg, ...t };
              }
            }
            if (job.config) {
              let c = JSON.parse(job.config);
              if (typeof c === "string") c = JSON.parse(c);
              checkinCfg = { ...checkinCfg, ...c };
            }
          } catch {
            /* ignore */
          }
          const log = await runCheckin(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            job.replyTimeoutMs,
            job.startCommand,
            job.checkinButton,
            attempt,
            job.retryMax,
            signal,
            checkinProxy,
            checkinDevice,
            checkinCfg.successContains,
            checkinCfg.failContains,
            checkinCfg.cfChallenge ?? false,
            checkinProxyUrl,
            cfRun,
          );
          detailLogs?.push(log);
          break;
        }
        case "embywatch": {
          const jobCfg = parseEmbyConfig(job.config);
          let config: EmbywatchConfig = jobCfg as EmbywatchConfig;
          // Template-linked jobs: merge template config (settings) with job config (credentials)
          if (job.templateId) {
            const tplRow = db
              .prepare("SELECT config FROM job_templates WHERE id = ?")
              .get(job.templateId) as { config: string | null } | undefined;
            if (tplRow) {
              config = mergeEmbyTemplateConfig(tplRow.config, jobCfg);
            }
          }
          // Emby accepts accounts with no password. The job-create and connection
          // test routes already validate only the username, so keep execution
          // consistent with those paths.
          if (!config.username)
            throw new EmbywatchError(
              "Emby username is required",
              resolveProxyLabel(config.proxyId),
              config.sequencePlay === true,
            );
          const log = await runEmbywatch(job.botUsername, config, signal);
          detailLogs?.push(log);
          break;
        }
        case "custom": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          let rawCfg = JSON.parse(job.config ?? '{"actions":[]}');
          if (job.templateId) {
            const tplRow = db
              .prepare("SELECT config FROM job_templates WHERE id = ?")
              .get(job.templateId) as { config: string | null } | undefined;
            if (tplRow) {
              rawCfg = mergeCustomTemplateConfig(tplRow.config, rawCfg) ?? rawCfg;
            }
          }
          // Template options are selected per linked task and become runtime
          // variables. They take precedence over ordinary variables on a
          // collision, so a task cannot silently override its own selection.
          const optionVariables = templateOptionVariables(rawCfg);
          rawCfg = {
            ...rawCfg,
            variables: { ...(rawCfg.variables ?? {}), ...optionVariables },
          };
          // Telegram follows the account's exit; the browser may use the job's
          const customProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const customProxyUrl = resolveWebProxyUrl(account.proxyId, job);
          const customDevice = resolveAppClientParams(account.id, account.appClientId);
          const customLog = await runCustom(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            rawCfg,
            signal,
            customProxy,
            customDevice,
            customProxyUrl,
            cfRun,
            account.id,
            account.name,
            account.phoneNumber,
          );
          detailLogs?.push(customLog);
          break;
        }
        case "autoreg": {
          if (!account) throw new Error("No account linked to this job");
          if (!account.sessionString)
            throw new Error("Account has no session -- authenticate first");
          if (!account.apiId || !account.apiHash)
            throw new Error("No API credentials available for this account");
          let autoregCfg: Record<string, unknown> = {};
          try {
            // Template-linked jobs: template config as base, job config overlaid
            if (job.templateId) {
              const tplRow = db
                .prepare("SELECT config FROM job_templates WHERE id = ?")
                .get(job.templateId) as { config: string | null } | undefined;
              if (tplRow?.config) {
                let t = JSON.parse(tplRow.config);
                if (typeof t === "string") t = JSON.parse(t);
                autoregCfg = { ...autoregCfg, ...t };
              }
            }
            if (job.config) {
              let c = JSON.parse(job.config);
              if (typeof c === "string") c = JSON.parse(c);
              autoregCfg = { ...autoregCfg, ...c };
            }
          } catch {
            /* ignore */
          }
          const autoregProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
          const autoregDevice = resolveAppClientParams(
            account.id,
            account.appClientId,
          );
          const autoregLog = await runAutoreg(
            account.apiId,
            account.apiHash,
            account.sessionString,
            job.botUsername,
            job.startCommand,
            autoregCfg as unknown as AutoregConfig,
            signal,
            autoregProxy,
            autoregDevice,
            job.replyTimeoutMs,
          );
          detailLogs?.push(autoregLog);
          break;
        }
        default:
          throw new Error(`Unknown job type: ${job.jobType}`);
      }
      return;
    } catch (err) {
      if (err instanceof CheckinError) detailLogs?.push(err.log);
      if (err instanceof CustomJobError) detailLogs?.push(err.log);
      if (err instanceof AutoregJobError) detailLogs?.push(err.log);
      if (err instanceof EmbywatchError) detailLogs?.push(err.log);
      lastError = err;
      // A cancelled job must not be retried, and must report as cancelled even
      // if the underlying failure surfaced as something else.
      if (signal?.aborted) throw new Error("Job cancelled");
      console.error(
        `[runner] Job "${job.name}" attempt ${attempt}/${job.retryMax} failed:`,
        err,
      );
      if (attempt < job.retryMax && signal) {
        await delayAbortable(RETRY_DELAY_MS, signal).catch(() => {
          throw lastError;
        });
      } else if (attempt < job.retryMax) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw lastError;
}
