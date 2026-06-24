// ════════════════════════════════════════════════════════════════════════
// FIREBASE → SUPABASE COMPAT SHIM
// Implementa a mesma API usada pelo app (_db.ref().push/set/update/remove/
// on('value')/once('value')/child()) mas gravando e lendo do Supabase.
// Não precisa alterar o resto do app.js — só a inicialização.
// ════════════════════════════════════════════════════════════════════════
function createFirebaseCompatShim(supa) {

  // ── Mapa de "raízes" do antigo Firebase Realtime DB ───────────────────
  // mode 'rows'  -> 1 linha por registro, tabela tem coluna id + raw(jsonb)
  // mode 'blob'  -> a árvore inteira fica como 1 linha em fluxolab_state
  const ROOTS = {
    users:               { mode: 'rows', table: 'operadores' },
    history:             { mode: 'rows', table: 'history', dated: true }, // /history/{dateKey}[/{docId}]
    fluxolab_log:        { mode: 'rows', table: 'fluxolab_log' },
    devolucoes:          { mode: 'rows', table: 'devolucoes' },
    fluxolab_checklists: { mode: 'rows', table: 'fluxolab_checklists' },
    fluxolab:            { mode: 'blob', blobKey: 'fluxolab' },
    alarme_global:       { mode: 'blob', blobKey: 'alarme_global' },
    faceAuth:            { mode: 'rows', table: 'face_auth' },
  };

  // Colunas dedicadas que tentamos espelhar (best-effort). A fonte de
  // verdade é sempre a coluna `raw` (jsonb) — nada se perde se a chave
  // não estiver nesse mapa.
  const MIRROR = {
    operadores: {
      name: 'name', pin: 'pin', code: 'code', local: 'local', sector: 'sector',
      active: 'active', hidden: 'hidden', totalDia: 'total_dia', repDia: 'rep_dia',
      status: 'status', selb: 'selb',
      _selb: 'selb', _status: 'status', _startEpoch: 'start_epoch',
      _frozenElapsed: 'frozen_elapsed', _activeFrom: 'active_from',
      _bloqueado: 'bloqueado', _bloqueadoAte: 'bloqueado_ate',
    },
    history: { uid: 'uid', selb: 'selb', equipamento: 'equipamento', status: 'status', startEpoch: 'start_epoch', endEpoch: 'end_epoch' },
  };

  function mirrorCols(table, obj) {
    const map = MIRROR[table];
    const out = {};
    if (!map || !obj || typeof obj !== 'object') return out;
    for (const k in map) if (obj[k] !== undefined) out[map[k]] = obj[k];
    return out;
  }

  // ── Gerador de chave estilo "push key" do Firebase (ordenável por tempo) ──
  let _lastPushTime = 0, _lastRandChars = [];
  const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  function genPushKey() {
    let now = Date.now();
    const dup = now === _lastPushTime;
    _lastPushTime = now;
    const timeChars = new Array(8);
    for (let i = 7; i >= 0; i--) { timeChars[i] = PUSH_CHARS.charAt(now % 64); now = Math.floor(now / 64); }
    let key = timeChars.join('');
    if (!dup) {
      _lastRandChars = new Array(12);
      for (let i = 0; i < 12; i++) _lastRandChars[i] = Math.floor(Math.random() * 64);
    } else {
      for (let i = 11; i >= 0 && _lastRandChars[i] === 63; i--) _lastRandChars[i] = 0;
      if (_lastRandChars.length) _lastRandChars[_lastRandChars.length - 1]++;
    }
    for (let i = 0; i < 12; i++) key += PUSH_CHARS.charAt(_lastRandChars[i]);
    return key;
  }

  // ── Helpers de path ─────────────────────────────────────────────────
  function parts(path) {
    return String(path || '').split('/').filter(Boolean);
  }

  // ── Helpers de blob (árvore inteira em fluxolab_state.data) ─────────
  async function blobLoad(blobKey) {
    const { data } = await supa.from('fluxolab_state').select('data').eq('key', blobKey).maybeSingle();
    return (data && data.data) || {};
  }
  async function blobSave(blobKey, obj) {
    await supa.from('fluxolab_state').upsert(
      { key: blobKey, data: obj, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  }
  function getIn(obj, p) { let c = obj; for (const k of p) { if (c == null) return undefined; c = c[k]; } return c; }
  function setIn(obj, p, val) {
    let c = obj;
    for (let i = 0; i < p.length - 1; i++) { const k = p[i]; if (typeof c[k] !== 'object' || c[k] === null) c[k] = {}; c = c[k]; }
    c[p[p.length - 1]] = val;
  }
  function delIn(obj, p) {
    let c = obj;
    for (let i = 0; i < p.length - 1; i++) { const k = p[i]; if (c[k] == null) return; c = c[k]; }
    delete c[p[p.length - 1]];
  }

  // ── Snapshot estilo Firebase ──────────────────────────────────────────
  function makeSnapshot(val, key) {
    return {
      val: () => (val === undefined ? null : val),
      exists: () => val !== undefined && val !== null,
      key: key || null,
      forEach(cb) {
        if (!val || typeof val !== 'object') return;
        for (const k of Object.keys(val)) cb(makeSnapshot(val[k], k));
      },
      child(k) { return makeSnapshot(val ? val[k] : undefined, k); },
    };
  }

  // ── Resolve config + sub-info para uma rota "rows" ─────────────────
  function resolveRows(cfg, p) {
    // dated: /history/{dateKey}[/{docId}]   |  normal: /root[/{id}]
    if (cfg.dated) {
      const dateKey = p[1];
      const docId = p[2];
      return { dateKey, id: docId, isCollection: docId === undefined };
    }
    const id = p[1];
    return { dateKey: null, id, isCollection: id === undefined };
  }

  async function rowsGet(cfg, p, filters) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    let q = supa.from(cfg.table).select('*');
    if (dateKey) q = q.eq('data_key', dateKey);
    if (filters) for (const f of filters) q = q.eq(f.field, f.value);
    if (!isCollection) {
      const { data } = await q.eq('id', id).maybeSingle();
      return data ? data.raw : null;
    }
    const { data } = await q;
    if (!data || !data.length) return null;
    const out = {};
    for (const row of data) out[row.id] = row.raw;
    return out;
  }

  async function rowsWriteOne(cfg, id, dateKey, value) {
    if (value === null || value === undefined) {
      let q = supa.from(cfg.table).delete().eq('id', id);
      if (dateKey) q = q.eq('data_key', dateKey);
      await q;
      return;
    }
    const row = { id, raw: value, ...mirrorCols(cfg.table, value) };
    if (dateKey) row.data_key = dateKey;
    await supa.from(cfg.table).upsert(row, { onConflict: 'id' });
  }

  async function rowsSet(cfg, p, value) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    if (!isCollection) return rowsWriteOne(cfg, id, dateKey, value);
    // substitui a coleção inteira (usado em restauração de backup)
    let delQ = supa.from(cfg.table).delete();
    delQ = dateKey ? delQ.eq('data_key', dateKey) : delQ.neq('id', '___never___');
    await delQ;
    const entries = Object.entries(value || {});
    if (!entries.length) return;
    const rows = entries.map(([cid, v]) => ({ id: cid, raw: v, ...(dateKey ? { data_key: dateKey } : {}), ...mirrorCols(cfg.table, v) }));
    await supa.from(cfg.table).upsert(rows, { onConflict: 'id' });
  }

  async function rowsUpdate(cfg, p, patch) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    if (!isCollection) {
      let q = supa.from(cfg.table).select('raw').eq('id', id);
      if (dateKey) q = q.eq('data_key', dateKey);
      const { data: cur } = await q.maybeSingle();
      const merged = { ...(cur ? cur.raw : {}) };
      for (const k in patch) { if (patch[k] === null) delete merged[k]; else merged[k] = patch[k]; }
      return rowsWriteOne(cfg, id, dateKey, merged);
    }
    // multi-location update: cada chave do patch é um filho que é substituído por completo
    for (const childId in patch) {
      await rowsWriteOne(cfg, childId, dateKey, patch[childId]);
    }
  }

  async function rowsRemove(cfg, p) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    if (!isCollection) return rowsWriteOne(cfg, id, dateKey, null);
    let q = supa.from(cfg.table).delete();
    q = dateKey ? q.eq('data_key', dateKey) : q.neq('id', '___never___');
    await q;
  }

  async function rowsPush(cfg, p, key, value) {
    const { dateKey } = resolveRows(cfg, p);
    await rowsWriteOne(cfg, key, dateKey, value);
    return key;
  }

  // ── Listener registry (para suportar .off) ──────────────────────────
  let _listenerSeq = 0;
  const _listeners = new Map();

  function rowsSubscribe(cfg, p, cb, filters) {
    const { dateKey } = resolveRows(cfg, p);
    const reload = async () => { cb(makeSnapshot(await rowsGet(cfg, p, filters))); };
    reload();
    const chanName = 'shim_' + cfg.table + '_' + (dateKey || 'all') + '_' + (++_listenerSeq);
    const filter = dateKey ? { event: '*', schema: 'public', table: cfg.table, filter: 'data_key=eq.' + dateKey } : { event: '*', schema: 'public', table: cfg.table };
    const channel = supa.channel(chanName).on('postgres_changes', filter, reload).subscribe();
    return channel;
  }

  function blobSubscribe(cfg, p, cb) {
    const reload = async () => { const blob = await blobLoad(cfg.blobKey); cb(makeSnapshot(getIn(blob, p.slice(1)))); };
    reload();
    const chanName = 'shim_blob_' + cfg.blobKey + '_' + (++_listenerSeq);
    const channel = supa.channel(chanName)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'fluxolab_state', filter: 'key=eq.' + cfg.blobKey }, reload)
      .subscribe();
    return channel;
  }

  // ── Objeto "ref" ──────────────────────────────────────────────────
  function ref(path) {
    const p = parts(path);
    const rootName = p[0];

    if (rootName === '.info' && p[1] === 'connected') {
      return {
        on(_evt, cb) { cb({ val: () => true }); return cb; },
        off() {},
      };
    }

    const cfg = ROOTS[rootName];
    if (!cfg) {
      console.warn('[firebase-compat-shim] caminho não mapeado:', path);
      // fallback inerte — não quebra o app, só não persiste nada
      return {
        push: async () => ({ key: genPushKey() }),
        set: async () => {}, update: async () => {}, remove: async () => {},
        once: async (_e, ok) => { const s = makeSnapshot(null); ok && ok(s); return s; },
        on: (_e, cb) => { cb(makeSnapshot(null)); return cb; },
        off: () => {}, child: (k) => ref(path + '/' + k),
      };
    }

    let _pendingField = null;
    const _filters = [];

    const self = {
      child(k) { return ref(path + '/' + k); },

      async set(value) {
        if (cfg.mode === 'blob') {
          const bp = p.slice(1);
          if (!bp.length) return blobSave(cfg.blobKey, value);
          const blob = await blobLoad(cfg.blobKey);
          setIn(blob, bp, value);
          return blobSave(cfg.blobKey, blob);
        }
        return rowsSet(cfg, p, value);
      },

      async update(patch) {
        if (cfg.mode === 'blob') {
          const bp = p.slice(1);
          const blob = await blobLoad(cfg.blobKey);
          const target = bp.length ? (getIn(blob, bp) || {}) : blob;
          for (const k in patch) { if (patch[k] === null) delete target[k]; else target[k] = patch[k]; }
          if (bp.length) setIn(blob, bp, target);
          return blobSave(cfg.blobKey, bp.length ? blob : target);
        }
        return rowsUpdate(cfg, p, patch);
      },

      async remove() {
        if (cfg.mode === 'blob') {
          const bp = p.slice(1);
          if (!bp.length) return blobSave(cfg.blobKey, {});
          const blob = await blobLoad(cfg.blobKey);
          delIn(blob, bp);
          return blobSave(cfg.blobKey, blob);
        }
        return rowsRemove(cfg, p);
      },

      push(value) {
        const key = genPushKey();
        const promise = (async () => {
          if (value !== undefined) {
            if (cfg.mode === 'blob') {
              const bp = p.slice(1);
              const blob = await blobLoad(cfg.blobKey);
              const coll = bp.length ? (getIn(blob, bp) || {}) : blob;
              coll[key] = value;
              if (bp.length) setIn(blob, bp, coll);
              await blobSave(cfg.blobKey, bp.length ? blob : coll);
            } else {
              await rowsPush(cfg, p, key, value);
            }
          }
          return { key };
        })();
        promise.key = key;
        return promise;
      },

      async once(_evt, onOk, onErr) {
        try {
          let val;
          if (cfg.mode === 'blob') {
            const blob = await blobLoad(cfg.blobKey);
            const bp = p.slice(1);
            val = bp.length ? getIn(blob, bp) : blob;
          } else {
            val = await rowsGet(cfg, p, _filters);
          }
          const snap = makeSnapshot(val);
          onOk && onOk(snap);
          return snap;
        } catch (e) {
          onErr && onErr(e);
          throw e;
        }
      },

      on(_evt, cb) {
        const channel = cfg.mode === 'blob' ? blobSubscribe(cfg, p, cb) : rowsSubscribe(cfg, p, cb, _filters);
        _listeners.set(cb, channel);
        return cb;
      },

      off(_evt, cb) {
        const channel = _listeners.get(cb);
        if (channel) { supa.removeChannel(channel); _listeners.delete(cb); }
      },

      orderByChild(field) { _pendingField = field; return self; },
      orderByKey() { return self; },
      orderByValue() { return self; },
      equalTo(value) {
        if (_pendingField) { _filters.push({ field: _pendingField, value }); _pendingField = null; }
        return self;
      },
      startAt() { return self; },
      endAt() { return self; },

      limitToLast(n) {
        // usado só em listas; aplicamos o corte no callback de leitura
        const origOn = self.on;
        return {
          ...self,
          on(evt, cb) {
            return origOn(evt, (snap) => {
              const val = snap.val();
              if (val && typeof val === 'object') {
                const entries = Object.entries(val);
                const sliced = entries.slice(-n);
                cb(makeSnapshot(Object.fromEntries(sliced)));
              } else cb(snap);
            });
          },
        };
      },
    };
    return self;
  }

  return { ref };
}
