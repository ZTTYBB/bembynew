import { api, type Job } from "./client";

export type JobOutcomePreview = {
  jobId: number;
  revision: string;
  latestLog: { id: number; ranAt: string; status: string; message: string | null } | null;
};

export const outcomesApi = {
  get: (jobId: number, signal?: AbortSignal) =>
    api.get<JobOutcomePreview>(`/jobs/${jobId}/outcome`, { signal }).then((response) => response.data),
  mark: (jobId: number, status: "success" | "failed", expectedRevision: string) =>
    api.post<{ job: Job; logId: number; created: boolean; status: "success" | "failed"; scheduleRefreshPending?: boolean }>(
      `/jobs/${jobId}/outcome`, { status, expectedRevision },
    ).then((response) => response.data),
};
