// ════════════════════════════════════════════════════════════════════════
// SUPABASE → SUPABASE COMPAT SHIM
// Implementa a mesma API usada pelo app (_db.ref().push/set/update/remove/
// on('value')/once('value')/child()) mas gravando e lendo do Supabase.
// Não precisa alterar o resto do app.js — só a inicialização.
// ════════════════════════════════════════════════════════════════════════
function createSupabaseCompatShim(supa) {

  // ── OTIMIZAÇÃO: cache compartilhado por blobKey ─────────────────────
  // Elimina rajadas de GET /fluxolab_state?key=eq.<blobKey>:
  //  • Uma única leitura (blobLoad) é reaproveitada por TODOS os listeners
  //    e por todas as chamadas .once/.set/.push/.remove enquanto o cache
  //    estiver "fresco".
  //  • Toda subscrição via blobSubscribe atualiza o cache no evento
  //    Realtime — nesse modo o cache é fonte de verdade e nunca expira.
  //  • Sem subscrição ativa: fallback com TTL curto (2s) e coalescing
  //    de loads concorrentes pela mesma key (dedupe in-flight).
  const _blobCache = new Map();     // blobKey -> { data, ts, hasSub, loaded }
  const _blobInflight = new Map();  // blobKey -> Promise
  const BLOB_TTL_MS = 8000;

  function _blobCacheGet(blobKey) {
    const c = _blobCache.get(blobKey);
    if (!c) return undefined;
    // Só confia no cache "sem expiração" quando já houve uma carga real
    // (via blobLoad bem-sucedido ou evento Realtime). Sem isso, marcar
    // hasSub antes do primeiro load fazia o blobLoad devolver o valor
    // default vazio ({}) sem nunca consultar o Supabase — é por isso que
    // os bolsões do FluxoLAB apareciam vazios ao atualizar a página e só
    // voltavam quando chegava um evento Realtime (alguém movimentando algo).
    if (c.hasSub && c.loaded) return c.data;
    if (!c.hasSub && (Date.now() - c.ts <= BLOB_TTL_MS)) return c.data;
    return undefined;
  }
  function _blobCacheSet(blobKey, data, opts) {
    const prev = _blobCache.get(blobKey) || {};
    _blobCache.set(blobKey, {
      data: data || {},
      ts: Date.now(),
      hasSub: (opts && opts.hasSub) || prev.hasSub || false,
      loaded: true,
    });
  }
  function _blobCacheMarkSub(blobKey) {
    const prev = _blobCache.get(blobKey) || { data: {}, ts: 0, loaded: false };
    _blobCache.set(blobKey, { ...prev, hasSub: true });
  }


  // ── Mapa de "raízes" do antigo Supabase Realtime DB ───────────────────
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
    schedule_override:   { mode: 'blob', blobKey: 'schedule_override' },
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

  // ── Gerador de chave estilo "push key" do Supabase (ordenável por tempo) ──
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
    const cached = _blobCacheGet(blobKey);
    if (cached !== undefined) return cached;
    let inflight = _blobInflight.get(blobKey);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { data } = await supa.from('fluxolab_state').select('data').eq('key', blobKey).maybeSingle();
        const val = (data && data.data) || {};
        _blobCacheSet(blobKey, val);
        return val;
      } finally {
        _blobInflight.delete(blobKey);
      }
    })();
    _blobInflight.set(blobKey, inflight);
    return inflight;
  }
  async function blobSave(blobKey, obj) {
    _blobCacheSet(blobKey, obj);
    await supa.from('fluxolab_state').upsert(
      { key: blobKey, data: obj, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    pubBlob(blobKey, obj);
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

  // ── Snapshot estilo Supabase ──────────────────────────────────────────
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
    // OTIMIZAÇÃO: projeta apenas id+raw (evita trazer todas as colunas espelho).
    let q = supa.from(cfg.table).select('id,raw' + (dateKey ? ',date_key' : ''));
    if (dateKey) q = q.eq('date_key', dateKey);
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
      if (dateKey) q = q.eq('date_key', dateKey);
      const { error } = await q;
      if (error) throw error;
      pubRow(cfg.table, id, dateKey, 'del');
      return;
    }
    const row = { id, raw: value, ...mirrorCols(cfg.table, value) };
    if (dateKey) row.date_key = dateKey;
    const { error } = await supa.from(cfg.table).upsert(row, { onConflict: 'id' });
    if (error) throw error;
    pubRow(cfg.table, id, dateKey, 'set', { raw: value });
  }

  async function rowsSet(cfg, p, value) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    if (!isCollection) return rowsWriteOne(cfg, id, dateKey, value);
    // substitui a coleção inteira (usado em restauração de backup)
    let delQ = supa.from(cfg.table).delete();
    delQ = dateKey ? delQ.eq('date_key', dateKey) : delQ.neq('id', '___never___');
    await delQ;
    const entries = Object.entries(value || {});
    if (!entries.length) return;
    const rows = entries.map(([cid, v]) => ({ id: cid, raw: v, ...(dateKey ? { date_key: dateKey } : {}), ...mirrorCols(cfg.table, v) }));
    await supa.from(cfg.table).upsert(rows, { onConflict: 'id' });
    pubRowsReload(cfg.table, dateKey);
  }

  // OTIMIZAÇÃO E: coalescing de patches concorrentes por (tabela,id).
  // Vários update() chamados em sequência (mesmo tick / poucos ms) são
  // mesclados em UMA única RPC jsonb_patch_row. Elimina o "efeito rajada"
  // que causava 504 em cascata no gateway do Supabase.
  //
  // Também: sem retry em erro (retry sob 504 só piora a saturação; o próximo
  // save reenviará o estado consolidado) e SEM UPDATE mirror separado —
  // as colunas espelho (best-effort para queries externas) podem ficar
  // levemente atrasadas; a fonte de verdade é sempre a coluna `raw` que
  // o próprio RPC atualiza. Isso corta ~50% dos writes ao Supabase.
  const _pendingPatches = new Map(); // key: table|dateKey|id -> {merged, resolvers[], cfg, id, dateKey, scheduled}
  const COALESCE_MS = 800;

  function _flushPatch(bucketKey) {
    const bucket = _pendingPatches.get(bucketKey);
    if (!bucket) return;
    _pendingPatches.delete(bucketKey);
    const { cfg, id, dateKey, merged, resolvers, rejecters } = bucket;
    supa.rpc('jsonb_patch_row', {
      p_table: cfg.table,
      p_id: id,
      p_patch: merged,
      p_date_key: dateKey || null,
    }).then(({ error }) => {
      if (error) {
        // Não relança: sob 504/timeout, o próximo save reenvia o estado.
        console.warn('[shim] rowsUpdate falhou (patch descartado, próximo save reenvia):', cfg.table, id, error.message || error);
      }
      else pubRow(cfg.table, id, dateKey, 'patch', { patch: merged });
      resolvers.forEach(r => r());
    }).catch(err => {
      console.warn('[shim] rowsUpdate exceção:', cfg.table, id, err && err.message || err);
      resolvers.forEach(r => r()); // não propaga; UI continua fluindo
    });
  }

  async function rowsUpdate(cfg, p, patch) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    if (!isCollection) {
      if (!patch || typeof patch !== 'object' || !Object.keys(patch).length) return;
      const bucketKey = cfg.table + '|' + (dateKey || '') + '|' + id;
      let bucket = _pendingPatches.get(bucketKey);
      if (!bucket) {
        bucket = { cfg, id, dateKey, merged: {}, resolvers: [], rejecters: [], scheduled: false };
        _pendingPatches.set(bucketKey, bucket);
      }
      // Merge shallow (chaves posteriores sobrescrevem — comportamento do RPC).
      Object.assign(bucket.merged, patch);
      const done = new Promise(res => bucket.resolvers.push(res));
      if (!bucket.scheduled) {
        bucket.scheduled = true;
        setTimeout(() => _flushPatch(bucketKey), COALESCE_MS);
      }
      return done;
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
    q = dateKey ? q.eq('date_key', dateKey) : q.neq('id', '___never___');
    const { error } = await q;
    if (error) throw error;
    pubRowsReload(cfg.table, dateKey);
  }

  async function rowsPush(cfg, p, key, value) {
    const { dateKey } = resolveRows(cfg, p);
    await rowsWriteOne(cfg, key, dateKey, value);
    return key;
  }

  // ── Listener registry (para suportar .off) ──────────────────────────
  let _listenerSeq = 0;
  const _listeners = new Map();

  // ══════════════════════════════════════════════════════════════════
  // OTIMIZAÇÃO D: BUS DE BROADCAST (substitui postgres_changes)
  // ------------------------------------------------------------------
  // postgres_changes entrega TODA escrita da tabela para TODO cliente
  // com o canal aberto — o custo é (escritas × clientes) e não dá para
  // filtrar de verdade nas raízes sem coluna de filtro (operadores,
  // history sem date_key, logs...).
  //
  // Como 100% das escritas passam por este shim, publicamos o delta
  // num ÚNICO canal de broadcast por cliente ('shim_bus'). Resultado:
  //  • 1 canal Realtime por sessão (em vez de 6-8 multiplexados / 18-20 antes);
  //  • mensagens só em escrita real, com o delta já pronto (sem refetch);
  //  • fan-out local imediato para os listeners da própria aba.
  //
  // Rede de segurança para escritas fora do app (SQL editor, jobs):
  // reconciliação periódica (RECONCILE_MS) e ao voltar do modo pausado.
  // Para voltar ao modo antigo: USE_PG_CHANGES = true.
  // ══════════════════════════════════════════════════════════════════
  const USE_PG_CHANGES = false;
  const BUS_TOPIC = 'shim_bus';
  // Reconciliação periódica (rede de segurança caso um evento Realtime se perca).
  // Era 90s por assinatura; com ~13 assinaturas ativas isso sozinho gerava
  // centenas de requisições por dia em cada aba aberta. 180s + pausa quando a
  // aba está em segundo plano cortam esse tráfego pela metade ou mais, sem
  // perder consistência (o Realtime continua entregando as mudanças na hora).
  const RECONCILE_MS = 180000;
  const BLOB_BROADCAST_MAX = 120000; // acima disso manda "reload" em vez do JSON

  let _bus = null;
  const _busHandlers = new Set();

  function _busEnsure() {
    if (_bus) return _bus;
    _bus = supa.channel(BUS_TOPIC, { config: { broadcast: { self: false, ack: false } } })
      .on('broadcast', { event: 'mut' }, (msg) => _busDispatch(msg && msg.payload))
      .subscribe();
    return _bus;
  }

  function _busDispatch(ev) {
    if (!ev) return;
    _busHandlers.forEach((h) => {
      try { h(ev); } catch (e) { console.warn('[shim] bus handler erro:', e); }
    });
  }

  function busPublish(ev) {
    _busDispatch(ev); // fan-out local (broadcast self:false não volta pra origem)
    if (USE_PG_CHANGES) return;
    try { _busEnsure().send({ type: 'broadcast', event: 'mut', payload: ev }); }
    catch (e) { console.warn('[shim] bus publish falhou:', e); }
  }

  function pubRow(table, id, dateKey, op, extra) {
    busPublish(Object.assign({ k: 'row', t: table, id: id, dk: dateKey || null, op: op }, extra || {}));
  }
  function pubRowsReload(table, dateKey) {
    busPublish({ k: 'rows-reload', t: table, dk: dateKey || null });
  }
  function pubBlob(blobKey, data) {
    let payload;
    try { payload = JSON.stringify(data || {}); } catch (e) { payload = null; }
    if (payload && payload.length <= BLOB_BROADCAST_MAX) busPublish({ k: 'blob', key: blobKey, data: data || {} });
    else busPublish({ k: 'blob-reload', key: blobKey });
  }

  function busSubscribe(handler, resync) {
    _busEnsure();
    _busHandlers.add(handler);
    if (resync) _resyncs.add(resync);
    const timer = setInterval(() => {
      if (_paused || !resync) return;
      // Aba em segundo plano não precisa reconciliar: ao voltar ao foco o
      // handler de visibilitychange abaixo faz um resync imediato.
      if (typeof document !== 'undefined' && document.hidden) return;
      resync();
    }, RECONCILE_MS);
    if (typeof document !== 'undefined' && resync && !_visResyncBound) {
      _visResyncBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden || _paused) return;
        _resyncs.forEach(fn => { try { fn(); } catch (e) {} });
      });
    }
    return {
      release() {
        _busHandlers.delete(handler);
        if (resync) _resyncs.delete(resync);
        clearInterval(timer);
        if (_busHandlers.size === 0 && _bus) { supa.removeChannel(_bus); _bus = null; }
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  // OTIMIZAÇÃO C: MULTIPLEXAÇÃO DE CANAIS REALTIME
  // ------------------------------------------------------------------
  // Antes: cada .ref().on('value') abria UM canal próprio (~18-20 por
  // sessão). Agora, todas as assinaturas que apontam para a mesma
  // (tabela + filtro) compartilham UM ÚNICO canal. O fan-out passa a
  // ser feito localmente, em memória.
  //
  // Também pausa TODOS os canais quando a aba fica oculta por mais de
  // PAUSE_AFTER_MS, e re-sincroniza (refetch) ao voltar.
  // ══════════════════════════════════════════════════════════════════
  const _subs = new Map(); // subKey -> { pgFilter, handlers:Set, channel }
  const _resyncs = new Set(); // fns chamadas ao retomar do modo pausado
  let _visResyncBound = false;
  let _paused = false;

  function _openChannel(entry, subKey) {
    if (entry.channel) return;
    entry.channel = supa.channel('shim_mux_' + subKey + '_' + (++_listenerSeq))
      .on('postgres_changes', entry.pgFilter, (payload) => {
        entry.handlers.forEach((h) => {
          try { h(payload); } catch (e) { console.warn('[shim] handler erro:', e); }
        });
      })
      .subscribe();
  }

  function sharedSubscribe(pgFilter, handler, resync) {
    const subKey = [pgFilter.table, pgFilter.filter || '*'].join('|');
    let entry = _subs.get(subKey);
    if (!entry) {
      entry = { pgFilter, handlers: new Set(), channel: null };
      _subs.set(subKey, entry);
    }
    entry.handlers.add(handler);
    if (resync) _resyncs.add(resync);
    if (!_paused) _openChannel(entry, subKey);

    return {
      release() {
        entry.handlers.delete(handler);
        if (resync) _resyncs.delete(resync);
        if (entry.handlers.size === 0) {
          if (entry.channel) supa.removeChannel(entry.channel);
          _subs.delete(subKey);
        }
      },
    };
  }

  // ── Pausa quando a aba fica oculta (economiza mensagens por cliente) ──
  const PAUSE_AFTER_MS = 60000;
  let _pauseTimer = null;

  function _pauseAll() {
    if (_paused) return;
    _paused = true;
    _subs.forEach((entry) => {
      if (entry.channel) { supa.removeChannel(entry.channel); entry.channel = null; }
    });
    if (_bus) { supa.removeChannel(_bus); _bus = null; }
  }
  function _resumeAll() {
    if (!_paused) return;
    _paused = false;
    _blobCache.clear();
    _subs.forEach((entry, subKey) => _openChannel(entry, subKey));
    if (_busHandlers.size) _busEnsure();
    _resyncs.forEach((fn) => { try { fn(); } catch (e) {} });
  }

  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearTimeout(_pauseTimer);
        _pauseTimer = setTimeout(_pauseAll, PAUSE_AFTER_MS);
      } else {
        clearTimeout(_pauseTimer);
        _resumeAll();
      }
    });
  }


  // OTIMIZAÇÃO A: em vez de refazer SELECT * a cada evento, aplicamos o
  // delta do payload Realtime no cache local. Reduz drasticamente o
  // tráfego de GET /rest/v1/<tabela> (causa das rajadas 522/525).
  function rowsSubscribe(cfg, p, cb, filters) {
    const { dateKey, id, isCollection } = resolveRows(cfg, p);
    let cache = null;

    // Carrega estado inicial UMA VEZ.
    rowsGet(cfg, p, filters).then(v => {
      cache = isCollection ? (v || {}) : v;
      cb(makeSnapshot(cache));
    }).catch(err => console.warn('[shim] initial load falhou:', cfg.table, err));

    // Filtro server-side: se assinatura é de um único registro, filtra por id
    // (reduz eventos entregues ao cliente).
    let pgFilter;
    if (!isCollection) {
      pgFilter = { event: '*', schema: 'public', table: cfg.table, filter: 'id=eq.' + id };
    } else {
      const uidFilter = filters && filters.find(f => f.field === 'uid');
      if (uidFilter) {
        pgFilter = { event: '*', schema: 'public', table: cfg.table, filter: 'uid=eq.' + uidFilter.value };
      } else if (dateKey) {
        pgFilter = { event: '*', schema: 'public', table: cfg.table, filter: 'date_key=eq.' + dateKey };
      } else {
        pgFilter = { event: '*', schema: 'public', table: cfg.table };
      }
    }

    // Verifica filtros locais (orderByChild/equalTo) contra a coluna espelhada.
    const passesFilters = (raw) => {
      if (!filters || !filters.length) return true;
      if (!raw) return false;
      return filters.every(f => raw[f.field] === f.value);
    };

    const onPayload = (payload) => {
      try {
        if (isCollection) {
          if (cache == null) cache = {};
          const rowNew = payload.new || {};
          const rowOld = payload.old || {};
          const rid = rowNew.id || rowOld.id;
          if (!rid) return;
          if (payload.eventType === 'DELETE') {
            if (cache[rid] !== undefined) { delete cache[rid]; cb(makeSnapshot(cache)); }
            return;
          }
          const raw = rowNew.raw != null ? rowNew.raw : rowNew;
          if (!passesFilters(raw)) {
            if (cache[rid] !== undefined) { delete cache[rid]; cb(makeSnapshot(cache)); }
            return;
          }
          cache[rid] = raw;
          cb(makeSnapshot(cache));
        } else {
          if (payload.eventType === 'DELETE') { cache = null; cb(makeSnapshot(null)); return; }
          const raw = payload.new && payload.new.raw != null ? payload.new.raw : payload.new;
          cache = raw;
          cb(makeSnapshot(cache));
        }
      } catch(e) { console.warn('[shim] delta apply erro:', e); }
    };

    const resync = () => {
      rowsGet(cfg, p, filters).then(v => {
        cache = isCollection ? (v || {}) : v;
        cb(makeSnapshot(cache));
      }).catch(() => {});
    };

    // Bus: aplica o delta publicado pelo autor da escrita, sem refetch.
    const relevant = (ev) =>
      ev.t === cfg.table &&
      (dateKey ? ev.dk === dateKey : true) &&
      (isCollection ? true : ev.id === id);

    const onBus = (ev) => {
      try {
        if (ev.k === 'rows-reload') {
          if (ev.t === cfg.table && (!dateKey || ev.dk === dateKey)) resync();
          return;
        }
        if (ev.k !== 'row' || !relevant(ev)) return;
        if (isCollection) {
          if (cache == null) cache = {};
          if (ev.op === 'del') {
            if (cache[ev.id] !== undefined) { delete cache[ev.id]; cb(makeSnapshot(cache)); }
            return;
          }
          const raw = ev.op === 'patch'
            ? Object.assign({}, cache[ev.id] || {}, ev.patch)
            : ev.raw;
          if (!passesFilters(raw)) {
            if (cache[ev.id] !== undefined) { delete cache[ev.id]; cb(makeSnapshot(cache)); }
            return;
          }
          cache[ev.id] = raw;
          cb(makeSnapshot(cache));
        } else {
          if (ev.op === 'del') { cache = null; cb(makeSnapshot(null)); return; }
          cache = ev.op === 'patch' ? Object.assign({}, cache || {}, ev.patch) : ev.raw;
          cb(makeSnapshot(cache));
        }
      } catch (e) { console.warn('[shim] bus delta erro:', e); }
    };

    if (USE_PG_CHANGES) return sharedSubscribe(pgFilter, onPayload, resync);
    return busSubscribe(onBus, resync);
  }

  // Para blob (JSON inteiro em fluxolab_state) o payload NEW já traz o JSON
  // completo — evitamos o SELECT extra usando payload.new.data.
  function blobSubscribe(cfg, p, cb) {
    const bp = p.slice(1);
    _blobCacheMarkSub(cfg.blobKey);
    const emit = (blob) => cb(makeSnapshot(bp.length ? getIn(blob, bp) : blob));
    blobLoad(cfg.blobKey).then(emit).catch(err => console.warn('[shim] blob load falhou:', cfg.blobKey, err));
    const onPayload = (payload) => {
        try {
          if (payload.eventType === 'DELETE') {
            _blobCacheSet(cfg.blobKey, {}, { hasSub: true });
            emit({}); return;
          }
          const blob = (payload.new && payload.new.data) || {};
          _blobCacheSet(cfg.blobKey, blob, { hasSub: true });
          emit(blob);
        } catch(e) { console.warn('[shim] blob delta erro:', e); }
    };

    const resync = () => {
      _blobCache.delete(cfg.blobKey);           // força releitura real
      blobLoad(cfg.blobKey).then((b) => {
        _blobCacheSet(cfg.blobKey, b, { hasSub: true });
        emit(b);
      }).catch(() => {});
    };

    const onBus = (ev) => {
      if (!ev || ev.key !== cfg.blobKey) return;
      if (ev.k === 'blob') {
        _blobCacheSet(cfg.blobKey, ev.data || {}, { hasSub: true });
        emit(ev.data || {});
      } else if (ev.k === 'blob-reload') {
        resync();
      }
    };

    if (USE_PG_CHANGES) {
      return sharedSubscribe(
        { event: '*', schema: 'public', table: 'fluxolab_state', filter: 'key=eq.' + cfg.blobKey },
        onPayload,
        resync,
      );
    }
    return busSubscribe(onBus, resync);
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
      console.warn('[supabase-compat-shim] caminho não mapeado:', path);
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
          // Merge atômico dentro do Postgres — mesma razão do rowsUpdate acima:
          // evita perder chaves quando dois updates concorrentes acontecem
          // no mesmo nó/blob quase ao mesmo tempo.
          const bp = p.slice(1);
          const { error } = await supa.rpc('jsonb_patch_blob', {
            p_key: cfg.blobKey,
            p_path: bp,
            p_patch: patch,
          });
          if (error) throw error;
          // O RPC muda o JSON dentro do Postgres: recarrega uma vez (só no
          // autor da escrita) e publica o blob já consolidado no bus.
          _blobCache.delete(cfg.blobKey);
          try {
            const fresh = await blobLoad(cfg.blobKey);
            _blobCacheSet(cfg.blobKey, fresh, { hasSub: true });
            pubBlob(cfg.blobKey, fresh);
          } catch (e) { busPublish({ k: 'blob-reload', key: cfg.blobKey }); }
          return;
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
        const token = cfg.mode === 'blob' ? blobSubscribe(cfg, p, cb) : rowsSubscribe(cfg, p, cb, _filters);
        _listeners.set(cb, token);
        return cb;
      },

      off(_evt, cb) {
        const token = _listeners.get(cb);
        if (token) { token.release(); _listeners.delete(cb); }
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

  // ── Movimentação ATÔMICA de SELB no FluxoLAB ───────────────────────
  // Corrige a duplicação de SELB entre bolsões: mover/remover deixa de
  // ser um "ler blob inteiro -> editar no JS -> regravar blob inteiro"
  // (racy quando duas bipagens acontecem quase juntas) e passa a ser UMA
  // única operação atômica dentro do Postgres (fluxolab_move_selb /
  // fluxolab_remove_selb_everywhere — ver fluxolab_fix_duplicacao.sql),
  // que trava a linha do blob (SELECT ... FOR UPDATE) durante a troca.
  // Requer que as duas funções SQL tenham sido criadas no Supabase.
  // ── Guarda contra RPC inexistente (PGRST202 / 404) ──────────────────
  // Antes, cada bipagem tentava o RPC e recebia 404 do PostgREST, o que
  // inundava os logs (milhares de "POST 404 /rpc/...") e ainda pagava a
  // latência da ida ao servidor. Agora, ao detectar que a função não
  // existe, marcamos e passamos direto ao fallback local até a página
  // ser recarregada (depois de rodar fluxolab_fix_duplicacao.sql).
  const _rpcMissing = new Set();
  function _isMissingFnError(err) {
    if (!err) return false;
    const code = String(err.code || '');
    const msg  = String(err.message || '') + ' ' + String(err.details || '');
    return code === 'PGRST202' || code === '404' ||
           /could not find the function|does not exist|schema cache/i.test(msg);
  }
  async function _rpc(fnName, args) {
    if (_rpcMissing.has(fnName)) {
      const e = new Error('RPC ' + fnName + ' indisponível no banco (rode fluxolab_fix_duplicacao.sql)');
      e.code = 'PGRST202';
      throw e;
    }
    const { data, error } = await supa.rpc(fnName, args);
    if (error) {
      if (_isMissingFnError(error)) {
        _rpcMissing.add(fnName);
        console.warn('[shim] Função SQL ausente: ' + fnName + ' — rode fluxolab_fix_duplicacao.sql no Supabase. Usando fallback local até lá.');
      }
      throw error;
    }
    return data;
  }

  async function fluxolabMoveSelb(selbKey, destBolsao, record) {
    const data = await _rpc('fluxolab_move_selb', {
      p_key: 'fluxolab',
      p_selb_key: selbKey,
      p_dest_bolsao: destBolsao,
      p_record: record,
    });
    const blob = data || {};
    _blobCacheSet('fluxolab', blob, { hasSub: true });
    pubBlob('fluxolab', blob); // avisa outras abas/usuários em tempo real
    return blob;
  }

  async function fluxolabRemoveSelbEverywhere(selbKey) {
    const data = await _rpc('fluxolab_remove_selb_everywhere', {
      p_key: 'fluxolab',
      p_selb_key: selbKey,
    });
    const blob = data || {};
    _blobCacheSet('fluxolab', blob, { hasSub: true });
    pubBlob('fluxolab', blob);
    return blob;
  }

  // ── VARREDURA: remove SELB duplicado entre bolsões (mantém o mais novo) ──
  // Uma única transação no Postgres (fluxolab_dedupe_selbs).
  async function fluxolabDedupeSelbs() {
    const data = await _rpc('fluxolab_dedupe_selbs', { p_key: 'fluxolab' });
    const res  = data || {};
    const blob = res.data || {};
    _blobCacheSet('fluxolab', blob, { hasSub: true });
    pubBlob('fluxolab', blob);
    return { data: blob, removidos: res.removidos || [] };
  }

  return {
    ref,
    fluxolabMoveSelb,
    fluxolabRemoveSelbEverywhere,
    fluxolabDedupeSelbs,
    // Diagnóstico: quantos canais Realtime estão realmente abertos.
    _debugChannels() {
      return { modo: USE_PG_CHANGES ? 'postgres_changes' : 'broadcast-bus',
        bus: _bus ? 1 : 0, ouvintesBus: _busHandlers.size,
        canais: (_bus ? 1 : 0) + _subs.size, pausado: _paused,
        detalhe: Array.from(_subs.entries()).map(([k, v]) => ({ key: k, ouvintes: v.handlers.size })) };
    },
  };
}
