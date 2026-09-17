// ════════════════════════════════════════════════════════════════
// PENDÊNCIAS COMPLEXAS — VISUALIZAÇÃO PARA OPERADOR
// ────────────────────────────────────────────────────────────────
// • Botão flutuante (ícone ⚙️) na tela do operador — abre modal read-only
// • Painel no Admin p/ liberar quais operadores veem a tabela
// • Sincroniza em tempo real com a mesma key do Supabase:
//   fluxolab_state.key = 'pendencias_mistas_complexas' (campo .complexas)
// • Nenhuma edição, drag, ou botão limpar — somente visualização.
// ════════════════════════════════════════════════════════════════
(function(){

  // ───────────────── ESTADO INTERNO ─────────────────
  let _pvState = { complexas: [] };
  let _pvLoaded = false;
  let _pvChannel = null;
  let _pvBtnEl = null;
  let _pvModalEl = null;
  let _pvAdminPanelEl = null;

  // ───────────────── DADOS ─────────────────
  async function pvLoad(){
    if (typeof _supa === 'undefined') return;
    try {
      const {data} = await _supa.from('fluxolab_state')
        .select('data').eq('key','pendencias_mistas_complexas').maybeSingle();
      if (data && data.data && Array.isArray(data.data.complexas)) {
        _pvState.complexas = data.data.complexas;
      }
    } catch(e){ console.error('[pvc] load', e); }

    // Carrega o view state (filtros, ordenação, colunas) do Supabase
    try {
      const { data: vsData } = await _supa.from('fluxolab_state')
        .select('data').eq('key','pendencias_view_state').maybeSingle();
      if (vsData && vsData.data && typeof pendApplyViewState === 'function') {
        pendApplyViewState(vsData.data);
      }
    } catch(e){ console.warn('[pvc] view state load failed', e); }

    if (!_pvChannel) {
      _pvChannel = true;
      window._fluxolabStateOn('pendencias_mistas_complexas', payload => {
        if (payload.new && payload.new.data && Array.isArray(payload.new.data.complexas)) {
          _pvState.complexas = payload.new.data.complexas;
          if (_pvModalEl && _pvModalEl.style.display === 'flex') pvRenderModalTable();
        }
      });
      window._fluxolabStateOn('pendencias_view_state', payload => {
        // Aplica o novo estado de filtros/ordenação nas variáveis globais
        if (payload.new && payload.new.data && typeof pendApplyViewState === 'function') {
          pendApplyViewState(payload.new.data);
        }
        if (_pvModalEl && _pvModalEl.style.display === 'flex') {
          setTimeout(() => pvRenderModalTable(), 50);
        }
      });
    }
    _pvLoaded = true;
  }

  // ───────────────── BOTÃO FLUTUANTE (OPERADOR) ─────────────────
  function pvEnsureButton(){
    if (_pvBtnEl) return;
    const btn = document.createElement('button');
    btn.id = 'pvc-op-btn';
    btn.title = 'Ver Pendências Complexas';
    btn.innerHTML = '⚙️';
    btn.style.cssText = `
      display:none;position:fixed;right:22px;bottom:88px;z-index:400;
      width:56px;height:56px;border-radius:50%;border:1px solid rgba(244,114,182,.55);
      background:linear-gradient(145deg,rgba(244,114,182,.18),rgba(244,114,182,.05));
      color:#f472b6;font-size:26px;cursor:pointer;
      box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 20px rgba(244,114,182,.25);
      transition:transform .15s, box-shadow .2s;`;
    btn.onmouseenter = ()=>{ btn.style.transform='scale(1.08)'; btn.style.boxShadow='0 10px 28px rgba(0,0,0,.55),0 0 28px rgba(244,114,182,.45)'; };
    btn.onmouseleave = ()=>{ btn.style.transform='scale(1)'; btn.style.boxShadow='0 8px 24px rgba(0,0,0,.45),0 0 20px rgba(244,114,182,.25)'; };
    btn.onclick = pvOpenModal;
    document.body.appendChild(btn);
    _pvBtnEl = btn;
  }

  function pvSyncButtonVisibility(){
    pvEnsureButton();
    const view = document.getElementById('view-operador');
    const isOnOpView = view && view.classList.contains('active');
    let flag = false;
    if (typeof currentUser !== 'undefined' && currentUser) {
      const live = (typeof users !== 'undefined')
        ? users.find(u => u.id === currentUser.id) : null;
      flag = !!(live ? live.verPendenciasComplexas : currentUser.verPendenciasComplexas);
    }
    _pvBtnEl.style.display = (isOnOpView && flag) ? 'flex' : 'none';
    _pvBtnEl.style.alignItems = 'center';
    _pvBtnEl.style.justifyContent = 'center';
  }

  // ───────────────── MODAL READ-ONLY ─────────────────
  function pvEnsureModal(){
    if (_pvModalEl) return;
    const m = document.createElement('div');
    m.id = 'pvc-modal';
    m.style.cssText = `
      display:none;position:fixed;inset:0;z-index:750;background:rgba(0,0,0,.78);
      align-items:center;justify-content:center;padding:24px;
      backdrop-filter:blur(4px)`;
    m.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
                  width:95vw;max-width:95vw;max-height:92vh;overflow:hidden;
                  display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.6)">
        <div style="padding:18px 22px;border-bottom:1px solid var(--border);flex-shrink:0;
                    display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="background:rgba(244,114,182,.15);border:1px solid rgba(244,114,182,.4);
                        padding:8px;border-radius:10px;font-size:20px;line-height:1">⚙️</div>
            <div>
              <div style="font-size:16px;font-weight:900;color:var(--text);letter-spacing:-.01em">
                Pendências Complexas
                <span style="font-size:9px;background:rgba(74,222,128,.15);color:#4ade80;
                             padding:2px 7px;border-radius:6px;margin-left:6px;
                             letter-spacing:.05em;font-weight:800">SOMENTE LEITURA</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">
                Atualiza automaticamente conforme o admin edita a lista.
              </div>
            </div>
          </div>
          <button id="pvc-modal-close" style="background:transparent;border:1px solid var(--border2);
                    color:var(--muted);width:36px;height:36px;border-radius:8px;cursor:pointer;
                    font-size:18px;line-height:1;flex-shrink:0">✕</button>
        </div>
        <div id="pvc-modal-body" style="overflow:auto;padding:16px 20px;flex:1;min-height:0"></div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#pvc-modal-close').onclick = pvCloseModal;
    m.addEventListener('click', e => { if (e.target === m) pvCloseModal(); });
    _pvModalEl = m;
  }

  async function pvOpenModal(){
    pvEnsureModal();
    _pvModalEl.style.display = 'flex';
    if (!_pvLoaded) await pvLoad();
    pvRenderModalTable();
  }
  function pvCloseModal(){ if (_pvModalEl) _pvModalEl.style.display = 'none'; }

  function pvRenderModalTable(){
    const body = document.getElementById('pvc-modal-body');
    if (!body) return;
    
    if (typeof fluxolabRenderPendTable === 'function') {
      body.innerHTML = fluxolabRenderPendTable('Pendências Complexas', 'complexas', '#f472b6', '#f472b6');
      // Make the entire table read-only for operators, while allowing scroll on the wrapper
      const tableWrapper = body.querySelector('div');
      if (tableWrapper) {
        tableWrapper.style.pointerEvents = 'none';
      }
    } else {
      body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Erro: fluxolabRenderPendTable não carregado.</div>';
    }
  }

  // ───────────────── PAINEL ADMIN — PERMISSÕES ─────────────────
  function pvEnsureAdminPanel(){
    if (_pvAdminPanelEl) return;
    const host = document.getElementById('view-admin');
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.id = 'pvc-admin-panel';
    wrap.style.cssText = `
      margin:24px 0;background:var(--bg2);border:1px solid rgba(244,114,182,.3);
      border-radius:14px;padding:18px 22px;box-shadow:0 4px 16px rgba(0,0,0,.15)`;
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="background:rgba(244,114,182,.15);border:1px solid rgba(244,114,182,.4);
                      padding:8px;border-radius:10px;font-size:18px;line-height:1">⚙️</div>
          <div>
            <div style="font-size:14px;font-weight:900;color:var(--text)">Acesso a Pendências Complexas</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              Marque os operadores que poderão abrir a visualização (somente leitura) na tela deles.
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="pvc-adm-search" placeholder="🔍 Filtrar…" style="
            background:var(--bg3);border:1px solid var(--border2);border-radius:8px;
            color:var(--text);font-family:var(--font);font-size:12px;padding:7px 12px;
            outline:none;width:180px" />
          <button id="pvc-adm-none" style="background:var(--bg3);border:1px solid var(--border2);
            border-radius:8px;color:var(--muted);font-size:11px;font-weight:700;
            padding:7px 12px;cursor:pointer">Nenhum</button>
          <button id="pvc-adm-all" style="background:rgba(244,114,182,.15);border:1px solid rgba(244,114,182,.4);
            border-radius:8px;color:#f472b6;font-size:11px;font-weight:800;
            padding:7px 12px;cursor:pointer">Todos</button>
        </div>
      </div>
      <div id="pvc-adm-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;max-height:340px;overflow-y:auto;padding-right:4px"></div>`;

    host.appendChild(wrap);
    _pvAdminPanelEl = wrap;

    wrap.querySelector('#pvc-adm-search').addEventListener('input', pvRenderAdminList);
    wrap.querySelector('#pvc-adm-all').addEventListener('click', ()=>pvBulkSet(true));
    wrap.querySelector('#pvc-adm-none').addEventListener('click', ()=>pvBulkSet(false));
  }

  function pvRenderAdminList(){
    const grid = document.getElementById('pvc-adm-grid');
    if (!grid || typeof users === 'undefined') return;
    const q = (document.getElementById('pvc-adm-search')?.value || '').trim().toLowerCase();
    const list = users
      .filter(u => !u.isAdmin && !u.hidden)
      .filter(u => !q || (u.name||'').toLowerCase().includes(q) || (u.sector||'').toLowerCase().includes(q))
      .sort((a,b) => (a.name||'').localeCompare(b.name||''));

    if (!list.length){
      grid.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px;grid-column:1/-1;text-align:center">Nenhum operador encontrado.</div>`;
      return;
    }

    grid.innerHTML = list.map(u => {
      const checked = u.verPendenciasComplexas ? 'checked' : '';
      return `
        <label class="pvc-adm-row" data-uid="${u.id}" style="
          display:flex;align-items:center;gap:10px;padding:9px 12px;
          background:var(--bg3);border:1px solid var(--border);border-radius:9px;
          cursor:pointer;transition:all .15s"
          onmouseover="this.style.borderColor='rgba(244,114,182,.4)'"
          onmouseout="this.style.borderColor='var(--border)'">
          <input type="checkbox" ${checked} style="width:16px;height:16px;accent-color:#f472b6;cursor:pointer" />
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${(u.name||'—').replace(/[<>&]/g,'')}
            </div>
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-top:1px">
              ${u.sector||'—'}
            </div>
          </div>
        </label>`;
    }).join('');

    grid.querySelectorAll('.pvc-adm-row').forEach(row => {
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => pvTogglePerm(row.dataset.uid, cb.checked));
    });
  }

  async function pvTogglePerm(uid, val){
    const u = users.find(x => x.id === uid);
    if (!u) return;
    u.verPendenciasComplexas = !!val;
    try {
      if (typeof dbSaveUser === 'function') await dbSaveUser(u);
      if (typeof toast === 'function') toast(val ? 'Acesso liberado' : 'Acesso removido');
    } catch(e){
      u.verPendenciasComplexas = !val;
      alert('Erro ao salvar: ' + e.message);
      pvRenderAdminList();
    }
  }

  async function pvBulkSet(val){
    if (!confirm(val ? 'Liberar acesso a TODOS os operadores?' : 'Remover acesso de TODOS?')) return;
    const targets = users.filter(u => !u.isAdmin && !u.hidden && !!u.verPendenciasComplexas !== !!val);
    for (const u of targets){
      u.verPendenciasComplexas = !!val;
      try { if (typeof dbSaveUser === 'function') await dbSaveUser(u); } catch(e){}
    }
    pvRenderAdminList();
    if (typeof toast === 'function') toast(`${targets.length} operador(es) atualizado(s)`);
  }

  // ───────────────── BOOTSTRAP ─────────────────
  function pvSyncAdminPanelVisibility(){
    if (typeof currentUser === 'undefined' || !currentUser) return;
    if (!currentUser.isAdmin) return;
    pvEnsureAdminPanel();
    if (_pvAdminPanelEl) pvRenderAdminList();
  }

  function pvBoot(){
    if (typeof _supa === 'undefined' || typeof users === 'undefined'){
      return setTimeout(pvBoot, 500);
    }
    if (typeof currentUser !== 'undefined' && currentUser) {
      pvLoad();
    }
    pvEnsureButton();

    setInterval(() => {
      try {
        if (typeof currentUser !== 'undefined' && currentUser) {
          if (!_pvLoaded) {
            pvLoad();
          }
        } else {
          if (_pvLoaded) {
            _pvLoaded = false;
            _pvChannel = null;
          }
        }
        pvSyncButtonVisibility();
        pvSyncAdminPanelVisibility();
      } catch(e){}
    }, 5000);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', pvBoot);
  } else {
    pvBoot();
  }

  window.pvOpenPendComplexas = pvOpenModal;
})();
