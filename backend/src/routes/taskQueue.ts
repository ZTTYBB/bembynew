import { Router } from "express";
import type { TaskQueue } from "../jobs/taskQueue";

export function createTaskQueueRouter(queue: TaskQueue): Router {
  const router = Router();
  router.get("/", (_req, res) => res.json({ batches: queue.list() }));
  router.post("/", (req, res) => {
    try {
      res.status(202).json(queue.enqueue(req.body ?? {}));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid batch" });
    }
  });
  router.get("/:id", (req, res) => {
    const batch = queue.get(req.params.id);
    if (!batch) { res.status(404).json({ error: "Batch not found" }); return; }
    res.json(batch);
  });
  for (const action of ["pause", "resume", "cancel", "retry-failed"] as const) {
    router.post(`/:id/${action}`, (req, res) => {
      try {
        if (!queue.control(req.params.id, action)) {
          res.status(404).json({ error: "Batch not found" });
          return;
        }
        res.json(queue.get(req.params.id));
      } catch (error) {
        res.status(409).json({ error: error instanceof Error ? error.message : "Batch cannot be changed" });
      }
    });
  }
  return router;
}
