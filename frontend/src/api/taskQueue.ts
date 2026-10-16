import { api } from "./client";
import type { AccountTags } from "../utils/accountTags";

export type TaskBatchState = "running" | "paused" | "completed" | "cancelled";
export type TaskItemStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "skipped";
export type TaskQueueItem = {
  id: number | string;
  jobId: number;
  jobName: string;
  accountId: number | null;
  accountName: string | null;
  status: TaskItemStatus;
  logId?: number | null;
  error?: string | null;
  attempts?: number;
};
export type TaskBatchSummary = {
  id: string;
  state: TaskBatchState;
  concurrency: number;
  startIntervalSeconds: number;
  nextStartAt?: string | null;
  total: number;
  done: number;
  failed: number;
  running?: number;
  pending?: number;
  createdAt?: string;
  updatedAt?: string;
};
export type TaskBatch = TaskBatchSummary & { items: TaskQueueItem[] };
export type CreateTaskBatch = {
  concurrency: number;
  startIntervalSeconds: number;
  successTags?: AccountTags;
} & (
  | { jobIds: number[]; accountIds?: never; templateIds?: never }
  | { accountIds: number[]; templateIds: number[]; jobIds?: never }
);

export const taskQueueApi = {
  create: (data: CreateTaskBatch) => api
    .post<{ batchId: string; queued: number; skipped: number }>("/task-queue", data)
    .then((response) => response.data),
  list: () => api.get<{ batches: TaskBatchSummary[] }>("/task-queue").then((response) => response.data.batches),
  get: (id: string) => api.get<TaskBatch>(`/task-queue/${encodeURIComponent(id)}`)
    .then((response) => response.data),
  action: (id: string, action: "pause" | "resume" | "cancel" | "retry-failed") =>
    api.post<TaskBatch>(`/task-queue/${encodeURIComponent(id)}/${action}`).then((response) => response.data),
};
