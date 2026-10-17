import { Router } from 'express';
import { db } from '../db/database';
import { TEST_IMAGE_BASE64 } from './ai-test-image';

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

router.post('/remote-models', async (req, res) => {
  const { supplier_id, base_url, api_key } = (req.body ?? {}) as {
    supplier_id?: number;
    base_url?: string;
    api_key?: string;
  };

  let targetUrl = base_url?.trim();
  let targetKey = api_key?.trim();

  if (supplier_id) {
    const existing = db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(supplier_id) as SupplierRow | undefined;
    if (existing) {
      if (!targetUrl) targetUrl = existing.base_url;
      if (!targetKey || targetKey.includes('*')) targetKey = existing.api_key;
    }
  }

  if (!targetUrl) {
    res.status(400).json({ error: 'base_url is required' });
    return;
  }

  const endpoint = `${targetUrl.replace(/\/+$/, '')}/models`;
  const timeoutMs = 15000;

  try {
    const headers: Record<string, string> = {};
    if (targetKey) {
      headers['Authorization'] = `Bearer ${targetKey}`;
    }

    const response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      res.status(response.status).json({
        error: `Upstream error ${response.status}: ${body.slice(0, 300)}`
      });
      return;
    }

    const data = await response.json() as any;
    const rawList = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
    const models = rawList
      .map((item: any) => {
        if (typeof item === 'string') return { id: item, owned_by: '' };
        if (item && typeof item.id === 'string') {
          return { id: item.id, owned_by: item.owned_by || '' };
        }
        return null;
      })
      .filter((m: any) => Boolean(m?.id));

    res.json({ models });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? String(err) });
  }
});

router.post('/test', async (req, res) => {
  const { supplier_id, model_id, base_url, api_key, timeout_ms = 25000 } = (req.body ?? {}) as {
    supplier_id?: number;
    model_id?: string;
    base_url?: string;
    api_key?: string;
    timeout_ms?: number;
  };

  if (!model_id?.trim()) {
    res.status(400).json({ error: 'model_id is required' });
    return;
  }

  let targetUrl = base_url?.trim();
  let targetKey = api_key?.trim();
  let targetTimeout = timeout_ms;

  if (supplier_id) {
    const existing = db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(supplier_id) as SupplierRow | undefined;
    if (existing) {
      if (!targetUrl) targetUrl = existing.base_url;
      if (!targetKey || targetKey.includes('*')) targetKey = existing.api_key;
      if (existing.timeout_ms) targetTimeout = existing.timeout_ms;
    }
  }

  if (!targetUrl) {
    res.status(400).json({ error: 'base_url is required' });
    return;
  }
  if (!targetKey) {
    res.status(400).json({ error: 'api_key is required' });
    return;
  }

  const endpoint = `${targetUrl.replace(/\/+$/, '')}/chat/completions`;
  const t0 = Date.now();

  try {
    // Phase 1: Test text completion
    const textRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${targetKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model_id.trim(),
        messages: [{ role: 'user', content: '请回复数字 12345' }],
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(targetTimeout),
    });

    const latencyMs = Date.now() - t0;
    if (!textRes.ok) {
      const errText = await textRes.text().catch(() => '');
      res.json({
        ok: false,
        latency_ms: latencyMs,
        error: `HTTP ${textRes.status}: ${errText.slice(0, 300)}`,
        vision_supported: false,
      });
      return;
    }

    const textData = await textRes.json() as any;
    const reply = (textData.choices?.[0]?.message?.content ?? '').trim();

    // Phase 2: Test vision capabilities
    let visionSupported = false;
    let visionError: string | undefined;

    try {
      const visionRes = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${targetKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model_id.trim(),
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: TEST_IMAGE_BASE64 } },
              { type: 'text', text: '图中内容是什么？简要回答' },
            ],
          }],
          max_tokens: 30,
        }),
        signal: AbortSignal.timeout(Math.min(targetTimeout, 15000)),
      });

      if (visionRes.ok) {
        visionSupported = true;
      } else {
        const vBody = await visionRes.text().catch(() => '');
        visionError = `HTTP ${visionRes.status}: ${vBody.slice(0, 150)}`;
      }
    } catch (vErr: any) {
      visionError = vErr?.message ?? String(vErr);
    }

    res.json({
      ok: true,
      latency_ms: latencyMs,
      reply,
      vision_supported: visionSupported,
      vision_error: visionError,
    });
  } catch (err: any) {
    res.json({
      ok: false,
      latency_ms: Date.now() - t0,
      error: err?.message ?? String(err),
      vision_supported: false,
    });
  }
});

router.post('/:id/models/batch', (req, res) => {
  const supplierId = Number(req.params.id);
  if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    res.status(400).json({ error: 'Invalid supplier id' });
    return;
  }
  const { model_ids } = (req.body ?? {}) as { model_ids?: string[] };
  if (!Array.isArray(model_ids) || !model_ids.length) {
    res.status(400).json({ error: 'model_ids array is required' });
    return;
  }
  if (!db.prepare('SELECT id FROM ai_suppliers WHERE id = ?').get(supplierId)) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }
  const existing = new Set(
    (db.prepare('SELECT model_id FROM ai_models WHERE supplier_id = ?').all(supplierId) as { model_id: string }[]).map(r => r.model_id)
  );
  const insert = db.prepare('INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)');
  let added = 0;
  for (const mid of model_ids) {
    const trimmed = typeof mid === 'string' ? mid.trim() : '';
    if (trimmed && !existing.has(trimmed)) {
      insert.run(supplierId, trimmed);
      existing.add(trimmed);
      added++;
    }
  }
  res.json({ ok: true, added });
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
