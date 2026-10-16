import { db } from "../db/database";
import { getAttributes, normalizeTags, writeAttributes } from "../db/accountAttributes";
import { executeManagedJob, getExecutionStatus } from "./execution";
import { TaskQueue, type SuccessTags } from "./taskQueue";

let queue: TaskQueue | undefined;

export function applyBatchSuccessTags(accountId: number, tags: SuccessTags): void {
  db.transaction(() => {
    if (!db.prepare("SELECT id FROM tg_accounts WHERE id = ?").get(accountId)) {
      throw new Error("Account no longer exists");
    }
    const attributes = getAttributes(accountId);
    const merged = { ...normalizeTags(attributes.tags), ...tags };
    if (Object.keys(merged).length > 128) throw new Error("Too many account tags");
    attributes.tags = merged;
    writeAttributes(accountId, attributes);
  })();
}

export function getTaskQueue(): TaskQueue {
  if (!queue) {
    queue = new TaskQueue(db, executeManagedJob, {
      applySuccessTags: applyBatchSuccessTags,
      isJobActive: (jobId) => {
        const status = getExecutionStatus();
        return [...status.running, ...status.queued].some((entry) => entry.jobId === jobId);
      },
      hasCapacity: (accountId, exclusiveAccount) => {
        const status = getExecutionStatus();
        // Only an explicitly exclusive job owns an account lock. Ordinary jobs
        // can share an account unless an exclusive owner is running.
        if (status.running.length >= status.maxConcurrent) return false;
        if (accountId == null) return true;
        const owner = status.running.find((entry) =>
          entry.accountId === accountId && entry.exclusiveAccount,
        );
        if (!owner) return true;
        return exclusiveAccount
          ? false
          : {
              allowed: false,
              skip: true,
              reason: "Skipped because another exclusive job is running for this account",
            };
      },
    });
  }
  return queue;
}
