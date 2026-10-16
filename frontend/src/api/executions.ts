import { api } from "./client";

export type ExecutionInfo = {
  jobId: number;
  jobName: string;
  accountId: number | null;
  exclusiveAccount: boolean;
  source: "scheduler" | "manual" | "batch";
  queuedAt: string;
  startedAt: string | null;
  logId: number | null;
  cancellationRequested: boolean;
  timedOut: boolean;
};

export const executionsApi = {
  list: (signal?: AbortSignal) => api.get<{
    maxConcurrent: number;
    running: ExecutionInfo[];
    queued: ExecutionInfo[];
  }>("/status/executions", { signal }).then((response) => response.data),
  cancel: (jobId: number) => api.post(`/status/executions/${jobId}/cancel`),
};
