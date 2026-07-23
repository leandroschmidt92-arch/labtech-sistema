// ════════════════════════════════════════════════════════════════
// PENDÊNCIAS MISTAS — VISUALIZAÇÃO PARA OPERADOR
// ────────────────────────────────────────────────────────────────
// • Botão flutuante (ícone 🧩) na tela do operador — abre modal read-only
// • Painel no Admin p/ liberar quais operadores veem a tabela
// • Sincroniza em tempo real com a mesma key do Supabase:
//   fluxolab_state.key = 'pendencias_mistas_complexas'
// • Nenhuma edição, drag, ou botão limpar — somente visualização.
// ════════════════════════════════════════════════════════════════
(function(){

  // ───────────────── ESTADO INTERNO ─────────────────
  let _pvState = { mistas: [] };
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
      if (data && data.data && Array.isArray(data.data.mistas)) {
        _pvState.mistas = data.data.mistas;
      }
    } catch(e){ console.error('[pv] load', e); }

    if (!_pvChannel) {
      _pvChannel = _supa.channel('pendencias_viewer_sync')
        .on('postgres_changes',
          { event:'*', schema:'public', table:'fluxolab_state',
            filter:"key=eq.pendencias_mistas_complexas" },
          payload => {
            if (payload.new && payload.new.data && Array.isArray(payload.new.data.mistas)) {
              _pvState.mistas = payload.new.data.mistas;
              if (_pvModalEl && _pvModalEl.style.display === 'flex') pvRenderModalTable();
            }
          }).subscribe();
    }
    _pvLoaded = true;
  }

  // ───────────────── BOTÃO FLUTUANTE (OPERADOR) ─────────────────
  function pvEnsureButton(){
    if (_pvBtnEl) return;
    const btn = document.createElement('button');
    btn.id = 'pv-op-btn';
    btn.title = 'Ver Pendências Mistas';
    btn.innerHTML = '🧩';
    btn.style.cssText = `
      display:none;position:fixed;right:22px;bottom:22px;z-index:400;
      width:56px;height:56px;border-radius:50%;border:1px solid rgba(251,191,36,.55);
      background:linear-gradient(145deg,rgba(251,191,36,.18),rgba(251,191,36,.05));
      color:#fbbf24;font-size:26px;cursor:pointer;
      box-shadow:0 8px 24px rgba(0,0,0,.45),0 0 20px rgba(251,191,36,.25);
      transition:transform .15s, box-shadow .2s;`;
    btn.onmouseenter = ()=>{ btn.style.transform='scale(1.08)'; btn.style.boxShadow='0 10px 28px rgba(0,0,0,.55),0 0 28px rgba(251,191,36,.45)'; };
    btn.onmouseleave = ()=>{ btn.style.transform='scale(1)'; btn.style.boxShadow='0 8px 24px rgba(0,0,0,.45),0 0 20px rgba(251,191,36,.25)'; };
    btn.onclick = pvOpenModal;
    document.body.appendChild(btn);
    _pvBtnEl = btn;
  }

  function pvSyncButtonVisibility(){
    pvEnsureButton();
    const view = document.getElementById('view-operador');
    const isOnOpView = view && view.classList.contains('active');
    // Busca a versão mais recente do usuário na lista sincronizada
    let flag = false;
    if (typeof currentUser !== 'undefined' && currentUser) {
      const live = (typeof users !== 'undefined')
        ? users.find(u => u.id === currentUser.id) : null;
      flag = !!(live ? live.verPendenciasMistas : currentUser.verPendenciasMistas);
    }
    _pvBtnEl.style.display = (isOnOpView && flag) ? 'flex' : 'none';
    _pvBtnEl.style.alignItems = 'center';
    _pvBtnEl.style.justifyContent = 'center';
  }

  // ───────────────── MODAL READ-ONLY ─────────────────
  function pvEnsureModal(){
    if (_pvModalEl) return;
    const m = document.createElement('div');
    m.id = 'pv-modal';
    m.style.cssText = `
      display:none;position:fixed;inset:0;z-index:750;background:rgba(0,0,0,.78);
      align-items:center;justify-content:center;padding:24px;
      backdrop-filter:blur(4px)`;
    m.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:18px;
                  width:100%;max-width:1200px;max-height:90vh;overflow:hidden;
                  display:flex;flex-direction:column;box-shadow:0 30px 80px rgba(0,0,0,.6)">
        <div style="padding:18px 22px;border-bottom:1px solid var(--border);
                    display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);
                        padding:8px;border-radius:10px;font-size:20px;line-height:1">🧩</div>
            <div>
              <div style="font-size:16px;font-weight:900;color:var(--text);letter-spacing:-.01em">
                Pendências Mistas
                <span style="font-size:9px;background:rgba(74,222,128,.15);color:#4ade80;
                             padding:2px 7px;border-radius:6px;margin-left:6px;
                             letter-spacing:.05em;font-weight:800">SOMENTE LEITURA</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">
                Atualiza automaticamente conforme o admin edita a lista.
              </div>
            </div>
          </div>
          <button id="pv-modal-close" style="background:transparent;border:1px solid var(--border2);
                    color:var(--muted);width:36px;height:36px;border-radius:8px;cursor:pointer;
                    font-size:18px;line-height:1">✕</button>
        </div>
        <div id="pv-modal-body" style="overflow:auto;padding:16px 20px;flex:1"></div>
      </div>`;
    document.body.appendChild(m);
    m.querySelector('#pv-modal-close').onclick = pvCloseModal;
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
    const body = document.getElementById('pv-modal-body');
    if (!body) return;
    const rows = (_pvState.mistas || []).filter(r => r && r.modelo);
    let totalDoca=0, totalLab=0, totalChk=0;
    rows.forEach(r => {
      if (typeof fluxolabPlanGetBolsaoStats === 'function'){
        const b = fluxolabPlanGetBolsaoStats(r.modelo); totalDoca += b.doca||0; totalLab += b.lab||0;
      }
      if (typeof fluxolabPlanGetChecklistStats === 'function'){
        totalChk += (fluxolabPlanGetChecklistStats(r.modelo).count || 0);
      }
    });

    if (!rows.length){
      body.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
        <div style="font-size:44px;margin-bottom:10px;opacity:.5">📭</div>
        <div style="font-size:14px;font-weight:600">Nenhuma pendência mista cadastrada no momento.</div>
      </div>`;
      return;
    }

    const th = 'padding:10px 8px;font-size:10px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border2);background:rgba(0,0,0,.35);text-align:center;white-space:nowrap';
    const td = 'padding:10px 8px;border-bottom:1px solid var(--border);vertical-align:middle;text-align:center';

    let html = `
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <div style="background:rgba(74,222,128,.12);border:1px solid rgba(74,222,128,.35);
                    border-radius:8px;padding:8px 14px;font-size:12px;font-weight:800;color:#4ade80">
          Checklists: ${totalChk}</div>
        <div style="background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.3);
                    border-radius:8px;padding:8px 14px;font-size:12px;font-weight:800;color:#22d3ee">
          DOCA: ${totalDoca}</div>
        <div style="background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.3);
                    border-radius:8px;padding:8px 14px;font-size:12px;font-weight:800;color:#a78bfa">
          LAB: ${totalLab}</div>
        <div style="flex:1"></div>
        <div style="font-size:11px;color:var(--muted);align-self:center">${rows.length} registro(s)</div>
      </div>
      <div style="overflow-x:auto;border:1px solid var(--border2);border-radius:12px;background:rgba(0,0,0,.2)">
      <table style="width:100%;border-collapse:collapse;font-family:var(--font);font-size:14px">
        <thead><tr>
          <th style="${th}">Ord</th>
          <th style="${th}">Lote</th>
          <th style="${th};text-align:left;padding-left:14px">Modelo</th>
          <th style="${th}">Checklists</th>
          <th style="${th}">Média Dias</th>
          <th style="${th}">Qtd WMS</th>
          <th style="${th}">Sugerido</th>
          <th style="${th}">DOCA</th>
          <th style="${th}">LAB</th>
          <th style="${th};text-align:left">Observação</th>
          <th style="${th};text-align:left">Peças</th>
        </tr></thead><tbody>`;

    rows.forEach((r, i) => {
      const chk = (typeof fluxolabPlanGetChecklistStats === 'function')
        ? fluxolabPlanGetChecklistStats(r.modelo) : {count:0, media:0};
      const bol = (typeof fluxolabPlanGetBolsaoStats === 'function')
        ? fluxolabPlanGetBolsaoStats(r.modelo) : {doca:0, lab:0};
      const bg = i % 2 === 0 ? 'rgba(255,255,255,.015)' : 'transparent';
      const badge = chk.count > 0
        ? `<span style="background:rgba(74,222,128,.15);color:#4ade80;font-size:9px;font-weight:800;padding:2px 6px;border-radius:8px;margin-left:8px;letter-spacing:.03em">✓</span>`
        : `<span style="background:rgba(248,113,113,.15);color:#f87171;font-size:9px;font-weight:800;padding:2px 6px;border-radius:8px;margin-left:8px;letter-spacing:.03em">✗</span>`;
      const esc = s => String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      html += `
        <tr style="background:${bg}">
          <td style="${td};color:var(--muted);font-weight:800;font-size:15px">${i+1}º</td>
          <td style="${td};color:var(--muted);font-weight:800;font-size:15px">${i+1}</td>
          <td style="${td};text-align:left;padding-left:14px;color:#fbbf24;font-weight:800;font-size:14px">
            ${esc(r.modelo)}${badge}
          </td>
          <td style="${td};color:${chk.count>0?'#4ade80':'var(--muted)'};font-weight:900;font-size:18px">${chk.count||'-'}</td>
          <td style="${td};color:var(--text);font-weight:900;font-size:18px">${chk.media||'-'}</td>
          <td style="${td};color:var(--text);font-weight:800;font-size:18px">${esc(r.qtd_wms)||'-'}</td>
          <td style="${td};color:var(--accent);font-weight:800;font-size:18px">${esc(r.sugestao)||'-'}</td>
          <td style="${td};color:#22d3ee;font-weight:900;font-size:18px;background:rgba(34,211,238,.05)">${bol.doca||'-'}</td>
          <td style="${td};color:#a78bfa;font-weight:900;font-size:18px;background:rgba(167,139,250,.05)">${bol.lab||'-'}</td>
          <td style="${td};text-align:left;color:var(--text);font-weight:500;text-transform:uppercase;font-size:12px">${esc(r.obs)||'—'}</td>
          <td style="${td};text-align:left;color:var(--text);font-weight:500;text-transform:uppercase;font-size:12px">${esc(r.pecas)||'—'}</td>
        </tr>`;
    });
    html += `</tbody></table></div>`;
    body.innerHTML = html;
  }

  // ───────────────── PAINEL ADMIN — PERMISSÕES ─────────────────
  function pvEnsureAdminPanel(){
    if (_pvAdminPanelEl) return;
    const host = document.getElementById('view-admin');
    if (!host) return;

    const wrap = document.createElement('div');
    wrap.id = 'pv-admin-panel';
    wrap.style.cssText = `
      margin:24px 0;background:var(--bg2);border:1px solid rgba(251,191,36,.3);
      border-radius:14px;padding:18px 22px;box-shadow:0 4px 16px rgba(0,0,0,.15)`;
    wrap.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);
                      padding:8px;border-radius:10px;font-size:18px;line-height:1">🧩</div>
          <div>
            <div style="font-size:14px;font-weight:900;color:var(--text)">Acesso a Pendências Mistas</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">
              Marque os operadores que poderão abrir a visualização (somente leitura) na tela deles.
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="pv-adm-search" placeholder="🔍 Filtrar…" style="
            background:var(--bg3);border:1px solid var(--border2);border-radius:8px;
            color:var(--text);font-family:var(--font);font-size:12px;padding:7px 12px;
            outline:none;width:180px" />
          <button id="pv-adm-none" style="background:var(--bg3);border:1px solid var(--border2);
            border-radius:8px;color:var(--muted);font-size:11px;font-weight:700;
            padding:7px 12px;cursor:pointer">Nenhum</button>
          <button id="pv-adm-all" style="background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.4);
            border-radius:8px;color:#fbbf24;font-size:11px;font-weight:800;
            padding:7px 12px;cursor:pointer">Todos</button>
        </div>
      </div>
      <div id="pv-adm-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;max-height:340px;overflow-y:auto;padding-right:4px"></div>`;

    host.appendChild(wrap);
    _pvAdminPanelEl = wrap;

    wrap.querySelector('#pv-adm-search').addEventListener('input', pvRenderAdminList);
    wrap.querySelector('#pv-adm-all').addEventListener('click', ()=>pvBulkSet(true));
    wrap.querySelector('#pv-adm-none').addEventListener('click', ()=>pvBulkSet(false));
  }

  function pvRenderAdminList(){
    const grid = document.getElementById('pv-adm-grid');
    if (!grid || typeof users === 'undefined') return;
    const q = (document.getElementById('pv-adm-search')?.value || '').trim().toLowerCase();
    const list = users
      .filter(u => !u.isAdmin && !u.hidden)
      .filter(u => !q || (u.name||'').toLowerCase().includes(q) || (u.sector||'').toLowerCase().includes(q))
      .sort((a,b) => (a.name||'').localeCompare(b.name||''));

    if (!list.length){
      grid.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:20px;grid-column:1/-1;text-align:center">Nenhum operador encontrado.</div>`;
      return;
    }

    grid.innerHTML = list.map(u => {
      const checked = u.verPendenciasMistas ? 'checked' : '';
      return `
        <label class="pv-adm-row" data-uid="${u.id}" style="
          display:flex;align-items:center;gap:10px;padding:9px 12px;
          background:var(--bg3);border:1px solid var(--border);border-radius:9px;
          cursor:pointer;transition:all .15s"
          onmouseover="this.style.borderColor='rgba(251,191,36,.4)'"
          onmouseout="this.style.borderColor='var(--border)'">
          <input type="checkbox" ${checked} style="width:16px;height:16px;accent-color:#fbbf24;cursor:pointer" />
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

    grid.querySelectorAll('.pv-adm-row').forEach(row => {
      const cb = row.querySelector('input');
      cb.addEventListener('change', () => pvTogglePerm(row.dataset.uid, cb.checked));
    });
  }

  async function pvTogglePerm(uid, val){
    const u = users.find(x => x.id === uid);
    if (!u) return;
    u.verPendenciasMistas = !!val;
    try {
      if (typeof dbSaveUser === 'function') await dbSaveUser(u);
      if (typeof toast === 'function') toast(val ? 'Acesso liberado' : 'Acesso removido');
    } catch(e){
      u.verPendenciasMistas = !val;
      alert('Erro ao salvar: ' + e.message);
      pvRenderAdminList();
    }
  }

  async function pvBulkSet(val){
    if (!confirm(val ? 'Liberar acesso a TODOS os operadores?' : 'Remover acesso de TODOS?')) return;
    const targets = users.filter(u => !u.isAdmin && !u.hidden && !!u.verPendenciasMistas !== !!val);
    for (const u of targets){
      u.verPendenciasMistas = !!val;
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
    // Aguarda o Supabase e o app estarem carregados
    if (typeof _supa === 'undefined' || typeof users === 'undefined'){
      return setTimeout(pvBoot, 500);
    }
    if (typeof currentUser !== 'undefined' && currentUser) {
      pvLoad();
    }
    pvEnsureButton();

    // Polling leve: sincroniza visibilidade do botão + lista admin + estado de conexão
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
    }, 1500);
  }

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', pvBoot);
  } else {
    pvBoot();
  }

  // Expor para debug se precisar
  window.pvOpenPendMistas = pvOpenModal;
})();
