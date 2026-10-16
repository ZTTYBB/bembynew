import { Router } from 'express';
import { db } from '../db/database';

const router = Router();

type SupplierRow = { id: number; name: string; base_url: string; api_key: string; timeout_ms: number };
type ModelRow    = { id: number; supplier_id: number; model_id: string; label: string | null };

/** Removes the pinned-default setting when its ai_models row no longer exists. */
function clearDanglingDefaultModel() {
  const pinned = db.prepare("SELECT value FROM settings WHERE key = 'ai_default_model_id'").get() as { value: string } | undefined;
  if (!pinned) return;
  if (!db.prepare('SELECT id FROM ai_models WHERE id = ?').get(Number(pinned.value))) {
    db.prepare("DELETE FROM settings WHERE key = 'ai_default_model_id'").run();
  }
}

const maskKey = (key: string) => {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
};

function timeoutValue(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 10 * 60 * 1000
  ) return null;
  return value;
}

function listAll() {
  const suppliers = db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all() as SupplierRow[];
  const models    = db.prepare('SELECT * FROM ai_models ORDER BY id').all() as ModelRow[];
  return suppliers.map(s => ({ ...s, api_key: maskKey(s.api_key), models: models.filter(m => m.supplier_id === s.id) }));
}

router.get('/', (_req, res) => {
  res.json(listAll());
});

router.post('/', (req, res) => {
  const { name, base_url, api_key = '', timeout_ms = 25000 } = (req.body ?? {}) as Partial<SupplierRow>;
  if (typeof name !== 'string' || !name.trim() ||
      typeof base_url !== 'string' || !base_url.trim()) {
    res.status(400).json({ error: 'name and base_url are required' });
    return;
  }
  if (typeof api_key !== 'string') {
    res.status(400).json({ error: 'api_key must be a string' });
    return;
  }
  const timeout = timeoutValue(timeout_ms, 25000);
  if (timeout == null) {
    res.status(400).json({ error: 'timeout_ms must be an integer from 1 to 600000' });
    return;
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)'
  ).run(name.trim(), base_url.trim(), api_key.trim(), timeout);
  const created = db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(lastInsertRowid) as SupplierRow;
  res.json({ ...created, api_key: maskKey(created.api_key) });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid supplier id' });
    return;
  }
  const existing = db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(id) as SupplierRow | undefined;
  if (!existing) { res.status(404).json({ error: 'Supplier not found' }); return; }

  const { name, base_url, api_key, timeout_ms } = (req.body ?? {}) as Partial<SupplierRow>;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    res.status(400).json({ error: 'name must be a non-empty string' });
    return;
  }
  if (base_url !== undefined && (typeof base_url !== 'string' || !base_url.trim())) {
    res.status(400).json({ error: 'base_url must be a non-empty string' });
    return;
  }
  if (api_key !== undefined && typeof api_key !== 'string') {
    res.status(400).json({ error: 'api_key must be a string' });
    return;
  }
  const timeout = timeoutValue(timeout_ms, existing.timeout_ms);
  if (timeout == null) {
    res.status(400).json({ error: 'timeout_ms must be an integer from 1 to 600000' });
    return;
  }
  db.prepare('UPDATE ai_suppliers SET name = ?, base_url = ?, api_key = ?, timeout_ms = ? WHERE id = ?').run(
    name?.trim()    ?? existing.name,
    base_url?.trim() ?? existing.base_url,
    api_key !== undefined && !api_key.includes('*') ? api_key.trim() : existing.api_key,
    timeout,
    id,
  );
  const updated = db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(id) as SupplierRow;
  res.json({ ...updated, api_key: maskKey(updated.api_key) });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid supplier id' });
    return;
  }
  db.prepare('DELETE FROM ai_suppliers WHERE id = ?').run(id);
  clearDanglingDefaultModel();
  res.json({ ok: true });
});

router.post('/:id/models', (req, res) => {
  const supplierId = Number(req.params.id);
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    res.status(400).json({ error: 'Invalid supplier id' });
    return;
  }
  const { model_id, label } = (req.body ?? {}) as { model_id?: string; label?: string };
  if (typeof model_id !== 'string' || !model_id.trim()) {
    res.status(400).json({ error: 'model_id is required' });
    return;
  }
  if (label !== undefined && typeof label !== 'string') {
    res.status(400).json({ error: 'label must be a string' });
    return;
  }
  if (!db.prepare('SELECT id FROM ai_suppliers WHERE id = ?').get(supplierId)) {
    res.status(404).json({ error: 'Supplier not found' }); return;
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)'
  ).run(supplierId, model_id.trim(), label?.trim() || null);
  res.json(db.prepare('SELECT * FROM ai_models WHERE id = ?').get(lastInsertRowid));
});

router.delete('/:id/models/:modelId', (req, res) => {
  const modelId = Number(req.params.modelId);
  if (!Number.isSafeInteger(modelId) || modelId <= 0) {
    res.status(400).json({ error: 'Invalid model id' });
    return;
  }
  db.prepare('DELETE FROM ai_models WHERE id = ?').run(modelId);
  clearDanglingDefaultModel();
  res.json({ ok: true });
});

export default router;
