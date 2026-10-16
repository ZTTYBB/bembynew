import { api } from "./client";

export type ScheduleState = "pending" | "dispatching" | "interrupted";
export type ScheduledJob = {
  jobId: number;
  jobName: string;
  jobType: string;
  nextRun: string;
  timezone: string;
  pinned: boolean;
  state: ScheduleState;
  revision: number;
};

export type SchedulePlan = {
  jobId: number;
  nextRun: string;
  timezone: string;
  pinned: boolean;
  state: ScheduleState;
  origin: "auto" | "manual" | "skip" | "shuffle";
  scheduleKey: string;
  revision: number;
  skippedAt: string | null;
  updatedAt: string;
};

export const schedulesApi = {
  list: (signal?: AbortSignal) =>
    api.get<ScheduledJob[]>("/status", { signal }).then((response) => response.data),
  update: (jobId: number, data: { nextRun: string; timezone: string; pinned: boolean; expectedRevision?: number }) =>
    api.put<SchedulePlan>(`/status/schedule/${jobId}`, data).then((response) => response.data),
  pin: (jobId: number, pinned: boolean) =>
    api.put<SchedulePlan>(`/status/schedule/${jobId}/pin`, { pinned }).then((response) => response.data),
  skip: (jobId: number) =>
    api.post<{ ok: boolean; nextRun?: string }>(`/status/skip/${jobId}`).then((response) => response.data),
  shuffle: (date?: string) =>
    api.post<{ moved: number; protected: number }>("/status/shuffle", { date }).then((response) => response.data),
};
