import { Router } from 'express';
import {
  getSchedulerStatus, skipNextRun, setNextRun, setSchedulePinned, shuffleSchedules,
  ScheduleConflictError,
} from '../scheduler';
import { cancelManagedJob, getExecutionStatus } from '../jobs/execution';
import { memoryReport } from '../monitor/memory';

const router = Router();
export type ScheduleBody = { nextRun: string; timezone?: string; pinned?: boolean; expectedRevision?: number };

function validJobId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

router.get('/', (req, res) => {
  res.json(getSchedulerStatus());
});

// POST /skip/:jobId -- give up the pending run and arm the one after it. The job keeps its
// schedule; this is calling off one occurrence, not disabling anything.
router.post('/skip/:jobId', (req, res) => {
  const jobId = Number(req.params.jobId);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    res.status(400).json({ error: 'Invalid job id' });
    return;
  }
  const result = skipNextRun(jobId);
  if (!result.ok) {
    res.status(404).json({ error: 'That job has no scheduled run' });
    return;
  }
  res.json(result);
});

// Separate path so the schedule list above keeps returning a bare array
router.get('/memory', (req, res) => {
  res.json(memoryReport());
});

router.get('/executions', (_req, res) => {
  res.json(getExecutionStatus());
});

router.post('/executions/:jobId/cancel', (req, res) => {
  const jobId = validJobId(req.params.jobId);
  if (jobId == null) { res.status(400).json({ error: 'Invalid job id' }); return; }
  if (!cancelManagedJob(jobId)) { res.status(404).json({ error: 'Job is not active' }); return; }
  res.json({ ok: true });
});

router.put('/schedule/:jobId', (req, res) => {
  const jobId = validJobId(req.params.jobId);
  const body = req.body as ScheduleBody;
  if (jobId == null || !body || typeof body.nextRun !== 'string' ||
    (body.timezone !== undefined && typeof body.timezone !== 'string') ||
    (body.pinned !== undefined && typeof body.pinned !== 'boolean') ||
    (body.expectedRevision !== undefined &&
      (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision <= 0))) {
    res.status(400).json({ error: 'Invalid schedule request' });
    return;
  }
  try {
    res.json(setNextRun(jobId, body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(error instanceof ScheduleConflictError ? 409 : message === 'Job not found' ? 404 : 400)
      .json({ error: message });
  }
});

router.put('/schedule/:jobId/pin', (req, res) => {
  const jobId = validJobId(req.params.jobId);
  const pinned = (req.body as { pinned?: unknown })?.pinned;
  if (jobId == null || typeof pinned !== 'boolean') {
    res.status(400).json({ error: 'Invalid schedule pin request' });
    return;
  }
  const plan = setSchedulePinned(jobId, pinned);
  if (!plan) { res.status(409).json({ error: 'Job has no pending schedule' }); return; }
  res.json(plan);
});

router.post('/shuffle', (req, res) => {
  const date = (req.body as { date?: unknown })?.date;
  if (date !== undefined && typeof date !== 'string') { res.status(400).json({ error: 'date must be a string' }); return; }
  try {
    res.json(shuffleSchedules(date as string | undefined));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
