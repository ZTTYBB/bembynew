import { Router } from "express";
import { warehouse, warehouseId, WarehouseError } from "../db/warehouse";

const router = Router();
router.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
const handle = (fn: (req: any, res: any) => void) => (req: any, res: any) => {
  try { fn(req, res); } catch (error: any) {
    if (error instanceof WarehouseError) res.status(error.status).json({ error: error.message });
    else { console.error("[warehouse] Request failed", error?.name); res.status(500).json({ error: "Warehouse request failed" }); }
  }
};

router.get("/folders", handle((_req, res) => res.json(warehouse.folders())));
router.post("/folders", handle((req, res) => res.status(201).json(warehouse.createFolder(req.body))));
router.put("/folders/reorder", handle((req, res) => {
  warehouse.reorder("folders", req.body?.parentId == null ? null : warehouseId(req.body.parentId), req.body?.ids);
  res.json({ ok: true });
}));
router.put("/folders/:id", handle((req, res) => res.json(warehouse.updateFolder(warehouseId(req.params.id), req.body))));
router.delete("/folders/:id", handle((req, res) => { warehouse.deleteFolder(warehouseId(req.params.id)); res.json({ ok: true }); }));
router.get("/folders/:id/records", handle((req, res) => {
  if (req.query.unprocessed !== undefined && req.query.unprocessed !== "true" && req.query.unprocessed !== "false") throw new WarehouseError("Invalid unprocessed filter");
  res.json(warehouse.records(warehouseId(req.params.id), req.query.unprocessed === "true"));
}));
router.post("/folders/:id/records", handle((req, res) => res.status(201).json(warehouse.createRecord(warehouseId(req.params.id), req.body))));
router.put("/records/reorder", handle((req, res) => {
  warehouse.reorder("records", warehouseId(req.body?.folderId), req.body?.ids);
  res.json({ ok: true });
}));
router.put("/records/:id", handle((req, res) => res.json(warehouse.updateRecord(warehouseId(req.params.id), req.body))));
router.delete("/records/:id", handle((req, res) => { warehouse.deleteRecord(warehouseId(req.params.id)); res.json({ ok: true }); }));
router.get("/export", handle((req, res) => {
  if (req.query.includeSensitive !== undefined && req.query.includeSensitive !== "true" && req.query.includeSensitive !== "false") throw new WarehouseError("Invalid includeSensitive option");
  res.json(warehouse.export(req.query.includeSensitive === "true"));
}));
router.post("/import", handle((req, res) => res.status(201).json(warehouse.import(req.body))));

export default router;
