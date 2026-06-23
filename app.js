// ── Detecção de DevTools aberto ──
(function(){
  const threshold = 160;
  let devOpen = false;
  function check(){
    const isMobile = /Mobi|Android|iPhone/i.test(navigator.userAgent) || window.innerWidth < 800;
    const w = window.outerWidth - window.innerWidth > threshold;
    // No mobile, o teclado virtual altera a altura drasticamente, disparando falso positivo
    const h = !isMobile && (window.outerHeight - window.innerHeight > threshold);
    
    if((w || h) && !devOpen){
      devOpen = true;
      if(typeof currentUser !== 'undefined' && currentUser && !currentUser.isAdmin){
        // Operador comum com DevTools aberto — faz logout silencioso
        if(typeof logout === 'function') logout();
      }
    }
    if(!w && !h) devOpen = false;
  }
  setInterval(check, 1000);

  // Bloqueia atalhos de DevTools
  document.addEventListener('keydown', function(e){
    // F12
    if(e.key === 'F12'){ e.preventDefault(); return false; }
    // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C
    if(e.ctrlKey && e.shiftKey && (e.key==='I'||e.key==='i'||e.key==='J'||e.key==='j'||e.key==='C'||e.key==='c')){
      e.preventDefault(); return false;
    }
    // Ctrl+U (view source)
    if(e.ctrlKey && (e.key==='U'||e.key==='u')){ e.preventDefault(); return false; }
  }, true);

  // Bloqueia menu de contexto (botão direito)
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); return false; });
})();

// ════════════════════════════════════════
// SEGURANÇA — Bloqueio de acesso via teclado antes do login
// Impede navegação Tab/Enter para elementos do app layer sem autenticação.
// ════════════════════════════════════════
(function(){
  // Desabilita tabindex de todos os elementos do app enquanto não logado
  function lockAppFocus(){
    const appLayer = document.getElementById('layer-app');
    if(!appLayer) return;
    appLayer.querySelectorAll('button, input, select, textarea, a, [tabindex]').forEach(el => {
      el.setAttribute('data-prev-tabindex', el.getAttribute('tabindex') || '');
      el.setAttribute('tabindex', '-1');
    });
    appLayer.setAttribute('aria-hidden', 'true');
    appLayer.inert = true; // bloqueia completamente foco e interação
  }

  function unlockAppFocus(){
    const appLayer = document.getElementById('layer-app');
    if(!appLayer) return;
    appLayer.querySelectorAll('[data-prev-tabindex]').forEach(el => {
      const prev = el.getAttribute('data-prev-tabindex');
      if(prev === '') el.removeAttribute('tabindex');
      else el.setAttribute('tabindex', prev);
      el.removeAttribute('data-prev-tabindex');
    });
    appLayer.removeAttribute('aria-hidden');
    appLayer.inert = false;
  }

  // Bloqueia Tab e Enter enquanto a tela de login estiver visível
  document.addEventListener('keydown', function(e){
    const loginLayer = document.getElementById('layer-login');
    const appLayer   = document.getElementById('layer-app');
    if(!loginLayer || !appLayer) return;

    const loginVisible = !loginLayer.classList.contains('hidden');
    const appVisible   = appLayer.classList.contains('visible');

    // Se login está visível e app não está ativo: bloqueia Tab/Shift+Tab
    if(loginVisible && !appVisible){
      if(e.key === 'Tab'){
        // Permite Tab apenas dentro do próprio login layer
        const focused = document.activeElement;
        const inLogin = loginLayer.contains(focused);
        if(!inLogin){
          e.preventDefault();
          // Foca o primeiro elemento do login (display do PIN)
          const first = loginLayer.querySelector('button:not([disabled]), input:not([disabled])');
          if(first) first.focus();
        }
      }
      // Bloqueia Enter em qualquer elemento fora do loginLayer
      if(e.key === 'Enter'){
        const focused = document.activeElement;
        if(!loginLayer.contains(focused)){
          e.preventDefault();
        }
      }
    }
  }, true);

  // Aplica bloqueio assim que o DOM estiver pronto
  document.addEventListener('DOMContentLoaded', function(){
    lockAppFocus();

    // Intercepta loginAs para desbloquear o foco após autenticação
    const _origLoginAs = window.loginAs;
    // Hook via polling — loginAs é definida mais adiante no script
    const _hookInterval = setInterval(function(){
      if(typeof loginAs === 'function' && loginAs !== window.__loginAsHooked){
        window.__loginAsHooked = loginAs;
        const _origFn = loginAs;
        window.loginAs = function(){
          const result = _origFn.apply(this, arguments);
          unlockAppFocus();
          return result;
        };
        const _origLogout = window.logout;
        if(typeof logout === 'function'){
          window.logout = function(){
            const r = _origLogout.apply(this, arguments);
            lockAppFocus();
            return r;
          };
        }
        clearInterval(_hookInterval);
      }
    }, 50);
  });
})();

// ════════════════════════════════════════════════════════════════
// FLUXOLAB — Log de Movimentações
// Registra cada entrada/saída/movimentação de SELB nos bolsões
// Firebase path: /fluxolab_log/{pushKey} = { selb, de, para, user, ts, equipamento }
// ════════════════════════════════════════════════════════════════

let _fluxolabMovLog = []; // cache em memória (máx. 200 entradas)
let _fluxolabLogListener = null;

function _fluxolabLogEntry(selb, de, para, equipamento) {
  const entry = {
    selb:       selb || '?',
    de:         de   || '—',
    para:       para || '—',
    user:       currentUser ? currentUser.name : 'Sistema',
    ts:         Date.now(),
    equipamento: equipamento || (typeof getEquipName === 'function' ? getEquipName(selb) : '') || '',
  };
  // Push para Firebase com retry em caso de falha
  _db.ref('/fluxolab_log').push(entry).catch(err => {
    console.warn('[FluxoLAB Log] Falha ao salvar entrada no Firebase:', err);
  });
  // Insere no cache local no topo (garante visibilidade imediata mesmo antes do Firebase responder)
  _fluxolabMovLog.unshift(entry);
  if (_fluxolabMovLog.length > 500) _fluxolabMovLog.length = 500;
  // Atualiza badge do botão com contador de novas entradas
  _fluxolabLogUpdateBadge();
  // Atualiza painel se estiver aberto
  _fluxolabRenderLog();
}

// Contador de entradas novas desde última abertura do log
let _fluxolabLogUnread = 0;
// Timestamp da última vez que o painel foi aberto (para contar novas entradas corretamente)
let _fluxolabLogLastOpenTs = 0;
function _fluxolabLogUpdateBadge() {
  const panel = document.getElementById('fluxolab-log-panel');
  const isOpen = panel && panel.style.display !== 'none';
  if (!isOpen) {
    _fluxolabLogUnread++;
    const badge = document.getElementById('fluxolab-log-badge');
    if (badge) {
      badge.style.display = 'block';
      badge.textContent = _fluxolabLogUnread > 99 ? '99+' : _fluxolabLogUnread;
    }
  }
}

function fluxolabStartLogListener() {
  if (_fluxolabLogListener) return;
  // Carrega os últimos 500 registros ordenados por ts desc
  _fluxolabLogListener = _db.ref('/fluxolab_log')
    .orderByChild('ts')
    .limitToLast(500)
    .on('value', snap => {
      if (!snap.exists()) { _fluxolabMovLog = []; _fluxolabRenderLog(); return; }
      const arr = [];
      snap.forEach(child => arr.push(child.val()));
      // Ordena mais recente primeiro
      arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // Merge: mantém entradas locais recentes que ainda não chegaram ao Firebase
      // (push assíncrono pode não ter completado antes do listener disparar)
      const firebaseKeys = new Set(arr.map(e => String(e.ts) + '|' + e.selb));
      const localOnly = _fluxolabMovLog.filter(e => !firebaseKeys.has(String(e.ts) + '|' + e.selb));
      _fluxolabMovLog = [...localOnly, ...arr].sort((a, b) => (b.ts || 0) - (a.ts || 0));
      if (_fluxolabMovLog.length > 500) _fluxolabMovLog.length = 500;
      _fluxolabRenderLog();
    }, err => console.warn('[FluxoLAB Log]', err));
}

function fluxolabToggleLog() {
  const panel = document.getElementById('fluxolab-log-panel');
  const btn   = document.getElementById('btn-fluxolab-log');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'flex';
  if (btn) {
    btn.style.background = isOpen ? 'var(--bg3)' : 'rgba(34,211,238,.18)';
    btn.style.borderColor = isOpen ? 'var(--border2)' : 'rgba(34,211,238,.5)';
    btn.style.color = isOpen ? 'var(--muted)' : '#22d3ee';
  }
  if (!isOpen) {
    // Zera badge de não-lidos
    _fluxolabLogUnread = 0;
    const badge = document.getElementById('fluxolab-log-badge');
    if (badge) badge.style.display = 'none';
    fluxolabStartLogListener();
    _fluxolabRenderLog();
  }
}

function _fluxolabRenderLog() {
  const list = document.getElementById('fluxolab-log-list');
  if (!list || document.getElementById('fluxolab-log-panel')?.style.display === 'none') return;

  if (!_fluxolabMovLog.length) {
    list.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:12px;padding:20px 0">Nenhuma movimentação registrada</div>';
    return;
  }

  list.innerHTML = _fluxolabMovLog.map(entry => {
    const bDe   = FLUXOLAB_BOLSOES.find(b => b.key === entry.de);
    const bPara = FLUXOLAB_BOLSOES.find(b => b.key === entry.para);
    const deLabel   = bDe   ? bDe.icon + ' ' + bDe.label   : (entry.de   === '—' ? '—' : entry.de);
    const paraLabel = bPara ? bPara.icon + ' ' + bPara.label : (entry.para === '—' ? 'Removido' : entry.para);
    const deColor   = bDe   ? bDe.color   : 'var(--muted)';
    const paraColor = bPara ? bPara.color : 'var(--danger)';
    const timeStr   = entry.ts ? new Date(entry.ts).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '—';
    const equipShort = entry.equipamento ? entry.equipamento.replace(/MULTIFUNCIONAL\s*/i,'MF ').replace(/IMPRESSORA\s*/i,'IMP ') : '';

    return `<div style="
      padding:10px 12px;border-bottom:1px solid var(--border);
      display:flex;flex-direction:column;gap:4px;
      transition:background .1s;cursor:default;
    " onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
        <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:var(--accent)">${entry.selb}</span>
        <span style="font-size:10px;color:var(--muted);white-space:nowrap">${timeStr}</span>
      </div>
      ${equipShort ? `<div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${equipShort}</div>` : ''}
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:10px;font-weight:600;color:${deColor}">${deLabel}</span>
        <span style="font-size:11px;color:var(--muted)">→</span>
        <span style="font-size:10px;font-weight:600;color:${paraColor}">${paraLabel}</span>
      </div>
      <div style="font-size:10px;color:var(--muted)">por ${entry.user || '?'}</div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════
// FIREBASE — SDK compat (funciona em file://, HTTP e HTTPS)
// ════════════════════════════════════════
const _fbConfig = (function(){
  const _a = ['AIzaSyAVeYLHd','mBEjYUitYI-f7','FCykV80XynguY'].join('');
  const _b = ['sistema-selbe','tti.firebase','app.com'].join('');
  const _c = ['https://sistema-s','elbetti-default-r','tdb.firebaseio.com'].join('');
  const _d = ['sistema','-selbetti'].join('');
  const _e = ['sistema-selbe','tti.firebase','storage.app'].join('');
  const _f = ['38596','3162','199'].join('');
  const _g = ['1:38596316219','9:web:004f8a758','8beabcc090112'].join('');
  return { apiKey:_a, authDomain:_b, databaseURL:_c, projectId:_d, storageBucket:_e, messagingSenderId:_f, appId:_g };
})();
firebase.initializeApp(_fbConfig);
const _db = firebase.database();
window._db = _db; // exposto globalmente para os patches de integração

// ── Supabase client ──────────────────────────────────────────────────
const _SB_URL = 'https://wpawjyqjrzzleojzejuw.supabase.co';
const _SB_KEY = 'sb_publishable__E3zdLreHCt3sQ0GYPe3vA_I8DLW5PLdpuVL7xfvFVA'; // publishable key
const _supa   = window.supabase.createClient(_SB_URL, _SB_KEY);
// ────────────────────────────────────────────────────────────────────

// publishNewVersion removida por segurança

let _connected = false;
_db.ref('.info/connected').on('value', snap => {
  _connected = snap.val() === true;
  const dot = document.getElementById('status-dot');
  if(dot) dot.style.background = _connected ? 'var(--accent2)' : 'var(--warn)';
});

// SDK helpers — protegidos contra uso direto via console
const _dbGuard = () => {
  if(typeof currentUser === 'undefined') throw new Error('Não autorizado');
  if(!_connected) throw new Error('Sem conexão com o servidor. Aguarde...');
};
async function dbGet(path){
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    _db.ref(path).once('value',
      snap => { clearTimeout(timer); resolve(snap.exists() ? snap.val() : null); },
      err  => { clearTimeout(timer); resolve(null); }
    );
  });
}
async function dbSet(path, data){
  _dbGuard();
  await _db.ref(path).set(data); return data;
}
async function dbPush(path, data){
  _dbGuard();
  const ref = await _db.ref(path).push(data); return ref.key;
}
async function dbPatch(path, data){
  _dbGuard();
  // Remove undefined values to prevent Firebase errors
  const clean = {};
  for(const k in data) if(data[k] !== undefined) clean[k] = data[k];
  await _db.ref(path).update(clean);
  return clean;
}
async function dbDelete(path){
  _dbGuard();
  await _db.ref(path).remove();
}

// ════════════════════════════════════════
// REALTIME SYNC — Firebase onValue listeners
// Fonte de verdade: Firebase Realtime Database.
// Tempo NUNCA é armazenado como contador — sempre calculado de _startEpoch.
// ════════════════════════════════════════
let _usersListener   = null;
let _historyListener = null;
let _dashboardZerado = false; // quando true, listener não repopula history[]

let _historyReady    = false;

function applyUserSnapshot(freshUsers){
  if (!freshUsers || !Array.isArray(freshUsers)) {
    console.warn('[Sanity Check] applyUserSnapshot: freshUsers inválido', freshUsers);
    return;
  }
  freshUsers.forEach(fu => {
    const idx = users.findIndex(u => u.id === fu.id);
    if(idx === -1){
      users.push(fu);
    } else {
      const local = users[idx];
      // totalDia não é mais sincronizado do Firebase — calculado ao vivo pelo history[]
      // repDia ainda é mantido no Firebase para persistir entre sessões
      const fbRep  = fu.repDia || 0;
      const fbTs   = fu._lastWriteTs || 0;
      const locTs  = local._lastWriteTs || 0;
      fu.repDia = (fbTs >= locTs) ? fbRep : Math.max(fbRep, local.repDia || 0);
      if(fbTs < locTs) fu._lastWriteTs = locTs;
      users[idx] = fu;
    }
  });
  users = users.filter(u => freshUsers.find(fu => fu.id === u.id));

  // ── Sync wstate a partir do Firebase ──
  users.forEach(fu => {
    const s      = getS(fu.id);
    const status = fu._status || null;

    // SELBs de dias anteriores são mantidos — o operador finaliza normalmente.
    // Não há reset por data de epoch.

    if(status === 'running'){
      s.status     = 'running';
      s.selb       = fu._selb || s.selb || null;
      const hRun   = history.find(h => h.uid === fu.id && h.status === 'running');
      s.startEpoch = (hRun && hRun.startEpoch) || fu._startEpoch || s.startEpoch || null;
      s.meta       = 60;
      
      // Sanitização de data: se _activeFrom é de um dia anterior, recalcula o congelado e retoma hoje
      const now = Date.now();
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      let activeFrom = fu._activeFrom || Date.now();
      let frozen = fu._frozenElapsed || 0;

      if(activeFrom < todayStart.getTime()){
        // Estava rodando em dia anterior — queima o tempo acumulado até o fim do expediente daquele dia
        // e retoma do início do expediente de hoje (ou agora, o que for menor)
        frozen += calcLiquidDuration(activeFrom, now);
        activeFrom = Math.max(todayStart.getTime() + (SCHEDULE.work.start[0]*3600 + SCHEDULE.work.start[1]*60)*1000, now);
        // Garante que o Firebase também seja atualizado para evitar re-processamento
        dbPatch('/users/'+fu.id, {_activeFrom: activeFrom, _frozenElapsed: frozen}).catch(()=>{});
      }

      // ── Protege o timer local do operador logado contra sobrescrita do Firebase ──
      // Se este usuário é o operador logado e o timer local já está rodando de forma
      // consistente, preserva _activeFrom e _frozenElapsed locais para evitar saltos visuais.
      // O Firebase é fonte de verdade para outros usuários (cards do admin/dashboard).
      const isOwnSession = currentUser && !currentUser.isAdmin && currentUser.id === fu.id;
      const localIsRunning = s._activeFrom != null && s._activeFrom > 0;
      if(isOwnSession && localIsRunning){
        // Mantém estado local — apenas reseta acumuladores de pausa
        s._pauseAccum = 0; s._pausedAt = null;
      } else {
        s._frozenElapsed = frozen;
        s._activeFrom    = activeFrom;
        s._pauseAccum = 0; s._pausedAt = null;
      }

    } else if(status === 'paused'){
      s.status     = 'paused';
      s.selb       = fu._selb || s.selb || null;
      const hPaus  = history.find(h => h.uid === fu.id && h.status === 'running');
      s.startEpoch = (hPaus && hPaus.startEpoch) || fu._startEpoch || s.startEpoch || null;
      s.meta       = 60;
      // Congelado: _frozenElapsed tem o valor do timer, _activeFrom = null
      // Se _frozenElapsed não existe (SELB legado), inicia em 0 — o timer vai mostrar 0
      // enquanto pausado, o que é melhor do que mostrar 87h
      s._frozenElapsed = (fu._frozenElapsed != null) ? fu._frozenElapsed : (s._frozenElapsed || 0);
      s._activeFrom    = null;
      s._pauseAccum = 0; s._pausedAt = null;

    } else {
      s.status         = 'idle';
      s.selb           = null;
      s.startEpoch     = null;
      s.elapsed        = 0;
      s.pausedElapsed  = 0;
      s._pausedAt      = null;
    }
  });

  if(currentUser) rebuildOrUpdateCards();

  // Reinicia timers para SELBs em andamento (necessário após reload de página)
  users.forEach(u => {
    const s = getS(u.id);
    if(s.status === 'running' && s.startEpoch && !timers[u.id]){
      startTimer(u.id);
    }
  });

  // SELBs running de qualquer dia são mantidos — o operador finaliza normalmente.
  // Não há limpeza automática de orphans para não interferir com máquinas em andamento.
}

function rebuildOrUpdateCards(){
  const grid = document.getElementById('cards-grid');
  if(!grid) return;
  const visibleUsers = users.filter(u => u.active && !u.hidden && u.sector === activeSector);

  Array.from(grid.children).forEach(el => {
    const uid = el.id.replace('card-','');
    if(!visibleUsers.find(u => u.id === uid)) el.remove();
  });

  visibleUsers.forEach(u => {
    if(!document.getElementById('card-'+u.id)){
      const d = document.createElement('div');
      d.id = 'card-'+u.id;
      grid.appendChild(d);
    }
    renderCard(u.id);
  });

  updateSummary();
}

let _syncRunning = false;
function startRealtimeSync(){
  // Evita múltiplos listeners simultâneos — desconecta o anterior antes de reconectar
  if(_syncRunning){
    // Desconecta listeners existentes antes de recriar
    if(_usersListener)   _db.ref('/users').off('value', _usersListener);
    if(_historyListener){
      const hRef = window['_hRef_'+(new Date().toDateString().replace(/ /g,'_').slice(0,4))];
      if(hRef) hRef.off('value', _historyListener);
    }
    _usersListener = null;
    _historyListener = null;
  }
  _syncRunning = true;
  let dateKey = new Date().toDateString().replace(/ /g,'_');

  function attachHistoryListener(dk){
    if(_historyListener) _db.ref('/history/'+dateKey).off('value', _historyListener);
    dateKey = dk;
    const ref = _db.ref('/history/'+dk);
    window['_hRef_'+dk.slice(0,4)] = ref; // referência ofuscada para desconectar
    _historyListener = ref.on('value', snap => {
      if(snap.exists()){
        const allRecs = Object.entries(snap.val())
          .map(([k,v]) => ({...v, _docId:k, _dateKey:dk}))
          .sort((a,b) => (b.startEpoch||0) - (a.startEpoch||0));

        // Preserva registros de dias anteriores ainda relevantes:
        // - 'running'/'paused': operador ainda não finalizou
        // - 'ok' de dia anterior cujo endEpoch é de hoje (SELB que cruzou meia-noite)
        const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
        const prevRelevant = history.filter(h => {
          if(h._dateKey === dk) return false; // já vem no snapshot de hoje
          if(h.status === 'running' || h.status === 'paused' || h.status === 'aguardando') return true;
          // ok de dia anterior finalizado hoje (via endEpoch ou end < start)
          if(h.status === 'ok'){
            if(h.endEpoch && h.endEpoch >= todayStart) return true;
            if(!h.endEpoch && h.end && h.start){
              const eS = timeStrToSec(h.end);
              const sS = timeStrToSec(h.start);
              if(eS !== null && sS !== null && eS < sS) return true; // cruzou meia-noite
              if(h.startEpoch && eS !== null){
                const endDate = new Date(h.startEpoch);
                endDate.setHours(Math.floor(eS/3600), Math.floor((eS%3600)/60), eS%60, 0);
                if(endDate.getTime() <= h.startEpoch) endDate.setDate(endDate.getDate()+1);
                if(endDate.getTime() >= todayStart) return true;
              }
            }
          }
          return false;
        });
        history = [...prevRelevant, ...allRecs];

        // Atualiza registros de hoje no range sem descartar outros dias
        const todayDk4 = new Date().toDateString().replace(/ /g,'_');
        if(!_consultaDateKey){
          _consultaDateKey = todayDk4;
          _consultaRecords = allRecs;
        } else {
          _consultaRecords = [
            ..._consultaRecords.filter(r => r._dateKey !== todayDk4),
            ...allRecs
          ].sort((a,b)=>(b.startEpoch||0)-(a.startEpoch||0));
        }
      } else {
        const todayDk3 = new Date().toDateString().replace(/ /g,'_');
        if(dk === todayDk3 && history.length === 0) history = [];
      }
      _historyReady = true;
      if(currentUser){
        updateSummary();
        if(!currentUser.isAdmin && document.getElementById('view-operador').classList.contains('active')){
          opRenderHistory(currentUser.id);
        }
        if(document.getElementById('view-consulta').classList.contains('active')) renderConsulta();
        if(document.getElementById('view-qualidade').classList.contains('active')) renderQualidade();
        if(document.getElementById('view-pecas').classList.contains('active')) renderPecasView();
        if(document.getElementById('view-relatorios').classList.contains('active')) showRelRefreshBadge();
      }
    });
  }

  attachHistoryListener(dateKey);

  // Reconecta listener na virada da meia-noite
  setInterval(() => {
    const newKey = new Date().toDateString().replace(/ /g,'_');
    if(newKey !== dateKey){
      attachHistoryListener(newKey);
      checkDayReset();
      _autoBackupDone = false; // reset para backup automático do novo dia
    }
  }, 30000);

  // ── Users listener ──────────────────────────────────────────────────────────
  if(_usersListener) _db.ref('/users').off('value', _usersListener);
  _usersListener = _db.ref('/users').on('value', snap => {
    if(!snap.exists()){
      if(users.length === 0){
        DEFAULT_USERS.forEach(u => _db.ref('/users').push(u).catch(()=>{}));
      }
      return;
    }
    const freshUsers = Object.entries(snap.val()).map(([k,v]) => ({...v, id:k}));
    // Protege startEpoch de writes parciais do Firebase:
    // Se o snapshot chega sem _startEpoch mas o wstate local já tem um válido
    // e o usuário ainda está running → preserva o startEpoch local
    freshUsers.forEach(fu => {
      const s = wstate[fu.id];
      if(s && s.status === 'running' && s.startEpoch && !fu._startEpoch){
        fu._startEpoch = s.startEpoch; // protege contra snapshot parcial
      }
    });
    // Sempre atualiza users[] independente do estado do boot
    freshUsers.forEach(fu => {
      const idx = users.findIndex(u => u.id === fu.id);
      if(idx === -1) users.push(fu);
      else users[idx] = fu;
    });
    users = users.filter(u => freshUsers.find(fu => fu.id === u.id));

    if(currentUser){
      applyUserSnapshot(freshUsers);
      updateSummary();
      // Se o operador logado está na tela dedicada, re-renderiza estado
      if(!currentUser.isAdmin && document.getElementById('view-operador').classList.contains('active')){
        opRenderState(currentUser.id);
      }
      if(document.getElementById('view-relatorios').classList.contains('active')){
        showRelRefreshBadge();
      }
    } else {
      // Na tela de login — libera o numpad e limpa mensagem de espera
      setPinLoading(false);
    }
  }, err => console.warn('Users listener error:', err));

  // ── Listener de Celebrações Globais ────────────────────────────────────────
  if(window._celebrationListener) _db.ref('/meta/latestCelebration').off('value', window._celebrationListener);
  window._celebrationListener = _db.ref('/meta/latestCelebration').on('value', snap => {
    const data = snap.val();
    if(!data || !data.timestamp) return;
    
    // Evita disparar celebrações antigas no carregamento inicial
    const now = Date.now();
    if(now - data.timestamp > 30000) return; // ignora se tiver mais de 30s
    
    // Evita disparar a mesma celebração múltiplas vezes localmente
    if(window._lastCelebrationTs === data.timestamp) return;
    window._lastCelebrationTs = data.timestamp;

    // Dispara o efeito visual e sonoro em todas as telas
    if(typeof playCelebration === 'function'){
      playCelebration(data.uid);
    }
  });
}

// ════════════════════════════════════════
// DATA
// ════════════════════════════════════════
// Admin credentials managed via Firebase Authentication (email/password)

const DEFAULT_USERS=[
  {name:'Angel Romero',           pin:'43',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Augusto Rosa',           pin:'23',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Eduardo Saldanha',       pin:'11',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Idenilson Voigt',        pin:'33',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Joao Gama',              pin:'69',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Ricardo Silva Zezinho',  pin:'29',code:'',local:'',sector:'MONTAGEM',active:true,totalDia:0,repDia:0},
  {name:'Ana Telles',             pin:'14',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Cristiana Coelho',       pin:'41',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Gustavo Gazzola',        pin:'09',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Guilherme Harger',       pin:'04',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Henrique Marques Soares',pin:'01',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Angelo Gabriel',         pin:'90',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Victor Cunha',           pin:'15',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Gabriel Briesemeister',  pin:'02',code:'',local:'',sector:'LIMPEZA', active:true,totalDia:0,repDia:0},
  {name:'Adilson Hermmes',        pin:'36',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Hélio Venturi',          pin:'71',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Jean Blachechen',        pin:'89',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Jhoan Medina',           pin:'98',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Luis Oliveira',          pin:'28',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Nadison Marinho',        pin:'00',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Rubens Miyamoto',        pin:'19',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
  {name:'Jackson Deretti',        pin:'20',code:'',local:'',sector:'COMPLEXA',active:true,totalDia:0,repDia:0},
];

let users=[];
let history=[];

// ── Plugin Chart.js: rótulos ao redor das fatias de pizza ──
const outsideLabelsPlugin = {
  id: 'outsideLabels',
  afterDatasetsDraw(chart){
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    if(!meta || !meta.data || !meta.data.length) return;
    const ds = chart.data.datasets[0];
    const labels = chart.data.labels || [];
    const total = ds.data.reduce((a,b)=>a+(Number(b)||0),0) || 1;
    ctx.save();
    ctx.font = '600 11px system-ui, -apple-system, sans-serif';
    meta.data.forEach((arc, i)=>{
      const v = Number(ds.data[i])||0;
      if(!v) return;
      const p = arc.getProps(['x','y','startAngle','endAngle','outerRadius'], true);
      const mid = (p.startAngle + p.endAngle)/2;
      const cos = Math.cos(mid), sin = Math.sin(mid);
      const x1 = p.x + cos*p.outerRadius;
      const y1 = p.y + sin*p.outerRadius;
      const x2 = p.x + cos*(p.outerRadius+14);
      const y2 = p.y + sin*(p.outerRadius+14);
      const right = cos >= 0;
      const x3 = x2 + (right?10:-10);
      const color = (Array.isArray(ds.backgroundColor)?ds.backgroundColor[i]:ds.backgroundColor) || '#888';
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x1,y1);
      ctx.lineTo(x2,y2);
      ctx.lineTo(x3,y2);
      ctx.stroke();
      const pct = Math.round((v/total)*100);
      const text = `${labels[i]||''}: ${v} (${pct}%)`;
      ctx.textAlign = right ? 'left' : 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#0b0d14';
      [-1,1].forEach(dx=>[-1,1].forEach(dy=>ctx.fillText(text, x3+(right?4:-4)+dx, y2+dy)));
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(text, x3 + (right?4:-4), y2);
    });
    ctx.restore();
  }
};
let wstate={};
let timers={};
let currentUser=null;
let _mspLista=[]; // lista temporária de peças no modal

// Sobrescreve toString de arrays sensíveis para não exibir no console
Object.defineProperty(users, 'toJSON', { value: () => '[protected]', writable:false });
let activeSector='MONTAGEM';
let cFilter='', admFilter='';
let editingId=null, deletingId=null, actionUid=null;

// ════ ÚTIL ════
function calcAverage(arr, accessor = null, precision = 0) {
  if (!arr || !Array.isArray(arr) || arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const val = accessor ? accessor(arr[i]) : arr[i];
    sum += (Number(val) || 0);
  }
  const avg = sum / arr.length;
  if (precision > 0) {
    const factor = Math.pow(10, precision);
    return Math.round(avg * factor) / factor;
  }
  return Math.round(avg);
}

// ════ DB helpers ════
async function dbSaveUser(u){
  const {id,...data}=u;
  if(!id) return;
  // Strip ALL internal runtime fields — these are managed exclusively via dbPatch
  const {_status, _selb, _startEpoch, _elapsed, _pausedElapsed, _pausedAt, ...safeData} = data;
  // Never write undefined/null over numeric counters — use 0 as floor
  if(safeData.totalDia == null) safeData.totalDia = 0;
  if(safeData.repDia   == null) safeData.repDia   = 0;
  await dbPatch('/users/'+id, safeData);
}
async function dbAddUser(u){
  return await dbPush('/users', u);
}
async function dbDeleteUser(id){ await dbDelete('/users/'+id); }
// ── Redefinir reconhecimento facial de um usuário ─────────────────────────
async function resetFacialUser(uid, name) {
  if (!confirm(`Apagar o reconhecimento facial de ${name}?\nO usuário precisará recadastrar o rosto na próxima vez que fizer login pela câmera.`)) return;
  try {
    // Remove todos os campos que diferentes versões do face-auth.js possam usar
    const patch = {
      faceDescriptor: null,
      face_descriptor: null,
      faceData: null,
      faceVector: null,
      facePrint: null,
    };
    await dbPatch('/users/' + uid, patch);
    // Atualiza objeto local
    const u = users.find(x => x.id === uid);
    if (u) {
      delete u.faceDescriptor;
      delete u.face_descriptor;
      delete u.faceData;
      delete u.faceVector;
      delete u.facePrint;
    }
    renderUsers();
    showToast('Reconhecimento facial de ' + name + ' removido com sucesso.', 'ok');
  } catch(e) {
    console.error('resetFacialUser:', e);
    showToast('Erro ao remover facial: ' + (e.message || e), 'err');
  }
}
async function dbAddHistory(h){
  const dateKey = new Date().toDateString().replace(/ /g,'_');
  // Preserve startEpoch from the record if it exists (SELB start time), only fallback to now
  const record = {...h};
  if(!record.startEpoch) record.startEpoch = Date.now();
  const key = await dbPush('/history/'+dateKey, record);
  return {key, dateKey};
}
async function dbUpdateHistory(docId, dateKey, data){
  if(!docId||!dateKey) return;
  await dbPatch('/history/'+dateKey+'/'+docId, data);
}

async function checkDayReset(){
  const today   = new Date().toDateString();
  const lastDay = localStorage.getItem('sb_last_day');
  if(lastDay !== today){
    localStorage.setItem('sb_last_day', today);
    dbSet('/meta/lastResetDay', today).catch(()=>{});

    // Busca registros 'running' do dia anterior no Firebase e mantém no history[]
    // para que os cards continuem visíveis até o operador finalizar o SELB.
    if(lastDay){
      const prevDk = lastDay.replace(/ /g,'_');
      try {
        const prevSnap = await dbGet('/history/'+prevDk);
        if(prevSnap){
          const todayStart2 = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
          const allPrevRecs = Object.entries(prevSnap)
            .map(([k,v]) => ({...v, _docId:k, _dateKey:prevDk}));
          const prevRecs = allPrevRecs.filter(r => r.status === 'running');
          const prevOk   = allPrevRecs.filter(r => {
            if(r.status !== 'ok') return false;
            if(r.endEpoch && r.endEpoch >= todayStart2) return true;
            if(r.end && r.start){
              const eS = timeStrToSec(r.end), sS = timeStrToSec(r.start);
              if(eS !== null && sS !== null && eS < sS) return true;
              if(r.startEpoch && eS !== null){
                const ed = new Date(r.startEpoch);
                ed.setHours(Math.floor(eS/3600), Math.floor((eS%3600)/60), eS%60, 0);
                if(ed.getTime() <= r.startEpoch) ed.setDate(ed.getDate()+1);
                if(ed.getTime() >= todayStart2) return true;
              }
            }
            return false;
          });
          [...prevRecs, ...prevOk].forEach(r => {
            if(!history.find(h => h._docId === r._docId)) history.push(r);
          });
          prevRecs.forEach(r => {
            const s = getS(r.uid);
            if(s.status === 'running' && !s.startEpoch && r.startEpoch){
              s.startEpoch     = r.startEpoch;
              if(!s._activeFrom) s._activeFrom = r.startEpoch;
              startTimer(r.uid);
            }
          });
        }
      } catch(e){ console.warn('[dayReset] Falha ao buscar running do dia anterior:', e); }
    }

    // Atualiza o display sem resetar SELBs em andamento
    if(currentUser) { buildCards(); updateSummary(); }
  }
}

// ════ RESTORE ACTIVE SELBS ════
// Delegates to applyUserSnapshot which is the single source of logic.
// Called at boot after history and users are loaded sequentially.
function restoreActiveSelbs(){
  if(users.length) applyUserSnapshot([...users]);
}

// ════ BOOT ════
let _bootReady = false;
let _pendingFirebaseUser = null; // holds firebase user if auth fired before boot finished
let _selbsExcluidos = new Set(); // Set de _docId excluídos do cálculo de média

function bootApp(){
  // Inicia numpad desabilitado até o Firebase responder com os usuários
  // (usa setTimeout para garantir que o DOM já está pronto)
  setTimeout(() => setPinLoading(true), 0);

  // Limpa flags legadas de "dashboard zerado" — a função zerarDashboard foi removida,
  // o dashboard nunca deve ser filtrado por zeradoEm durante o dia.
  localStorage.removeItem('sb_dashboard_zerado_em');
  localStorage.removeItem('sb_dashboard_zerado_dia');
  _dashboardZerado = false;

  _historyReady = true;
  _bootReady    = true;

  // Inicia listeners em background
  try { startRealtimeSync(); } catch(e){ console.error('sync error',e); }

  // Fallback: se Firebase demorar mais de 8s, libera o numpad com aviso
  setTimeout(() => {
    if(users.length === 0){
      setPinLoading(false);
      const errEl = document.getElementById('pin-error');
      if(errEl) errEl.textContent = '⚠️ Sem conexão — tente novamente';
    }
  }, 8000);

  // Carrega em background sem bloquear
  loadEquipamentos().catch(()=>{});
  loadSetores().catch(()=>{});

  // Carrega SELBs excluídos do cálculo de média (persistidos no Firebase)
  dbGet('/config/modelo_selbs_excluidos').then(d=>{
    if(d && typeof d === 'object'){
      Object.keys(d).forEach(docId => { if(d[docId]===true) _selbsExcluidos.add(docId); });
    }
  }).catch(()=>{});

  // Ao abrir o sistema, busca SELBs relevantes do dia anterior e os mantém no history[]
  // Isso cobre dois casos:
  // 1. Virada de dia: _bootLastDay !== _bootToday → busca running + ok de ontem que terminaram hoje
  // 2. Reload no mesmo dia com SELB overnight: busca ontem mesmo que _bootLastDay === _bootToday
  const _bootToday   = new Date().toDateString();
  const _bootLastDay = localStorage.getItem('sb_last_day') || _bootToday;

  // Sempre busca o dia anterior ao atual para garantir SELBs overnight
  const _yesterday = new Date();
  _yesterday.setDate(_yesterday.getDate() - 1);
  const _yesterdayDk = _yesterday.toDateString().replace(/ /g,'_');

  const _fetchPrevDay = (prevDk) => {
    dbGet('/history/'+prevDk).then(prevSnap => {
      if(!prevSnap) return;
      const todayStart = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.getTime(); })();
      const allPrev = Object.entries(prevSnap)
        .map(([k,v]) => ({...v, _docId:k, _dateKey:prevDk}));

      // Mantém em memória: running ainda não finalizado + ok finalizados hoje (cruzaram meia-noite)
      const prevRunning = allPrev.filter(r => r.status === 'running');
      const prevOkToday = allPrev.filter(r => {
        if(r.status !== 'ok') return false;
        if(r.endEpoch && r.endEpoch >= todayStart) return true;
        if(r.end && r.start){
          const eS = timeStrToSec(r.end), sS = timeStrToSec(r.start);
          if(eS !== null && sS !== null && eS < sS) return true;
          if(r.startEpoch && eS !== null){
            const ed = new Date(r.startEpoch);
            ed.setHours(Math.floor(eS/3600), Math.floor((eS%3600)/60), eS%60, 0);
            if(ed.getTime() <= r.startEpoch) ed.setDate(ed.getDate()+1);
            if(ed.getTime() >= todayStart) return true;
          }
        }
        return false;
      });

      [...prevRunning, ...prevOkToday].forEach(r => {
        if(!history.find(h => h._docId === r._docId)) history.push(r);
      });

      prevRunning.forEach(r => {
        const s = getS(r.uid);
        if(s.status === 'running' && !s.startEpoch && r.startEpoch){
          s.startEpoch = r.startEpoch;
          if(!s._activeFrom) s._activeFrom = r.startEpoch;
          startTimer(r.uid);
        }
      });

      if(prevRunning.length || prevOkToday.length){
        if(currentUser) { buildCards(); updateSummary(); }
      }
    }).catch(()=>{});
  };

  // Busca o dia anterior ao atual (sempre, para cobrir reloads no mesmo dia)
  _fetchPrevDay(_yesterdayDk);
  // Se o lastDay salvo for diferente de ontem, busca também ele (ex: feriado pulou dois dias)
  const _lastDk = _bootLastDay.replace(/ /g,'_');
  if(_lastDk !== _yesterdayDk && _bootLastDay !== _bootToday){
    _fetchPrevDay(_lastDk);
  }

  // Processa login pendente (admin com sessão salva)
  if(_pendingFirebaseUser && !currentUser){
    loginAs({id:_pendingFirebaseUser.uid, name:'Laboratório', sector:'admin', isAdmin:true});
    _pendingFirebaseUser = null;
  }
}

function showLoader(msg){
  document.getElementById('loader-msg').innerHTML = msg||'Carregando...';
  document.getElementById('loader-spinner').style.display = 'block';
  document.getElementById('loader-error-box').style.display = 'none';
  document.getElementById('layer-loader').style.display = 'flex';
}
function showError(title){
  document.getElementById('loader-spinner').style.display = 'none';
  document.getElementById('loader-msg').innerHTML =
    '<span style="color:var(--danger);font-size:14px;font-weight:600">'+title+'</span>';
  document.getElementById('loader-error-box').style.display = 'flex';
  document.getElementById('layer-loader').style.display = 'flex';
}
function hideLoader(){
  document.getElementById('layer-loader').style.display = 'none';
}

function retryWithUrl(){
  users=[]; history=[];
  showLoader('Reconectando...');
  bootApp();
}

// ════ START ════
document.addEventListener('DOMContentLoaded', function(){
  bootApp();
  liveClock();

  // ── Firebase Auth state listener ──────────────────────────────────────────
  firebase.auth().onAuthStateChanged(function(firebaseUser){
    if(firebaseUser && !currentUser){
      document.getElementById('al-user').value = '';
      document.getElementById('al-pass').value = '';
      document.getElementById('al-error').textContent = '';
      if(_bootReady){
        // Boot already done — login immediately
        loginAs({id: firebaseUser.uid, name: 'Laboratório', sector: 'admin', isAdmin: true});
      } else {
        // Boot still running — queue the login for when boot finishes
        _pendingFirebaseUser = firebaseUser;
      }
    }
  });

  // Event delegation — admin table buttons
  document.getElementById('users-body').addEventListener('click', function(e){
    const btn = e.target.closest('button');
    if(!btn) return;
    const uid = btn.dataset.uid;
    if(!uid) return;
    if(btn.classList.contains('adm-edit'))   openEdit(uid);
    if(btn.classList.contains('adm-toggle')) toggleActive(uid);
    if(btn.classList.contains('adm-hide'))   toggleHidden(uid);
    if(btn.classList.contains('adm-del'))    openDel(uid);
  });

  // Event delegation — dashboard cards
  document.getElementById('cards-grid').addEventListener('click', function(e){
    const btn = e.target.closest('button');
    if(!btn) return;
    const uid = btn.dataset.uid;
    if(!uid) return;
    if(btn.classList.contains('card-selb'))  openSelb(uid);
    if(btn.classList.contains('card-pause')) togglePause(uid);
    if(btn.classList.contains('card-fin'))   openFin(uid);
  });
});

// ════ HELPERS ════
function getS(uid){ if(!wstate[uid]) wstate[uid]={selb:null,status:'idle',elapsed:0,meta:60,activeTotal:0,idleTotal:0,idleStart:Date.now(),loginTime:Date.now()}; return wstate[uid]; }
function fmt(s){ const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60; return [h,m,ss].map(x=>String(x).padStart(2,'0')).join(':'); }

// Formata segundos como horas/minutos legível para gráficos: 60min=1h, 90min=1h30min, 45min=45min
function fmtMin(sec){
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if(h === 0) return m + 'min';
  if(m === 0) return h + 'h';
  return h + 'h' + String(m).padStart(2,'0') + 'min';
}
// Retorna valor em horas decimais para os eixos dos gráficos
function secToH(sec){ return Math.round(sec/60)/60; }


// ── Contadores derivados do history[] — fonte de verdade única ──────────────

// Contagem de máquinas do dia:
// Regra única — status 'ok' + campo 'end' preenchido (registro finalizado na Consulta)
// + endDateKey === hoje (dia em que foi aprovado, gravado no momento da conclusão).
// Sem reconstrução de datas, sem startEpoch, sem cruzamento de meia-noite.
function getTotalDia(uid){
  const todayDk = new Date().toDateString().replace(/ /g,'_');
  const recs = history.filter(h => {
    if(h.uid !== uid || h.status !== 'ok' || !h.end) return false;
    // Fonte primária: endDateKey gravado no fechamento
    if(h.endDateKey) return h.endDateKey === todayDk;
    // Fallback para registros sem endDateKey: endEpoch
    if(h.endEpoch) return new Date(h.endEpoch).toDateString().replace(/ /g,'_') === todayDk;
    // Último fallback: _dateKey (dia de início) — apenas para registros muito antigos
    return h._dateKey === todayDk;
  });
  // Deduplica por SELB: mesmo SELB aprovado mais de uma vez conta como 1 máquina
  const selbsUnicos = new Set(recs.map(h => h.selb).filter(Boolean));
  // Registros sem SELB identificado contam individualmente
  const semSelb = recs.filter(h => !h.selb).length;
  return selbsUnicos.size + semSelb;
}

/**
 * CALCULA DURAÇÃO LÍQUIDA (A Função Única)
 * Desconta automaticamente noites, fins de semana e intervalos do SCHEDULE.
 */
function calcLiquidDuration(fromMs, toMs) {
  if (!fromMs || !toMs || fromMs >= toMs) return 0;
  
  let breakMs = 0;
  const start = new Date(fromMs);
  const end = new Date(toMs);
  
  // Percorre dia a dia
  let current = new Date(start);
  current.setHours(0, 0, 0, 0);
  
  while (current <= end) {
    const base = current.getTime();
    const day = current.getDay();
    
    // Expediente
    const ws = base + (SCHEDULE.work.start[0]*3600 + SCHEDULE.work.start[1]*60)*1000;
    const we = base + (SCHEDULE.work.end[0]*3600   + SCHEDULE.work.end[1]*60)*1000;
    
    // Noite/Antes
    const pre_s = Math.max(fromMs, base), pre_e = Math.min(toMs, ws);
    if(pre_e > pre_s) breakMs += (pre_e - pre_s);
    
    // Noite/Depois
    const pos_s = Math.max(fromMs, we), pos_e = Math.min(toMs, base + 86400000);
    if(pos_e > pos_s) breakMs += (pos_e - pos_s);
    
    // Fim de semana (desconta o horário que seria de expediente)
    if(day === 0 || day === 6){
      const wk_s = Math.max(fromMs, ws), wk_e = Math.min(toMs, we);
      if(wk_e > wk_s) breakMs += (wk_e - wk_s);
    } else {
      // Intervalos (apenas dias úteis)
      for(const b of SCHEDULE.breaks){
        const bs = base + (b.start[0]*3600 + b.start[1]*60)*1000;
        const be = base + (b.end[0]*3600   + b.end[1]*60)*1000;
        const i_s = Math.max(fromMs, bs), i_e = Math.min(toMs, be);
        if(i_e > i_s) breakMs += (i_e - i_s);
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return Math.max(0, Math.floor((toMs - fromMs - breakMs) / 1000));
}

function calcDuracaoLiquida(h){
  // Se já tem duração formatada, usa ela
  if(h.duracao){
    const p = h.duracao.split(':').map(Number);
    if(p.length === 3) return p[0]*3600 + p[1]*60 + p[2];
  }
  // Caso contrário, calcula pelos timestamps
  if(h.startEpoch && h.endEpoch) return calcLiquidDuration(h.startEpoch, h.endEpoch);
  // Fallback final: relógio simples
  if(h.start && h.end){
    const sS = timeStrToSec(h.start), eS = timeStrToSec(h.end);
    if(sS !== null && eS !== null){
      let d = eS - sS; if(d < 0) d += 86400; return d;
    }
  }
  return 0;
}
// Timer do SELB em andamento — contagem LOCAL após o início.
// Depois que o operador inicia o SELB, o tempo é contado apenas no cliente
// (não consulta nem é sobrescrito pelo Firebase). Isso elimina o "sobe e volta".
// O Firebase só é usado para detectar pausa/intervalo do sistema (status === 'paused')
// — nesse momento o contador local é CONGELADO e retomado de onde parou ao voltar.
const _localTimerCache = Object.create(null); // uid -> { selb, baseSec, runningSince }

function _localTimerClear(uid){ delete _localTimerCache[uid]; if(typeof _lastEmittedElapsed !== 'undefined') delete _lastEmittedElapsed[uid]; }

function _localTimerEnsure(uid){
  const s = getS(uid);
  if(!s || !s.selb){ _localTimerClear(uid); return null; }
  let c = _localTimerCache[uid];
  // (Re)inicializa quando o SELB muda ou ainda não existe cache local.
  // A semente vem UMA ÚNICA VEZ do estado conhecido (frozen + tempo vivo desde _activeFrom/startEpoch).
  // Depois disso, nada mais é puxado do Firebase para o cálculo do tempo.
  if(!c || c.selb !== s.selb){
    const frozenSec = Math.max(0, Number(s._frozenElapsed) || 0);
    const since = s._activeFrom || s.startEpoch;
    const liveSec = (s.status === 'running' && since)
      ? Math.max(0, Math.floor((Date.now() - since) / 1000))
      : 0;
    c = _localTimerCache[uid] = {
      selb: s.selb,
      baseSec: frozenSec + liveSec,
      runningSince: s.status === 'running' ? Date.now() : null,
    };
  }
  return c;
}

// Anti-oscilação: guarda o último valor emitido por uid+SELB para impedir
// que o tempo pule pra frente/trás caso o cache local seja reinicializado
// por uma sincronização do Firebase (ex.: _frozenElapsed/_activeFrom mudam).
const _lastEmittedElapsed = Object.create(null); // uid -> { selb, sec, ts }

function _clearLastEmitted(uid){ delete _lastEmittedElapsed[uid]; }

function calcElapsedRunning(uid){
  const s = getS(uid);
  if(!s || !s.selb){ _localTimerClear(uid); _clearLastEmitted(uid); return 0; }
  const c = _localTimerEnsure(uid);
  if(!c) return 0;
  let raw;
  if(s.status === 'running'){
    // Se voltou de uma pausa (sistema/intervalo), retoma a contagem de onde parou.
    if(c.runningSince == null) c.runningSince = Date.now();
    raw = c.baseSec + Math.max(0, Math.floor((Date.now() - c.runningSince) / 1000));
  } else {
    // Qualquer status diferente de 'running' (ex.: 'paused' por intervalo do sistema) → CONGELA.
    if(c.runningSince != null){
      c.baseSec += Math.max(0, Math.floor((Date.now() - c.runningSince) / 1000));
      c.runningSince = null;
    }
    raw = c.baseSec;
  }

  // ── Trava de monotonicidade ──
  // Entre dois ticks consecutivos do mesmo SELB, o tempo só pode crescer
  // no máximo o delta real de relógio + 2s de tolerância. Nunca pode diminuir.
  // Isso elimina saltos do tipo 10min → 20min causados por reseed do cache.
  const now = Date.now();
  const last = _lastEmittedElapsed[uid];
  if(last && last.selb === s.selb){
    const realDeltaSec = Math.max(0, Math.ceil((now - last.ts) / 1000)) + 2;
    const maxAllowed = last.sec + realDeltaSec;
    const minAllowed = last.sec;
    let clamped = raw;
    if(clamped > maxAllowed) clamped = maxAllowed;
    if(clamped < minAllowed) clamped = minAllowed;
    if(clamped !== raw){
      // Reajusta o baseSec para que o cache fique coerente com o valor exibido
      if(s.status === 'running' && c.runningSince != null){
        c.baseSec = clamped - Math.max(0, Math.floor((Date.now() - c.runningSince) / 1000));
      } else {
        c.baseSec = clamped;
      }
      raw = clamped;
    }
  }
  _lastEmittedElapsed[uid] = { selb: s.selb, sec: raw, ts: now };
  return raw;
}

// Tempo ocioso = soma dos intervalos entre SELBs, descontando pausas programadas do sistema.
// rEnd é calculado a partir do horário de relógio (r.end string), não de startEpoch+duracao,
// porque duracao é tempo líquido (sem pausas) e não representa o fim real no relógio.
function sc(sec){ return sec==='MONTAGEM'?'mont':sec==='LIMPEZA'?'limp':sec==='QUALIDADE'?'qual':sec==='ELETRÔNICA'?'elet':sec==='EXIBIÇÃO'?'exib':'comp'; }
function ini(n){ return n.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase(); }

// ════ LOGIN ════
let pv='';
function updPD(){
  const d=document.getElementById('pin-display');
  d.textContent=[0,1,2,3,4].map(i=>pv[i]?'●':'_').join(' ');
}

// Controla estado de carregamento do numpad
function setPinLoading(isLoading){
  const keys = document.querySelectorAll('.numpad .key');
  const errEl = document.getElementById('pin-error');
  if(isLoading){
    keys.forEach(k => { k.disabled = true; k.style.opacity = '0.4'; k.style.cursor = 'not-allowed'; });
    if(errEl) errEl.textContent = '⏳ Conectando ao servidor...';
  } else {
    keys.forEach(k => { k.disabled = false; k.style.opacity = ''; k.style.cursor = ''; });
    if(errEl && errEl.textContent === '⏳ Conectando ao servidor...') errEl.textContent = '';
  }
}

function pinKey(d){ if(pv.length<5){ pv+=d; updPD(); } }
function pinDel(){ pv=pv.slice(0,-1); updPD(); document.getElementById('pin-error').textContent=''; }
function pinEnter(){
  if(users.length === 0){
    document.getElementById('pin-error').textContent='⏳ Aguardando dados do servidor...';
    setTimeout(()=>{ document.getElementById('pin-error').textContent=''; }, 2000);
    return;
  }
  const u=users.find(u=>u.pin===pv&&u.active);
  if(!u){
    document.getElementById('pin-error').textContent='PIN inválido.';
    document.getElementById('pin-display').classList.add('shake');
    setTimeout(()=>document.getElementById('pin-display').classList.remove('shake'),350);
    pv=''; updPD(); return;
  }
  loginAs({id:u.id,name:u.name,sector:u.sector,isAdmin:false});
  pv=''; updPD();
}
async function adminLogin(){
  const emailRaw = document.getElementById('al-user').value.trim();
  const p        = document.getElementById('al-pass').value;
  const errEl    = document.getElementById('al-error');
  const btn      = document.querySelector('.al-btn');

  if(!emailRaw || !p){ errEl.textContent='Preencha e-mail e senha.'; return; }

  const email = emailRaw;

  btn.textContent = 'Entrando…';
  btn.disabled = true;
  errEl.textContent = '';

  try {
    await firebase.auth().signInWithEmailAndPassword(email, p);
    // onAuthStateChanged will call loginAs after successful sign-in
  } catch(err) {
    const msg = err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found'
      ? 'Usuário ou senha incorretos.'
      : err.code === 'auth/too-many-requests'
      ? 'Muitas tentativas. Tente novamente mais tarde.'
      : 'Erro: ' + err.message;
    errEl.textContent = msg;
  } finally {
    btn.textContent = 'Entrar como Admin';
    btn.disabled = false;
  }
}

function loginAs(u){
  currentUser=u;
  document.getElementById('u-name').textContent=u.name;
  const av=document.getElementById('u-avatar');
  av.textContent=ini(u.name);
  av.className='avatar av-'+(u.isAdmin?'admin':u.sector==='VISUALIZAÇÃO'?'exib':sc(u.sector));

  const isAdmin   = u.isAdmin;
  // Tipo de visualização do setor — escolhido em "Gerenciar Setores"
  // Para setores fixos especiais mantemos o comportamento histórico como default.
  const sectorTipo = isAdmin ? 'admin' : (typeof getSectorTipo === 'function' ? getSectorTipo(u.sector) : 'operador');
  const viewAsAdmin = isAdmin || sectorTipo === 'admin';

  const isQual    = !isAdmin && u.sector==='QUALIDADE'    && sectorTipo === 'admin';
  const isDisplay = !isAdmin && u.sector==='VISUALIZAÇÃO' && sectorTipo === 'admin';
  const isDesMem  = !isAdmin && u.sector==='DESMEMBRAMENTO' && sectorTipo === 'admin';

  // Tab visibility — controlada por permissões salvas (com fallback ao padrão)
  document.getElementById('topbar-tabs').style.display    = isDisplay?'none':'';
  document.getElementById('tab-admin').style.display      = isAdmin?'':'none';
  document.getElementById('tab-equip').style.display      = (isAdmin || u.sector === 'PCP') ? '' : 'none';
  applySectorTabPerms(u);
  applyRelSubTabPerms(u);
  // Re-enforce após applySectorTabPerms: admin e equip NUNCA para não-admins (exceto PCP em equip)
  if(!isAdmin){
    document.getElementById('tab-admin').style.display = 'none';
    if(u.sector !== 'PCP') document.getElementById('tab-equip').style.display = 'none';
  }


  if(isQual)              activeSector='MONTAGEM';
  else if(isDisplay)      activeSector='COMPLEXA';
  else if(!isAdmin)       activeSector=u.sector;
  else                    activeSector='MONTAGEM';

  users.forEach(usr=>{ const s=getS(usr.id); if(!s.idleStart&&s.status==='idle') s.idleStart=Date.now(); s.loginTime=Date.now(); });
  _consultaDateKey = new Date().toDateString().replace(/ /g,'_');
  document.getElementById('layer-login').classList.add('hidden');
  document.getElementById('layer-app').classList.add('visible');

  if(isDesMem){
    // Abre direto na tela de Relatórios no sub-tab SCRAP
    setView('relatorios', document.getElementById('tab-relatorios'));
    
    // Oculta todas as abas de relatórios que não sejam SCRAP
    const idsRel = ['reltab-prod','reltab-pedido','reltab-modelo','reltab-usuario','reltab-mensal','reltab-reprov','reltab-defeitos', 'reltab-duplicados', 'reltab-busca-modelo', 'reltab-qual-liberados'];
    idsRel.forEach(id => {
      const el = document.getElementById(id);
      if(el) el.style.display = 'none';
    });

    setTimeout(() => setRelSubTab('scrap'), 80);
  } else if(isQual){
    activeSector = 'MONTAGEM';
    setView('consulta', document.getElementById('tab-consulta'));
    
    // Restaura exibição padrão caso Admin ou outro acesse
    const idsRel = ['reltab-prod','reltab-pedido','reltab-modelo','reltab-usuario','reltab-mensal','reltab-reprov','reltab-defeitos', 'reltab-duplicados', 'reltab-busca-modelo', 'reltab-qual-liberados'];
    idsRel.forEach(id => {
      const el = document.getElementById(id);
      if(el) el.style.display = '';
    });
    buildCards();
    users.forEach(u => {
      const s = wstate[u.id];
      if(s && s.status === 'running' && !timers[u.id]) startTimer(u.id);
    });
  } else if(isDisplay){
    activeSector = 'COMPLEXA';
    document.getElementById('tab-consulta').style.display = 'none';
    setView('dashboard', document.getElementById('tab-dashboard'));
    buildCards();
  } else if(!isAdmin) {
    if (viewAsAdmin) {
      // Setor configurado como "Visão Admin" — abre dashboard completo
      setView('dashboard', document.getElementById('tab-dashboard'));
      buildCards();
      const idsRel = ['reltab-prod','reltab-pedido','reltab-modelo','reltab-usuario','reltab-mensal','reltab-reprov','reltab-defeitos', 'reltab-duplicados', 'reltab-busca-modelo', 'reltab-qual-liberados'];
      idsRel.forEach(id => { const el = document.getElementById(id); if(el) el.style.display = ''; });
    } else {
      // Setor configurado como "Tela do Operador" (padrão estilo Montagem)
      setView('dashboard', document.getElementById('tab-dashboard'));
      buildCards();
      showOperatorView(u.id);
    }
  } else {
    setView('dashboard', document.getElementById('tab-dashboard'));
    buildCards();
    
    // Restaura abas de relatórios para Admin
    const idsRel = ['reltab-prod','reltab-pedido','reltab-modelo','reltab-usuario','reltab-mensal','reltab-reprov','reltab-defeitos', 'reltab-duplicados', 'reltab-busca-modelo', 'reltab-qual-liberados'];
    idsRel.forEach(id => {
      const el = document.getElementById(id);
      if(el) el.style.display = '';
    });
  }

  scheduleCheck();
  document.getElementById('admin-cred').classList.remove('open');
}
function logout(){
  firebase.auth().signOut().catch(()=>{});
  currentUser=null; pv=''; updPD();
  _consultaDateKey = null;
  _consultaRecords = [];
  // Reseta inputs de data da consulta
  const _cfrom = document.getElementById('consulta-date-from');
  const _cto   = document.getElementById('consulta-date-to');
  const _todayIso = new Date().toISOString().slice(0,10);
  const _sevenAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0,10);
  if(_cfrom) _cfrom.value = _sevenAgo;
  if(_cto)   _cto.value   = _todayIso;
  _opSyncInterval && clearInterval(_opSyncInterval);
  _opSyncInterval = null;
  document.getElementById('pin-error').textContent='';
  document.getElementById('al-error').textContent='';
  document.getElementById('al-user').value='';
  document.getElementById('al-pass').value='';
  document.getElementById('topbar-tabs').style.display = ''; // restaura tabs
  document.getElementById('layer-login').classList.remove('hidden');
  document.getElementById('layer-app').classList.remove('visible');
  // Re-bloqueia foco/tab no app após logout
  (function lockFocusOnLogout(){
    const appLayer = document.getElementById('layer-app');
    if(!appLayer) return;
    appLayer.querySelectorAll('button, input, select, textarea, a, [tabindex]').forEach(el => {
      if(!el.hasAttribute('data-prev-tabindex')){
        el.setAttribute('data-prev-tabindex', el.getAttribute('tabindex') || '');
      }
      el.setAttribute('tabindex', '-1');
    });
    appLayer.setAttribute('aria-hidden', 'true');
    appLayer.inert = true;
    // Devolve foco para o numpad de PIN
    const firstPin = document.querySelector('#layer-login button:not([disabled])');
    if(firstPin) setTimeout(() => firstPin.focus(), 50);
  })();
}

// ════════════════════════════════════════
// TELA DO OPERADOR — view dedicada para login por PIN
// Separada do dashboard para evitar confusão e bugs de estado.
// Estado sempre buscado do Firebase antes de qualquer ação.
// ════════════════════════════════════════
let _opSyncInterval = null;

function showOperatorView(uid){
  // Esconde tabs e mostra view-operador
  document.getElementById('topbar-tabs').style.display = 'none';
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-operador').classList.add('active');

  // Preenche header
  const u = users.find(x=>x.id===uid);
  if(!u) return;
  const secColor = u.sector==='MONTAGEM'?'var(--mont)':u.sector==='LIMPEZA'?'var(--limp)':u.sector==='ELETRÔNICA'?'var(--elet)':'var(--comp)';
  document.getElementById('op-name-big').textContent = u.name;
  document.getElementById('op-sector-tag').innerHTML =
    `<span style="color:${secColor}">${u.sector}</span> · PIN ${u.pin}`;

  // Sincroniza estado do Firebase e renderiza
  opSyncFromFirebase(uid);

  // Re-sync a cada 30s — o listener onValue do Firebase já cuida das atualizações
  // em tempo real. Polling frequente causava saltos no timer visual.
  _opSyncInterval && clearInterval(_opSyncInterval);
  _opSyncInterval = setInterval(()=>{ if(currentUser && currentUser.id===uid) opSyncFromFirebase(uid); }, 30000);
}

async function opSyncFromFirebase(uid){
  try {
    const fbUser = await dbGet('/users/'+uid);
    if(!fbUser) return;
    const s = getS(uid);
    const fbStatus = fbUser._status || 'idle';

    if(fbStatus === 'running'){
      s.status         = 'running';
      s.selb           = fbUser._selb || s.selb || null;
      if(fbUser._startEpoch) s.startEpoch = fbUser._startEpoch;
      // ── Protege timer local: só aplica _activeFrom/_frozenElapsed do Firebase
      // quando o timer local ainda não foi iniciado (primeira carga).
      // Evita que o sync periódico de 5s cause saltos no timer visual. ──
      const localRunning = s._activeFrom != null && s._activeFrom > 0;
      if(!localRunning){
        s._frozenElapsed = (fbUser._frozenElapsed != null) ? fbUser._frozenElapsed : (s._frozenElapsed || 0);
        s._activeFrom    = (fbUser._activeFrom    != null) ? fbUser._activeFrom    : (s._activeFrom  || Date.now());
      }
    } else if(fbStatus === 'paused'){
      s.status         = 'paused';
      s.selb           = fbUser._selb || s.selb || null;
      if(fbUser._startEpoch) s.startEpoch = fbUser._startEpoch;
      s._frozenElapsed = fbUser._frozenElapsed != null ? fbUser._frozenElapsed : (s._frozenElapsed||0);
      s._activeFrom    = null;
    } else {
      s.status = 'idle';
      s.selb   = null;
    }
    opRenderState(uid);
  } catch(e){}
}

function opRenderState(uid){
  if (!uid) {
    console.warn('[Sanity Check] opRenderState called sem uid');
    return;
  }
  const s = getS(uid);
  const u = users.find(x=>x.id===uid);
  if(!u) {
    console.warn('[Sanity Check] opRenderState: usuário não encontrado', uid);
    return;
  }

  document.getElementById('op-idle').style.display    = 'none';
  document.getElementById('op-checking').style.display= 'none';
  document.getElementById('op-running').style.display = 'none';
  document.getElementById('op-paused').style.display  = 'none';

  if(s.status === 'running'){
    document.getElementById('op-running').style.display = 'block';
    document.getElementById('op-selb-code').textContent = s.selb || '—';
    const equipN = getEquipName(s.selb||'');
    document.getElementById('op-equip-name').textContent = equipN || '';
    // Mostra caixa de solicitação de peça apenas para Montagem
    const pecaBox = document.getElementById('op-peca-box');
    if(pecaBox) pecaBox.style.display = (u.sector === 'MONTAGEM' || u.sector === 'COMPLEXA') ? 'block' : 'none';
    atualizarOpPecaPendente(uid);
  } else if(s.status === 'paused'){
    document.getElementById('op-paused').style.display = 'block';
    document.getElementById('op-paused-selb').textContent = s.selb || '—';
  } else {
    document.getElementById('op-idle').style.display = 'block';
  }

  // Histórico do dia
  opRenderHistory(uid);
}

function opUpdateTimer(uid){
  const s   = getS(uid);
  const el  = document.getElementById('op-timer');
  if(!el) return;
  if(s.status === 'running' || s.status === 'paused'){
    const sec = calcElapsedRunning(uid);
    el.textContent = sec === null ? '--:--:--' : fmt(sec);
  }
}

function opRenderHistory(uid){
  const todayDk = new Date().toDateString().replace(/ /g,'_');
  const recs = history
    .filter(h => h.uid === uid && h._dateKey === todayDk && ['ok','rep','scrap'].includes(h.status))
    .sort((a,b) => (b.startEpoch||0) - (a.startEpoch||0))
    .slice(0, 8);

  const listEl = document.getElementById('op-history-list');
  if(!listEl) return;
  if(!recs.length){
    listEl.innerHTML = `<div style="font-size:12px;color:var(--muted);text-align:center;padding:12px">Nenhum SELB finalizado hoje</div>`;
    return;
  }
  const stLabel = {ok:'✅ Aprovado', rep:'❌ Reprovado', scrap:'🗑️ SCRAP'};
  const stColor = {ok:'var(--accent2)', rep:'var(--danger)', scrap:'var(--purple)'};
  listEl.innerHTML = recs.map(r=>`
    <div style="background:var(--bg2);border:1px solid ${r.status==='rep'?'rgba(242,87,87,.3)':'var(--border)'};border-radius:10px;padding:10px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--accent)">${r.selb||'—'}</span>
          ${r.equipamento?`<span style="font-size:11px;color:var(--muted);margin-left:8px">${r.equipamento}</span>`:''}
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${r.duracao?`<span style="font-family:var(--mono);font-size:11px;color:var(--text)">${r.duracao}</span>`:''}
          <span style="font-size:11px;font-weight:600;color:${stColor[r.status]||'var(--muted)'}">${stLabel[r.status]||r.status}</span>
        </div>
      </div>
      ${r.status==='rep'&&r.motivo?`<div style="margin-top:6px;font-size:11px;color:var(--danger);background:rgba(242,87,87,.08);border-radius:6px;padding:5px 9px;line-height:1.4">⚠️ ${r.motivo}</div>`:''}
    </div>`).join('');
}

async function opIniciarSelb(){
  if(!currentUser) return;
  const uid = currentUser.id;

  // Mostra estado de verificação
  document.getElementById('op-idle').style.display     = 'none';
  document.getElementById('op-checking').style.display = 'block';

  try {
    // Consulta Firebase — fonte de verdade
    const fbUser = await dbGet('/users/'+uid);
    if(fbUser && (fbUser._status === 'running' || fbUser._status === 'paused')){
      // Já tem SELB ativo no Firebase — sincroniza e mostra
      const s = getS(uid);
      s.status = fbUser._status;
      s.selb = fbUser._selb || null;
      if(fbUser._startEpoch) s.startEpoch = fbUser._startEpoch;
      document.getElementById('op-checking').style.display = 'none';
      opRenderState(uid);
      return;
    }
  } catch(e){}

  document.getElementById('op-checking').style.display = 'none';
  document.getElementById('op-idle').style.display = 'block';

  // Abre modal de SELB normalmente
  openSelb(uid);
}

async function opFinalizarSelb(){
  if(!currentUser) return;
  const uid = currentUser.id;
  openFin(uid);
}

// ── toggleAdminCred helper ──
function toggleAdminCred(){ document.getElementById('admin-cred').classList.toggle('open'); }

// keyboard support for PIN pad
document.addEventListener('keydown',e=>{
  const lo=document.getElementById('layer-login');
  if(!lo.classList.contains('hidden')){
    if(e.key>='0'&&e.key<='9') pinKey(e.key);
    else if(e.key==='Backspace') pinDel();
    else if(e.key==='Enter') pinEnter();
  }
  const cred=document.getElementById('admin-cred');
  if(cred.classList.contains('open')&&e.key==='Enter') adminLogin();
});

// ════ VIEWS ════
function setView(v,btn){
  // ── SEGURANÇA: bloqueia acesso a qualquer view sem usuário autenticado ──
  if(!currentUser){
    console.warn('[Security] setView bloqueado — usuário não autenticado');
    return;
  }
  // ── SEGURANÇA: bloqueia views restritas para não-admins ──
  if(v === 'admin' && !(currentUser && currentUser.isAdmin)){
    console.warn('[Security] setView admin bloqueado — não é admin Firebase');
    return;
  }
  if(v === 'equip' && !(currentUser && (currentUser.isAdmin || currentUser.sector === 'PCP'))){
    console.warn('[Security] setView equip bloqueado — sem permissão');
    return;
  }
  if(v==='fluxolab')    { renderFluxoLAB(); }
  if(v==='gaiola-lab')   { renderQualRegistros(); }
  if(v==='relatorios')  { showRelRefreshBadge(); }
  if(v==='pecas')       { renderPecasView(); }
  if(v==='solicitacoes'){ renderSolicitacoesDoDia(); }
  if(v==='maquinas-a')  { renderMaquinasAView(); }
  if(v !== 'scanner') {
    if(typeof scannerStopCamera === 'function') scannerStopCamera();
  } else {
    if(typeof scannerInit === 'function') scannerInit();
  }
  document.querySelectorAll('.view').forEach(e=>e.classList.remove('active'));
  document.getElementById('view-'+v).classList.add('active');
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  // Oculta alertas na tela do operador, limpa o painel ao sair dela
  const alertPanel = document.getElementById('selb-alert-panel');
  if(alertPanel){
    if(v === 'operador'){
      alertPanel.innerHTML = '';
      alertPanel.style.display = 'none';
    } else {
      alertPanel.style.display = '';
    }
  }
  if(v==='consulta'){
    cFilter=''; resetStabs('cons-tabs',0);
    _initConsultaDateSelect();
    // Se ainda não carregou nenhum range, carrega hoje
    if(!_consultaDateKey){
      loadConsultaRange();
    } else {
      renderConsulta();
    }
  }
  if(v==='admin')     { admFilter=''; resetStabs('adm-tabs',0); renderUsers(); renderConfigPecasAdmin(); }
  if(v==='qualidade') { qualFilter=''; resetStabs('qual-tabs',0); _initQualDateSelect(); _qualRecords=_consultaRecords.length?_consultaRecords:history; _qualDateKey=new Date().toDateString().replace(/ /g,'_'); renderQualidade(); }
  if(v==='pecas')       { renderPecasView(); }
  if(v==='solicitacoes'){ _initSolicitacoesFilters(); renderSolicitacoesDoDia(); }
  if(v==='garantia')    { _garantiaFilter=''; resetStabs('garantia-tabs',0); setGarantiaSubTab('registro'); renderGarantiaView(); }
  if(v==='maquinas-a') { renderMaquinasAView(); }
  if(v==='perdidas')   { renderPerdidasView(); }
  if(v==='relatorios'){ relFilter=''; resetStabs('rel-tabs',0); hideRelRefreshBadge();
    // Inicializa filtro global e local com hoje e reseta cache
    initGlobalDateFilter();
    initRelDateFilter();
    _relHistoryCache = null;
    window._currentRelSubTab = relSubTab;
    setTimeout(()=>{
      if(!window._relFilterChosen && relSubTab !== 'pedido'){
        _relShowPlaceholder();
        return;
      }
      _relHidePlaceholder();
    if(relSubTab==='prod')        loadRelByDate().then(()=>renderRelatorios());
    else if(relSubTab==='scrap')  { _syncGlobalToLocalFilters(); loadScrapByDate().then(()=>renderScrapRel()); }
    else if(relSubTab==='modelo') renderModeloRel();
    else if(relSubTab==='mensal'){ initMensalSelect(); renderMensalRel(); }
    else if(relSubTab==='reprov') _loadReprovByGlobalDate().then(()=>renderReprovRel());
    else if(relSubTab==='defeitos') _loadDefeitosByGlobalDate().then(()=>renderDefeitos());
    else if(relSubTab==='usuario') _loadUsuarioByGlobalDate().then(()=>renderUsuarioRel());
    else if(relSubTab==='duplicados') _loadDuplicadosByGlobalDate().then(()=>renderDuplicados());
  },50); }
  if(v==='equip')     { renderEquipTable(); }
}
function resetStabs(id,idx){
  const tabs=document.getElementById(id).querySelectorAll('.stab');
  tabs.forEach(t=>t.className='stab');
  if(tabs[idx]) tabs[idx].classList.add('a-all');
}

// ════ SECTOR TABS ════
function setSector(s,btn){
  activeSector=s;
  document.getElementById('sector-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  btn.classList.add('a-'+sc(s));
  buildCards();
}

// ════ TEMPO MÉDIO DO MODELO — mesma lógica do relatório ════
// Usa _modeloAllRecs (histórico completo) quando disponível, senão usa history (dia atual).
// Aplica os mesmos filtros do relatório: setor, intervalo 5–150 min (Montagem/Limpeza),
// exclusão de SELBs individuais via _selbsExcluidos.
function getAvgModeloCard(equipName, sector){
  if(!equipName) return '—';
  const _MONT_LIMP_MIN = 15 * 60;
  const _MONT_LIMP_MAX = 150 * 60;
  const isMontLimp = (sector === 'MONTAGEM' || sector === 'LIMPEZA');
  const source = (typeof _modeloAllRecs !== 'undefined' && _modeloAllRecs.length > 0)
    ? _modeloAllRecs
    : history;
  const tempos = source
    .filter(h =>
      h.equipamento && h.equipamento.trim() === equipName.trim() &&
      h.sector === sector &&
      h.status === 'ok' &&
      h.duracao &&
      !(typeof _selbsExcluidos !== 'undefined' && _selbsExcluidos.has(h._docId))
    )
    .map(h => {
      const s = calcDuracaoLiquida(h);
      // Para MONTAGEM e LIMPEZA: registros > 150min entram com cap de 150min
      if(isMontLimp && s > _MONT_LIMP_MAX) return _MONT_LIMP_MAX;
      return s;
    })
    .filter(s => {
      if(!s || s <= 0) return false;
      if(isMontLimp) return s > _MONT_LIMP_MIN; // exclui abaixo de 15min; acima de 150min já foi capado
      return true;
    });
  if(!tempos.length) return '—';
  return fmt(calcAverage(tempos));
}

// ════ DASHBOARD ════
function buildCards(){
  const grid=document.getElementById('cards-grid');
  grid.innerHTML='';
  users.filter(u=>u.active&&!u.hidden&&u.sector===activeSector).forEach(u=>{
    const d=document.createElement('div'); d.id='card-'+u.id; grid.appendChild(d); renderCard(u.id);
  });
  updateSummary();
}
function renderCard(uid){
  const u=users.find(x=>x.id===uid); if(!u) return;
  const s=getS(uid);
  const totalDia=getTotalDia(uid);
  const metaDia = (u.sector === 'COMPLEXA') ? 1 : 8;
  
  // Lógica de Agendamento
  const MACHINE_SCHEDULE = (u.sector === 'COMPLEXA') ? [
    { start: "07:30", end: "17:30", label: "Máquina 1" }
  ] : [
    { start: "07:30", end: "08:35", label: "Máquina 1" },
    { start: "08:35", end: "09:40", label: "Máquina 2" },
    { start: "09:40", end: "10:45", label: "Máquina 3" },
    { start: "10:45", end: "11:50", label: "Máquina 4" },
    { start: "11:50", end: "13:00", label: "Máquina 5" },
    { start: "14:12", end: "15:17", label: "Máquina 6" },
    { start: "15:17", end: "16:22", label: "Máquina 7" },
    { start: "16:22", end: "17:30", label: "Máquina 8" }
  ];

  const now = new Date();
  const currentMins = now.getHours() * 60 + now.getMinutes();
  const toMins = (str) => { const [h,m] = str.split(':').map(Number); return h * 60 + m; };
  
  let expectedMachines = 0;
  let nextMachineTime = "";
  let isDelayed = false;

  for(let i=0; i<MACHINE_SCHEDULE.length; i++) {
    const m = MACHINE_SCHEDULE[i];
    if(currentMins >= toMins(m.start)) {
      expectedMachines = i + 1;
    }
    if(currentMins < toMins(m.end) && !nextMachineTime) {
      nextMachineTime = m.end;
      if(totalDia < i + 1 && currentMins > toMins(m.start)) {
        isDelayed = true;
      }
    }
  }

  const el=Math.min(100,Math.round((totalDia/metaDia)*100));
  const expectedPct = Math.min(100, Math.round((expectedMachines/metaDia)*100));
  const goalDone = el >= 100;
  
  // Lógica de cores baseada no atraso em relação à expectativa horária
  let bc = 'goal'; // Verde (no prazo ou adiantado)
  let statusClass = 'ok';
  
  if (totalDia < expectedMachines - 1) {
    bc = 'delayed'; // Vermelho (muito abaixo)
    statusClass = 'red';
  } else if (totalDia < expectedMachines) {
    bc = 'w'; // Laranja/Amarelo (próximo/atrasado em 1)
    statusClass = 'warn';
  }
  
  const isRun=s.status==='running',isPaus=s.status==='paused',isIdle=s.status==='idle';
  const isMine=currentUser&&currentUser.id===uid;
  const isAdmin=currentUser&&currentUser.isAdmin;
  const isDisplay=currentUser&&currentUser.sector==='VISUALIZAÇÃO';
  const canAct=(isMine||isAdmin)&&!isDisplay;
  const card=document.getElementById('card-'+uid); if(!card) return;
  card.className='card'+(isRun?' running':isPaus?' paused':'')+(goalDone?' goal-card':'');
  card.style.order = -totalDia;
  
  const hRun = history.find(x=>x.uid===uid&&x.status==='running');
  const equipName = s.selb ? getEquipName(s.selb) : (hRun ? getEquipName(hRun.selb) : "");
  
  let badgeHtml = '';
  if (totalDia >= metaDia) {
    const badgeText = totalDia > metaDia ? '⚡ META SUPERADA' : '🏆 META ATINGIDA';
    badgeHtml = `<div class="goal-badge">${badgeText}</div>`;
  }
  
  card.innerHTML=`
    ${badgeHtml}
    <div class="card-header">
      <div style="display:flex; flex-direction:column;">
        <div class="card-name">${u.name}</div>
        <div class="card-pin ${statusClass}">PIN ${u.pin}</div>
      </div>
      <div class="sdot ${isRun?'running':isPaus?'paused':''}"></div>
    </div>
    
    <div class="prog-area">
      <div class="prog-info">
        <div class="prog-machines ${statusClass}">${totalDia}/${metaDia} máquinas</div>
        <div class="prog-expected ${statusClass}">expectativa: ${expectedMachines}</div>
      </div>
      <div class="prog-segments">
        ${(function(){
          let h = '';
          for(let i=1; i<=metaDia; i++){
            const isActive = i <= totalDia;
            const isExpected = i <= expectedMachines;
            let cls = 'step';
            if(isActive) cls += ' active ' + bc;
            else if(isExpected) cls += ' expected';
          h += `<div class="${cls}"></div>`;
          }
          return h;
        })()}
      </div>
    </div>

    <div class="card-status-line">
      ${isDelayed 
        ? `<span class="${statusClass === 'red' ? 'status-warn' : 'status-near'}">⚠️ Atraso próxima: ${nextMachineTime || '--:--'}</span>` 
        : `<span class="status-next">✓ próxima: ${nextMachineTime || '--:--'}</span>`
      }
    </div>

    <div class="card-machine-info">
      <div class="machine-icon">🔧</div>
      <div class="machine-text">${equipName || 'NENHUM EQUIPAMENTO EM ANDAMENTO'}</div>
    </div>

    <div class="card-meta">
      ${(s.status === 'running' || s.status === 'paused') && s.selb ? `
      <div class="mitem">
        <div class="mlbl">Tempo O.S./SELB</div>
        <div class="mval t" id="m-timer-${uid}">${fmt(calcElapsedRunning(uid))}</div>
      </div>` : ''}
      <div class="mitem">
        <div class="mlbl">SELB ATUAL</div>
        <div class="mval">${s.selb || '—'}</div>
      </div>
      <div class="mitem">
        <div class="mlbl">Total Dia</div>
        <div class="mval">${totalDia}</div>
      </div>
      <div class="mitem">
        <div class="mlbl">T. Médio Modelo</div>
        <div class="mval">${getAvgModeloCard(equipName, u.sector)}</div>
      </div>
    </div>

    ${isRun && u.sector === 'COMPLEXA' ? `
    <div class="card-followup">
      <div class="mlbl" style="margin-bottom:6px">Acompanhamento</div>
      <div class="followup-log" id="flog-${uid}">${(hRun?.followup || 'Nenhum registro...').replace(/\[(\d{2}:\d{2})\]/g, '<b>[$1]</b>').replace(/\n/g, '<br>')}</div>
      ${(!isDisplay && !isAdmin) ? `<div style="display:flex;gap:6px">
        <input type="text" class="followup-inp" id="finp-${uid}" placeholder="O que está sendo feito?" onkeydown="if(event.key==='Enter') addFollowupEntry('${uid}')">
        <button class="btn-save-followup" onclick="addFollowupEntry('${uid}')">Salvar</button>
      </div>` : ''}
    </div>
    ` : ''}

    <div class="card-actions">
      ${isIdle&&canAct?`<button class="btn bp card-selb" data-uid="${uid}">Iniciar SELB</button>`:''}
      ${isRun&&canAct?`
        ${isAdmin?`<button class="btn bw card-pause" data-uid="${uid}">Pausar</button>`:''}
        <button class="btn bs card-fin" data-uid="${uid}">Finalizar</button>
        ${(u.sector==='MONTAGEM'||u.sector==='COMPLEXA')&&canAct?`<button class="btn" style="background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.35);color:var(--warn);font-size:11px;padding:7px 10px" onclick="abrirSolicitarPeca('${uid}')">🔩 Solicitar Peça</button>`:''}
      `:''}
      ${isPaus&&isAdmin?`<button class="btn bp card-pause" data-uid="${uid}">Retomar</button><button class="btn bs card-fin" data-uid="${uid}">Finalizar</button>`:''}
      ${isPaus&&!isAdmin?`<span class="idle-msg" style="color:var(--warn)">Pausado pelo admin</span>`:''}
      ${isIdle&&!canAct?`<span class="idle-msg">Aguardando</span>`:''}
    </div>`;
}

// ════ GOAL EFFECTS — serpente na borda + partículas flutuantes ════
(function(){
  const _effects = new Map(); // uid → { sparksRaf, fireRaf }

  /* ── PARTÍCULAS FLUTUANTES ────────────────────────────────────────── */
  function initSparks(uid){
    const canvas = document.getElementById('sparks-'+uid);
    if(!canvas) return null;
    const parent = canvas.closest('.card');
    if(!parent) return null;

    const W = parent.offsetWidth  || 240;
    const H = parent.offsetHeight || 180;
    canvas.width  = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    const colors = ['#3dd68c','#22d3ee','#6effc4','#a78bfa','#f0fdf4','#fff','#fbbf24','#f472b6'];
    const N = 40; // Mais partículas
    const particles = Array.from({length:N}, ()=>({
      x: Math.random()*W, y: Math.random()*H,
      r: 1.5 + Math.random()*3.5, // Partículas maiores
      vx: (Math.random()-.5)*0.8, vy: -0.5 - Math.random()*1.2, // Mais rápidas
      alpha: 0.6+Math.random()*0.4, color: colors[Math.floor(Math.random()*colors.length)],
      life: Math.random()*100, maxLife: 100+Math.random()*80,
      shape: Math.random()>0.4?'star':'circle'
    }));

    function drawStar(ctx,x,y,r,alpha,color){
      ctx.save(); ctx.globalAlpha=alpha; ctx.fillStyle=color;
      ctx.shadowColor=color; ctx.shadowBlur=6; ctx.translate(x,y);
      ctx.beginPath();
      for(let i=0;i<5;i++){
        const a=(i*4*Math.PI/5)-Math.PI/2, b=((i*4+2)*Math.PI/5)-Math.PI/2;
        i===0?ctx.moveTo(Math.cos(a)*r,Math.sin(a)*r):ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);
        ctx.lineTo(Math.cos(b)*r*.45,Math.sin(b)*r*.45);
      }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }

    function tick(){
      ctx.clearRect(0,0,W,H);
      particles.forEach(p=>{
        p.life+=1; p.x+=p.vx; p.y+=p.vy;
        const a = p.alpha*(1-p.life/p.maxLife);
        p.shape==='star' ? drawStar(ctx,p.x,p.y,p.r+1,a,p.color) : (()=>{
          ctx.save(); ctx.globalAlpha=a; ctx.fillStyle=p.color;
          ctx.shadowColor=p.color; ctx.shadowBlur=8;
          ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill(); ctx.restore();
        })();
        if(p.life>=p.maxLife){
          p.life=0; p.x=Math.random()*W; p.y=H-5+Math.random()*15;
          p.vx=(Math.random()-.5)*.35; p.vy=-.25-Math.random()*.55;
          p.color=colors[Math.floor(Math.random()*colors.length)];
          p.maxLife=80+Math.random()*60; p.shape=Math.random()>.5?'star':'circle';
        }
      });
      const raf = requestAnimationFrame(tick);
      if(_effects.has(uid)) _effects.get(uid).sparksRaf = raf;
    }

    return requestAnimationFrame(tick);
  }

  /* ── FOGO VERDE SUAVE — cobre o card inteiro ─────────────────────── */
  function initFire(uid){
    const canvas = document.getElementById('fire-'+uid);
    if(!canvas) return null;
    const card = canvas.closest('.card');
    if(!card) return null;

    function resize(){
      canvas.width  = card.offsetWidth;
      canvas.height = card.offsetHeight;
    }
    resize();
    const ctx = canvas.getContext('2d');

    // Grade de calor baseada no tamanho real do card
    const COLS = 20, ROWS = 28;
    let heat = Array.from({length:ROWS}, ()=>new Float32Array(COLS));

    function tick(){
      if(canvas.width !== card.offsetWidth || canvas.height !== card.offsetHeight) resize();
      const W = canvas.width, H = canvas.height;

      // Seed: base quente, mais intensa nas bordas laterais
      for(let c=0;c<COLS;c++){
        const edge = 1 - Math.abs((c/(COLS-1))*2 - 1); // mais quente no centro
        heat[ROWS-1][c] = 0.55 + edge*0.35 + Math.random()*0.1;
        heat[ROWS-2][c] = 0.3  + edge*0.25 + Math.random()*0.1;
      }
      // Difusão para cima
      for(let r=0;r<ROWS-2;r++){
        for(let c=0;c<COLS;c++){
          const l = heat[r+1][Math.max(0,c-1)];
          const m = heat[r+1][c];
          const ri= heat[r+1][Math.min(COLS-1,c+1)];
          const u = heat[r+2]?.[c] ?? 0;
          // Resfria mais rápido em cima (fogo não chega ao topo)
          const cool = 0.78 - (1 - r/ROWS)*0.15;
          heat[r][c] = ((l+m+m+ri+u)/5) * (cool + Math.random()*0.06);
        }
      }

      ctx.clearRect(0,0,W,H);
      const cw = W/COLS, ch = H/ROWS;

      for(let r=0;r<ROWS;r++){
        for(let c=0;c<COLS;c++){
          const v = Math.min(1, heat[r][c]);
          if(v < 0.05) continue;
          let red, green, blue, alpha;
          if(v < 0.3){
            const t = v/0.3;
            red=0; green=Math.round(t*180); blue=Math.round(t*80); alpha=t*0.6;
          } else if(v < 0.6){
            const t=(v-0.3)/0.3;
            red=Math.round(t*60); green=Math.round(180+t*75); blue=Math.round(80-t*40); alpha=0.6+t*0.2;
          } else {
            const t=(v-0.6)/0.4;
            red=Math.round(60+t*120); green=255; blue=Math.round(40+t*150); alpha=0.8+t*0.2;
          }
          ctx.fillStyle = `rgba(${red},${green},${blue},${alpha})`;
          // Brilho extra para chamas intensas
          if(v > 0.8) { ctx.shadowBlur = 10; ctx.shadowColor = `rgba(${red},${green},${blue},0.8)`; }
          else { ctx.shadowBlur = 0; }
          ctx.fillRect(c*cw, r*ch, cw+1, ch+1);
        }
      }

      const raf = requestAnimationFrame(tick);
      if(_effects.has(uid)) _effects.get(uid).fireRaf = raf;
    }

    return requestAnimationFrame(tick);
  }


  function stopEffects(uid){
    if(!_effects.has(uid)) return;
    const e = _effects.get(uid);
    if(e.sparksRaf) cancelAnimationFrame(e.sparksRaf);
    if(e.fireRaf)   cancelAnimationFrame(e.fireRaf);
    _effects.delete(uid);
  }

  // Rastreia quais uids estão na janela de 10s de celebração
  const _celebratingUids = new Map(); // uid -> timeout id

  window.playCelebration = function(uid){
    const u = users.find(x => x.id === uid);
    if(!u) return;

    // Som de celebração via AudioContext (sem dependência externa)
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      [[523,0],[659,0.18],[784,0.36],[1047,0.54]].forEach(([freq, t]) => {
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain); gain.connect(audioCtx.destination);
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.4, audioCtx.currentTime + t);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + t + 0.3);
        osc.start(audioCtx.currentTime + t);
        osc.stop(audioCtx.currentTime + t + 0.3);
      });
    } catch(e){ console.warn('Som bloqueado pelo navegador:', e); }

    // Cancela timeout anterior se houver (evita sobreposição)
    if(_celebratingUids.has(uid)){
      clearTimeout(_celebratingUids.get(uid));
    }

    // Ativa efeitos visuais (canvas)
    stopEffects(uid);
    _effects.set(uid, { sparksRaf: initSparks(uid), fireRaf: initFire(uid) });

    // Aplica a classe de piscar e agenda remoção após 10s
    const applyAnim = () => {
      const card = document.getElementById('card-'+uid);
      if(card) card.classList.add('goal-reached-anim');
    };
    applyAnim();

    const tid = setTimeout(() => {
      const card = document.getElementById('card-'+uid);
      if(card) card.classList.remove('goal-reached-anim');
      stopEffects(uid);
      _celebratingUids.delete(uid);
    }, 10000);
    _celebratingUids.set(uid, tid);

    console.log('🎉 META ATINGIDA POR ' + u.name + '!');
  };

  const _origRenderCard = window.renderCard;
  window.renderCard = function(uid){
    _origRenderCard.apply(this, arguments);
    // Se esse uid ainda está na janela de celebração, reaplica a classe após o re-render
    if(_celebratingUids.has(uid)){
      const card = document.getElementById('card-'+uid);
      if(card) card.classList.add('goal-reached-anim');
    }
  };
})();

// ════ SELB ACTIONS ════
function previewEquip(code){
  const preview  = document.getElementById('equip-preview');
  const notfound = document.getElementById('equip-notfound');
  const nameEl   = document.getElementById('equip-preview-name');
  const nome     = getEquipName(code);
  if(code.length < 2){
    preview.style.display  = 'none';
    notfound.style.display = 'none';
    return;
  }
  if(nome){
    nameEl.textContent     = nome;
    preview.style.display  = 'flex';
    notfound.style.display = 'none';
  } else {
    preview.style.display  = 'none';
    notfound.style.display = 'block';
  }
}

function openSelb(uid){
  actionUid=uid;
  const u=users.find(x=>x.id===uid);
  const isElet = u.sector === 'ELETRÔNICA';
  document.getElementById('mselb-title').textContent = isElet ? 'Iniciar SELB / O.S.' : 'Iniciar SELB';
  document.getElementById('mselb-sub').textContent = u.name+' · '+u.sector;
  document.getElementById('mselb-inp').value='';
  document.getElementById('equip-preview').style.display='none';
  document.getElementById('equip-notfound').style.display='none';
  document.getElementById('mselb-dest').value='revisao';
  document.getElementById('mselb-motivo').value='';
  document.getElementById('scrap-field').style.display='none';
  // O.S. só aparece para Eletrônica
  document.getElementById('os-field').style.display = isElet ? 'block' : 'none';
  document.getElementById('mselb-os').value = '';
  document.getElementById('modal-selb').classList.remove('hidden');
  setTimeout(()=>{
    if(isElet) document.getElementById('mselb-os').focus();
    else       document.getElementById('mselb-inp').focus();
  },100);
}
function toggleScrap(){
  document.getElementById('scrap-field').style.display=
    document.getElementById('mselb-dest').value==='scrap'?'block':'none';
}
// ════════════════════════════════════════
// ANTI-FRAUDE — bloqueio por uso excessivo
// Se um usuário iniciar 6 SELBs em menos de 2 minutos, é bloqueado por 5 minutos.
// ════════════════════════════════════════
const _selbTimestamps = {}; // uid → [epoch, epoch, ...]
let   _bloqueioTimer  = null;

function registrarSelbInicio(uid){
  const now = Date.now();
  if(!_selbTimestamps[uid]) _selbTimestamps[uid] = [];

  // Mantém apenas os últimos 2 minutos
  _selbTimestamps[uid] = _selbTimestamps[uid].filter(t => now - t < 2 * 60 * 1000);
  _selbTimestamps[uid].push(now);

  if(_selbTimestamps[uid].length >= 6){
    _selbTimestamps[uid] = []; // reset
    ativarBloqueio(uid);
    return false; // bloqueado
  }
  return true; // permitido
}

function ativarBloqueio(uid){
  const u = users.find(x => x.id === uid);
  const nome = u ? u.name : 'Usuário';
  let secs = 5 * 60;

  // Bloqueia no Firebase para todas as telas
  dbPatch('/users/'+uid, {_bloqueado: true, _bloqueadoAte: Date.now() + secs*1000}).catch(()=>{});

  document.getElementById('modal-bloqueado').classList.remove('hidden');
  document.getElementById('bloquio-countdown').textContent = '05:00';

  if(_bloqueioTimer) clearInterval(_bloqueioTimer);
  _bloqueioTimer = setInterval(() => {
    secs--;
    const m = Math.floor(secs/60), s = secs%60;
    document.getElementById('bloquio-countdown').textContent =
      String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
    if(secs <= 0){
      clearInterval(_bloqueioTimer);
      _bloqueioTimer = null;
      dbPatch('/users/'+uid, {_bloqueado: false, _bloqueadoAte: null}).catch(()=>{});
      document.getElementById('modal-bloqueado').classList.add('hidden');
    }
  }, 1000);
}

// ════════════════════════════════════════
// BACKUP / RESTAURAÇÃO
// Exporta o histórico do dia atual como JSON e permite reimportá-lo.
// ════════════════════════════════════════
async function listarBackups(){
  document.getElementById('modal-backups').classList.remove('hidden');
  const list = document.getElementById('backup-list');
  list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:10px">Carregando backups...</div>';
  try {
    const data = await dbGet('/backups');
    if(!data){
      list.innerHTML='<div class="empty">Nenhum backup encontrado no Firebase.</div>';
      return;
    }
    const backups = Object.entries(data)
      .map(([dk, b]) => ({dk, ...b}))
      .sort((a,b) => new Date(b.savedAt) - new Date(a.savedAt));

    list.innerHTML = backups.map(b => {
      const date  = b.dateKey ? b.dateKey.replace(/_/g,' ') : b.dk;
      const saved = b.savedAt ? new Date(b.savedAt).toLocaleString('pt-BR') : '—';
      const motivo= b.motivo === 'fim-expediente' ? '🌙 Fim expediente' :
                    b.motivo === 'zerar-dia-manual' ? '🗑️ Antes de zerar' : b.motivo||'—';
      const recCount = b.history ? Object.keys(b.history).length : '?';
      return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:600;font-size:13px">${date}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${saved} · ${motivo} · ${recCount} registros</div>
        </div>
        <button class="btn bp" style="font-size:11px;padding:6px 12px;white-space:nowrap"
          onclick="restaurarBackupFirebase('${b.dk}')">Restaurar</button>
      </div>`;
    }).join('');
  } catch(e){
    list.innerHTML='<div style="color:var(--danger);font-size:12px">Erro ao carregar: '+e.message+'</div>';
  }
}

async function restaurarBackupFirebase(dateKey){
  if(!confirm('⚠️ Restaurar o backup de "'+dateKey.replace(/_/g,' ')+'"?\n\nIsso vai substituir os dados do dia atual.')){
    return;
  }
  closeModal('modal-backups');
  showLoader('Restaurando backup...');
  try {
    const backup = await dbGet('/backups/'+dateKey);
    if(!backup || !backup.history) throw new Error('Backup inválido ou vazio.');
    await dbSet('/history/'+dateKey, backup.history);
    if(backup.userCounters){
      for(const [uid, c] of Object.entries(backup.userCounters)){
        await dbPatch('/users/'+uid, {totalDia: c.totalDia||0, repDia: c.repDia||0}).catch(()=>{});
      }
    }
    await dbSet('/meta/lastResetDay', dateKey.replace(/_/g,' ')).catch(()=>{});
    hideLoader();
    alert('✅ Backup restaurado!\nDia: '+dateKey.replace(/_/g,' ')+'\n\nA página será recarregada.');
    setTimeout(()=>location.reload(), 1500);
  } catch(e){
    showError('Erro ao restaurar: '+e.message);
  }
}

async function importarBackupArquivo(input){
  const file = input.files[0];
  if(!file) return;
  if(!confirm('⚠️ Restaurar a partir do arquivo "'+file.name+'"?\n\nIsso vai substituir os dados do dia.')){
    input.value=''; return;
  }
  closeModal('modal-backups');
  showLoader('Restaurando backup...');
  try {
    const text   = await file.text();
    const backup = JSON.parse(text);
    if(!backup.dateKey || !backup.history) throw new Error('Arquivo de backup inválido.');
    await dbSet('/history/'+backup.dateKey, backup.history);
    if(backup.users){
      for(const [uid, udata] of Object.entries(backup.users)){
        await dbPatch('/users/'+uid, {totalDia:udata.totalDia||0, repDia:udata.repDia||0}).catch(()=>{});
      }
    }
    await dbSet('/meta/lastResetDay', backup.dateKey.replace(/_/g,' ')).catch(()=>{});
    hideLoader();
    input.value='';
    alert('✅ Backup restaurado!\nA página será recarregada.');
    setTimeout(()=>location.reload(), 1500);
  } catch(e){
    showError('Erro ao restaurar: '+e.message);
    input.value='';
  }
}


// Converte "HH:MM:SS" para segundos totais do dia
function timeStrToSec(t){
  if(!t) return null;
  const clean = t.replace(',','.').trim();
  const p = clean.split(':').map(s => parseInt(s, 10));
  if(p.length < 2 || p.some(isNaN)) return null;
  return (p[0]||0)*3600 + (p[1]||0)*60 + (p[2]||0);
}

// Calcula a duração real de um registro para EXIBIÇÃO na consulta e relatórios.
// Prioridade: startEpoch→end (mais preciso) → start→end por relógio → duracao salva.
// Retorna string formatada "HH:MM:SS" ou "—" se não for possível calcular.
function calcDuracaoExibir(h){
  // SCRAP: duração irrelevante — exibe '—'
  if(h.status === 'scrap') return '—';

  // 1. Fonte principal: duracao salva — calculada no momento da conclusão
  if(h.duracao && h.duracao !== '00:00:00') return h.duracao;

  // 2. endEpoch - startEpoch (sem pausas, menos preciso)
  if(h.endEpoch && h.startEpoch && h.endEpoch > h.startEpoch){
    const diffSec = Math.round((h.endEpoch - h.startEpoch) / 1000);
    if(diffSec > 0 && diffSec < 86400 * 2) return fmt(diffSec);
  }

  // 3. Diferença start→end por relógio (proteção contra bug locale start===end)
  if(h.start && h.end){
    const sS = timeStrToSec(h.start);
    const eS = timeStrToSec(h.end);
    if(sS !== null && eS !== null){
      let diffSec = eS - sS;
      if(diffSec < 0) diffSec += 86400;
      if(diffSec > 0 && diffSec < 82800) return fmt(diffSec);
    }
  }

  return '—';
}


// Detecta registros 'cancelado' com duração absurda (>2h) que foram
// fechados pelo checkDayReset com cálculo errado, e recalcula a duração
// correta usando start→17:30 (fim de expediente).
// ════════════════════════════════════════
async function restaurarCanceladosIndevidos(){
  if(!confirm('Verificar e corrigir SELBs cancelados com duração incorreta nos últimos 7 dias?')) return;
  showLoader('Analisando registros...');
  const today = new Date();
  const workEnd = String(SCHEDULE.work.end[0]).padStart(2,'0') + ':' +
                  String(SCHEDULE.work.end[1]).padStart(2,'0') + ':00';
  const workEndSec = timeStrToSec(workEnd);
  let corrigidos = 0, verificados = 0;

  for(let i = 1; i <= 7; i++){
    const d = new Date(today); d.setDate(today.getDate() - i);
    const dk = d.toDateString().replace(/ /g,'_');
    try {
      const data = await dbGet('/history/'+dk);
      if(!data) continue;
      const recs = Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      for(const h of recs){
        if(h.status !== 'cancelado' || !h.duracao || !h.start) continue;
        verificados++;
        const durSec = timeStrToSec(h.duracao);
        if(!durSec) continue;
        // Duração esperada máxima: do início até 17:30
        const startSec = timeStrToSec(h.start);
        if(startSec === null) continue;
        const maxEsperado = Math.max(0, workEndSec - startSec);
        // Se duração salva for mais de 60s além do esperado → estava errada
        if(durSec > maxEsperado + 60){
          const durCorreta = fmt(maxEsperado);
          await dbPatch('/history/'+dk+'/'+h._docId, {
            end: workEnd, duracao: durCorreta
          }).catch(()=>{});
          corrigidos++;
        }
      }
    } catch(e){ continue; }
  }
  hideLoader();
  if(corrigidos > 0){
    alert(`✅ ${corrigidos} registro(s) corrigidos de ${verificados} analisados.
Os relatórios agora mostrarão os tempos corretos.`);
    // Rebuild cards para refletir correções sem recriar listeners
    buildCards(); updateSummary();
  } else {
    alert(`Verificados ${verificados} registros — nenhuma duração incorreta encontrada.`);
  }
}

// ════ RESET CONFIG FIREBASE ════
async function resetConfig(){
  if(!currentUser || !currentUser.isAdmin) return;
  const opcao = window.confirm(
    '🔥 Manutenção Firebase\n\n' +
    'Clique OK para recarregar os dados do Firebase agora\n' +
    '(equipamentos, excluídos de média e contadores de usuários).\n\n' +
    'Os dados de histórico e usuários NÃO serão apagados.'
  );
  if(!opcao) return;
  showLoader('Recarregando configurações do Firebase...');
  try {
    // Recarrega equipamentos
    await loadEquipamentos();
    // Recarrega SELBs excluídos da média
    _selbsExcluidos.clear();
    const excl = await dbGet('/config/modelo_selbs_excluidos').catch(()=>null);
    if(excl && typeof excl === 'object'){
      Object.keys(excl).forEach(docId => { if(excl[docId]===true) _selbsExcluidos.add(docId); });
    }
    // Invalida cache do relatório de modelo para forçar recarga
    _modeloAllRecs = [];
    hideLoader();
    renderEquipTable();
    alert('✅ Configurações recarregadas!\n\n• Equipamentos: ' + Object.keys(equipamentos).length + ' registros\n• SELBs excluídos da média: ' + _selbsExcluidos.size);
  } catch(e){
    showError('Erro ao recarregar: ' + e.message);
  }
}

async function exportarBackup(){
  try {
    const dateKey = new Date().toDateString().replace(/ /g,'_');
    const histData  = await dbGet('/history/'+dateKey);
    const usersData = await dbGet('/users');
    const backup = {
      version:   2,
      exportedAt: new Date().toISOString(),
      dateKey,
      history:   histData  || {},
      users:     usersData || {}
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type:'application/json'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'backup-selbetti-'+dateKey+'.json';
    a.click();
    URL.revokeObjectURL(url);
    hideLoader();
    alert('✅ Backup exportado com sucesso!');
  } catch(e){
    showError('Erro ao exportar: '+e.message);
  }
}

async function confirmarInicio(){
  const btn = document.querySelector('#modal-selb .bp');
  const txtOriginal = btn ? btn.textContent : '';
  
  const setBtn = (dis, txt) => {
    if(!btn) return;
    btn.disabled = dis;
    if(txt !== undefined) btn.textContent = txt;
  };

  if(window._submittingSelb) return;
  window._submittingSelb = true;

  if(btn && btn.disabled) {
    window._submittingSelb = false;
    return;
  }
  setBtn(true, 'Validando...');

  try {

  const u_action=users.find(x=>x.id===actionUid);
  const isElet = u_action && u_action.sector === 'ELETRÔNICA';
  const dest=document.getElementById('mselb-dest').value;
  const motivo=document.getElementById('mselb-motivo').value.trim();
  const selb=document.getElementById('mselb-inp').value.trim();
  const osNum = isElet ? document.getElementById('mselb-os').value.trim() : '';

  // Valida SELB (obrigatório para todos)
  if(!selb){ alert('Informe o código SELB'); return; }
  if(dest!=='scrap' && !getEquipName(selb)){
    document.getElementById('mselb-inp').style.borderColor='var(--danger)';
    setTimeout(()=>document.getElementById('mselb-inp').style.borderColor='',1500);
    alert('SELB não cadastrado no sistema.\nSolicite ao administrador cadastrá-lo na aba Equipamentos.');
    return;
  }
  // Valida O.S. obrigatório para Eletrônica
  if(isElet && !osNum){
    document.getElementById('mselb-os').focus();
    document.getElementById('mselb-os').style.borderColor='var(--danger)';
    setTimeout(()=>document.getElementById('mselb-os').style.borderColor='rgba(34,211,238,.4)',1500);
    alert('Informe o Número da O.S.');
    return;
  }
  if(dest==='scrap'&&!motivo){ document.getElementById('mselb-motivo').focus(); alert('Informe o motivo do descarte.'); return; }

  // ── Verificar se é uma máquina perdida ──────────────────────────────────
  if(dest !== 'scrap'){
    const bloqueadoPorPerdida = verificarMaquinaPerdida(selb, actionUid);
    if(bloqueadoPorPerdida){
      closeModal('modal-selb'); // fecha o modal de SELB
      return; // mostra alerta de máquina encontrada
    }
  }

  // ── Se o dashboard foi zerado, limpa o filtro para novos SELBs aparecerem ──
  if(_dashboardZerado){
    _dashboardZerado = false;
    localStorage.removeItem('sb_dashboard_zerado_em');
    localStorage.removeItem('sb_dashboard_zerado_dia');
    buildCards(); updateSummary();
  }

  // ── Anti-fraude: bloqueia se 6 SELBs em < 2 minutos (não se aplica ao admin) ──
  const _isAdminAction = currentUser && currentUser.isAdmin;
  if(!_isAdminAction && !registrarSelbInicio(actionUid)){
    closeModal('modal-selb');
    return;
  }

  // ════════════════════════════════════════════════════════════════
  // VERIFICAÇÃO FIREBASE-FIRST: consulta o estado real do servidor
  // antes de registrar, para evitar duplicatas quando a aba do
  // navegador está desatualizada e o usuário clica duas vezes.
  // ════════════════════════════════════════════════════════════════
  if(dest !== 'scrap'){
    try {
      const dateKey = new Date().toDateString().replace(/ /g,'_');

      // 1) Lê o nó do usuário direto do Firebase (estado live)
      const fbUser = await dbGet('/users/'+actionUid);

      // 2) Se o Firebase diz que este usuário já está em 'running',
      //    verifica se existe um SELB concluído hoje antes de permitir novo início
      if(fbUser && fbUser._status === 'running'){
        // Busca o histórico do dia direto do Firebase para verificar SELBs concluídos
        const fbHistory = await dbGet('/history/'+dateKey);
        const recs = fbHistory
          ? Object.entries(fbHistory).map(([k,v])=>({...v,_docId:k,_dateKey:dateKey}))
          : [];

        // Verifica se existe pelo menos um SELB finalizado como 'ok' para este usuário hoje
        const temConcluido = recs.some(r => r.uid === actionUid && r.status === 'ok');

        if(!temConcluido){
          // Não há nenhum SELB concluído — possivelmente aba desatualizada.
          // Cancela o running fantasma e bloqueia novo início.
          const runningNoFb = recs.find(r => r.uid === actionUid && r.status === 'running');
          if(runningNoFb){
            // Atualiza o array local e o Firebase para refletir o estado real
            const localOrphan = history.find(h => h._docId === runningNoFb._docId);
            if(localOrphan) localOrphan.status = 'running'; // já está lá, deixa o fechamento abaixo agir
            else history.unshift({...runningNoFb});
          }
          // Sincroniza wstate local com o Firebase
          const s2 = getS(actionUid);
          s2.status     = 'running';
          s2.selb       = fbUser._selb || s2.selb || null;
          s2.startEpoch = fbUser._startEpoch || s2.startEpoch || Date.now();
          renderCard(actionUid);
          alert('⚠️ Atenção: este operador já possui um SELB em andamento.\n\nFinalize o SELB atual antes de iniciar um novo.');
          closeModal('modal-selb');
          return;
        }

        // Existe pelo menos um 'ok' hoje: cancela o running em aberto no Firebase
        // e segue normalmente para registrar o novo SELB.
        const now2 = new Date();
        if(fbUser._selb){
          // Cancela o registro running no histórico do Firebase, se houver
          const runOrphan = recs.find(r => r.uid === actionUid && r.status === 'running');
          if(runOrphan){
            const orphEnd = now2.toLocaleTimeString('pt-BR');
            const orphStart = runOrphan.startEpoch || 0;
            let orphElapsed = orphStart ? Math.max(0, Math.floor((Date.now() - orphStart)/1000)) : 0;
            if(runOrphan.start){
              const oSS = timeStrToSec(runOrphan.start);
              const oES = timeStrToSec(orphEnd);
              if(oSS!==null && oES!==null){
                let od = oES-oSS; if(od<0) od+=86400;
                if(od>=0 && od<86400 && Math.abs(orphElapsed-od)>60) orphElapsed=od;
              }
            }
            await dbUpdateHistory(runOrphan._docId, runOrphan._dateKey,
              {end:orphEnd, duracao:fmt(orphElapsed), status:'ok'}).catch(()=>{});
            // Atualiza memória local
            const localRef = history.find(h=>h._docId===runOrphan._docId);
            if(localRef){ localRef.status='ok'; localRef.end=orphEnd; localRef.duracao=fmt(orphElapsed); }
          }
        }
        // Reseta o wstate local para refletir idle antes do novo início
        const s3 = getS(actionUid);
        s3.status='idle'; s3.selb=null; s3.elapsed=0; s3.startEpoch=null;
      }

      // 3) Sincroniza o history[] local com os registros do Firebase para garantir
      //    que o fechamento de orphans locais (abaixo) use dados atualizados
      const fbHistSync = await dbGet('/history/'+dateKey);
      if(fbHistSync){
        const fbRecs = Object.entries(fbHistSync).map(([k,v])=>({...v,_docId:k,_dateKey:dateKey}));
        // Adiciona ao history[] qualquer registro running do Firebase que não esteja local
        fbRecs.filter(r=>r.uid===actionUid&&r.status==='running').forEach(r=>{
          if(!history.find(h=>h._docId===r._docId)) history.unshift(r);
        });
      }
    } catch(e){
      // Falha na consulta Firebase — continua normalmente (comportamento anterior)
      console.warn('[SELB] Verificação Firebase-first falhou, continuando:', e);
    }
  }
  // ════════════════════════════════════════════════════════════════

  const s=getS(actionUid); const u=users.find(x=>x.id===actionUid);
  const now=new Date();
  if(dest==='scrap'){
    u.repDia++;
    const _writeTs = Date.now();
    u._localRepDia   = u.repDia;
    u._lastWriteTs   = _writeTs;
    const rec={selb,uid:actionUid,name:u.name,pin:u.pin,code:u.code||'',local:u.local||'',sector:u.sector,
      start:now.toLocaleTimeString('pt-BR'),end:now.toLocaleTimeString('pt-BR'),duracao:'00:00:00',status:'scrap',motivo,startEpoch:Date.now(),
      ...(osNum ? {osNum} : {})
    };
    const {key,dateKey}=await dbAddHistory(rec);
    const fullRec = {...rec,_docId:key,_dateKey:dateKey};
    history.unshift(fullRec);
    if(!_consultaDateKey || _consultaDateKey === dateKey){
      _consultaRecords = [fullRec, ..._consultaRecords.filter(r=>r._docId!==key)];
    }
    await dbPatch('/users/'+actionUid, {repDia: u.repDia, _lastWriteTs: _writeTs});
    // ── FluxoLAB: remove SELB de todos os bolsões ao registrar SCRAP e registra no log ──
    fluxolabFinalizarSelb(selb, u.sector, 'scrap').catch(e => console.warn('[FluxoLAB] Erro ao remover SCRAP dos bolsões:', e));
    closeModal('modal-selb'); updateSummary(); renderConsulta(); return;
  }
  // ── Fecha qualquer SELB anterior ainda em 'running' do mesmo usuário ──
  // Evita registros fantasma quando operador inicia novo SELB sem finalizar o anterior.
  const orphans = history.filter(x => x.uid === actionUid && x.status === 'running');
  for(const orphan of orphans){
    const orphanEnd  = now.toLocaleTimeString('pt-BR');
    const orphanStart = orphan.startEpoch || 0;
    // Calcula duração via sanidade: usa diff de relógio se epoch parece errado
    let orphanElapsed = orphanStart ? Math.max(0, Math.floor((Date.now() - orphanStart) / 1000)) : 0;
    if(orphan.start){
      const oStartSec = timeStrToSec(orphan.start);
      const oEndSec   = timeStrToSec(orphanEnd);
      if(oStartSec !== null && oEndSec !== null){
        let oDiff = oEndSec - oStartSec;
        if(oDiff < 0) oDiff += 86400;
        if(oDiff >= 0 && oDiff < 86400 && Math.abs(orphanElapsed - oDiff) > 60){
          orphanElapsed = oDiff;
        }
      }
    }
    orphan.status = 'ok';
    await dbUpdateHistory(orphan._docId, orphan._dateKey, {
      end: orphanEnd, duracao: fmt(orphanElapsed), status: 'ok'
    });
  }

  // ── Puxar duração anterior se o SELB estava 'aguardando peças' ──
  // e remover da aba Aguardando Peças / Máquinas A ao iniciar
  let initialElapsed = 0;

  // Remove TODOS os registros 'aguardando' deste SELB (não só se tiver duração)
  const todosAguardando = history.filter(h => h.selb === selb && h.status === 'aguardando');
  for(const prevAg of todosAguardando){
    if(prevAg.duracao && !initialElapsed){
      initialElapsed = timeStrToSec(prevAg.duracao) || 0;
    }
    // Marca como 'ok' para sair da aba Aguardando Peças
    await dbUpdateHistory(prevAg._docId, prevAg._dateKey, { status: 'ok' }).catch(()=>{});
    prevAg.status = 'ok';
  }

  // Remove da aba Máquinas A se o SELB estiver lá como ativo
  const maqAEntrada = Object.entries(_maquinasA).find(([, m]) => m.selb === selb && m.status === 'ativa');
  if(maqAEntrada){
    const [maqAId] = maqAEntrada;
    try {
      await dbDelete('/maquinas_a/' + maqAId);
      delete _maquinasA[maqAId];
    } catch(e){ console.warn('[SELB] Erro ao remover de Máquinas A:', e); }
  }

  const _epoch = Date.now();
  s.selb=selb; s.status='running'; s.elapsed=initialElapsed; s.meta=60; s.startEpoch=_epoch;
  if(typeof _localTimerClear==='function') _localTimerClear(actionUid); s._frozenElapsed=initialElapsed; s._activeFrom=_epoch;
  s._pauseAccum=0; s._pausedAt=null; 
  // startEpoch is saved inside the history record so it survives as fallback after reload
  const equipNome = getEquipName(selb) || '';

  // ── Detecta retrabalho: existe reprovação pendente deste SELB para este usuário? ──
  const reprovPendente = history.find(h =>
    h.status === 'rep' &&
    h.selb === selb &&
    h._reprovadoUid === actionUid &&
    h._aguardandoRetrabalho === true
  );

  const rec={selb,uid:actionUid,name:u.name,pin:u.pin,code:u.code||'',local:u.local||'',
    sector:u.sector,start:now.toLocaleTimeString('pt-BR'),end:null,duracao:null,
    status:'running',motivo:'',startEpoch:_epoch,equipamento:equipNome,
    ...(osNum ? {osNum} : {}),
    ...(reprovPendente ? {_retrabalhoDeReprov: reprovPendente._docId} : {})
  };
  const {key,dateKey}=await dbAddHistory(rec);
  const fullRec2 = {...rec,_docId:key,_dateKey:dateKey};
  history.unshift(fullRec2);
  // Sempre adiciona à Consulta também
  if(!_consultaDateKey || _consultaDateKey === dateKey){
    _consultaRecords = [fullRec2, ..._consultaRecords.filter(r=>r._docId!==key)];
  }
  // Also persist on user node for fast-path restore on next reload
  await dbPatch('/users/'+actionUid, {_selb:selb, _status:'running', _startEpoch:_epoch, _elapsed:0, _frozenElapsed:0, _activeFrom:_epoch, _pausedAt:null, _pauseAccum:0});
  startTimer(actionUid); renderCard(actionUid); closeModal('modal-selb'); updateSummary();
  // ── FluxoLAB: registra SELB no bolsão do setor ──
  fluxolabRegistrarSelb(selb, actionUid).catch(()=>{});
  // Atualiza abas Aguardando Peças e Máquinas A se o SELB estava em alguma delas
  if(todosAguardando.length > 0){
    if(document.getElementById('view-pecas')?.classList.contains('active')) renderPecasView();
    if(typeof renderPecasSubView === 'function') renderPecasSubView();
  }
  if(maqAEntrada && typeof renderMaquinasAView === 'function') renderMaquinasAView();
  // Atualiza tela de operador se for o usuário logado
  if(currentUser && !currentUser.isAdmin && currentUser.id === actionUid &&
     document.getElementById('view-operador').classList.contains('active')){
    opRenderState(actionUid);
  }

  } catch (err) {
    console.error('Erro ao iniciar SELB:', err);
    alert('Erro ao iniciar SELB: ' + err.message);
  } finally {
    window._submittingSelb = false;
    setBtn(false, txtOriginal);
  }
}
// ── Checklist obrigatório para MONTAGEM antes de finalizar ──────
let _pendingFinUid = null; // uid aguardando confirmação do checklist

function openFin(uid){
  const u = users.find(x => x.id === uid);
  // Exibe checklist apenas para MONTAGEM finalizando como "ok"
  if (u && u.sector === 'MONTAGEM') {
    _pendingFinUid = uid;
    // Desmarca todos os checkboxes
    ['chk-roletes','chk-parafusos','chk-qualidade-impressao','chk-copia','chk-dobradicaardf','chk-fusao']
      .forEach(id => { const el = document.getElementById(id); if(el) el.checked = false; });
    const errEl = document.getElementById('checklist-montagem-err');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    document.getElementById('modal-checklist-montagem').classList.remove('hidden');
    return;
  }
  _openFinDirect(uid);
}

function confirmarChecklistMontagem(){
  const ids = ['chk-roletes','chk-parafusos','chk-qualidade-impressao','chk-copia','chk-dobradicaardf','chk-fusao'];
  const labels = ['Roletes','Parafusos','Qualidade de impressão','Cópia','Dobradiça ARDF','Verificação visual da fusão'];
  const errEl = document.getElementById('checklist-montagem-err');
  const pendentes = ids.map((id, i) => document.getElementById(id)?.checked ? null : labels[i]).filter(Boolean);
  if (pendentes.length) {
    if (errEl) {
      errEl.textContent = '⚠️ Confirme todos os itens: ' + pendentes.join(', ');
      errEl.style.display = 'block';
    }
    return;
  }
  closeModal('modal-checklist-montagem');
  _openFinDirect(_pendingFinUid);
  _pendingFinUid = null;
}

function _openFinDirect(uid){
  actionUid=uid;
  const s=getS(uid); const u=users.find(x=>x.id===uid);
  const hRun = history.find(x=>x.uid===uid&&x.status==='running');
  const osNum = hRun && hRun.osNum ? hRun.osNum : '';
  const isElet = u.sector === 'ELETRÔNICA';
  document.getElementById('mfin-sub').textContent= isElet && osNum
    ? 'SELB: '+s.selb+' · O.S.: '+osNum+' — '+u.name
    : 'SELB: '+s.selb+' — '+u.name;
  document.getElementById('mfin-result').value='ok';
  document.getElementById('fin-scrap-field').style.display='none';
  document.getElementById('fin-cancelado-field').style.display='none';
  document.getElementById('mfin-motivo').value='';
  document.getElementById('mfin-motivo-cancelado').value='';
  document.getElementById('mfin-comentario').value='';
  // Opção "Cancelar" visível apenas para admin
  const optCanc = document.getElementById('mfin-opt-cancelado');
  if(optCanc) optCanc.style.display = (currentUser && currentUser.isAdmin) ? '' : 'none';
  document.getElementById('modal-finish').classList.remove('hidden');
}
function toggleFinScrap(){
  const res = document.getElementById('mfin-result').value;
  document.getElementById('fin-scrap-field').style.display      = res === 'scrap'      ? 'block' : 'none';
  document.getElementById('fin-cancelado-field').style.display  = res === 'cancelado'  ? 'block' : 'none';
}
async function confirmarFin(){
  const btn = document.querySelector('#modal-finish .bp');
  const txtOriginal = btn ? btn.textContent : '';
  
  const setBtn = (dis, txt) => {
    if(!btn) return;
    btn.disabled = dis;
    if(txt !== undefined) btn.textContent = txt;
  };

  if(window._submittingSelb) return;
  window._submittingSelb = true;

  if(btn && btn.disabled) {
    window._submittingSelb = false;
    return;
  }
  setBtn(true, 'Validando...');

  try {

  const res=document.getElementById('mfin-result').value;
  // Motivo: scrap usa mfin-motivo, cancelado usa mfin-motivo-cancelado
  let motivo = '';
  if(res === 'scrap')     motivo = document.getElementById('mfin-motivo').value.trim();
  if(res === 'cancelado') motivo = document.getElementById('mfin-motivo-cancelado').value.trim();
  const comentario=document.getElementById('mfin-comentario').value.trim();
  if(res==='scrap'&&!motivo){ document.getElementById('mfin-motivo').focus(); alert('Informe o motivo do descarte.'); return; }
  if(res==='cancelado'&&!motivo){ document.getElementById('mfin-motivo-cancelado').focus(); alert('Informe o motivo do cancelamento.'); return; }
  if(res==='cancelado'&&!(currentUser&&currentUser.isAdmin)){ alert('Apenas administradores podem cancelar um SELB.'); return; }
  const s=getS(actionUid); const u=users.find(x=>x.id===actionUid);
  // ── Captura o SELB atual ANTES de qualquer await (evita race condition com listener Firebase) ──
  const selbAtualSnapshot = s.selb;
  // ── Anti-duplicata: bloqueia "Aguardando Peças" se SELB já está em Máquinas A ──
  if(res === 'aguardando'){
    const selbAtual = selbAtualSnapshot;
    const emMaquinaA = Object.values(_maquinasA).find(m => m.selb === selbAtual && m.status === 'ativa');
    if(emMaquinaA){
      alert('⚠️ Atenção: o SELB "' + selbAtual + '" já está registrado como Máquina A.\n\nUm SELB não pode estar em ambas as abas ao mesmo tempo.\nSe necessário, remova-o de Máquinas A antes de mover para Aguardando Peças.');
      return;
    }
  }
  const h=history.find(x=>x.selb===selbAtualSnapshot&&x.uid===actionUid&&x.status==='running');
  const endTime=new Date().toLocaleTimeString('pt-BR');
  // Elapsed: usa h.startEpoch (Firebase) como fonte mais confiável;
  // s.startEpoch pode estar desatualizado se outra tela retomou a pausa.
  const now_fin = Date.now();

  // Duração = mesmo cálculo do timer exibido no card
  const duracaoFinal = calcElapsedRunning(actionUid);
  const duracao = fmt(duracaoFinal);

  if(h){
    const endEpoch   = Date.now();
    const endDateKey = new Date(endEpoch).toDateString().replace(/ /g,'_');
    h.end=endTime; h.duracao=duracao; h.status=res; h.motivo=motivo||''; h._closed=true; h.endEpoch=endEpoch; h.endDateKey=endDateKey;
    if(comentario) h.comentario=comentario;
    await dbUpdateHistory(h._docId, h._dateKey, {
      end:endTime, duracao, status:res, motivo:motivo||'', endEpoch, endDateKey,
      ...(comentario ? {comentario} : {})
    });
  }

  // ── Se era retrabalho, grava o tempo no registro de reprovação e limpa a flag ──
  if(h && h._retrabalhoDeReprov){
    const repRec = history.find(r => r._docId === h._retrabalhoDeReprov && r.status === 'rep');
    if(repRec){
      repRec._duracaoRetrabalho   = duracao;
      repRec._aguardandoRetrabalho = false;
      await dbUpdateHistory(repRec._docId, repRec._dateKey, {
        _duracaoRetrabalho:   duracao,
        _aguardandoRetrabalho: false
      }).catch(()=>{});
    }
  }

  // ── Se finalizado como aprovado, resolve qualquer pendência de 'aguardando peça' deste SELB ──
  if(res === 'ok' && h && h.selb){
    const pendingPeca = history.filter(x => x.selb === h.selb && x.status === 'aguardando');
    for(const p of pendingPeca){
      p.status = 'ok';
      await dbUpdateHistory(p._docId, p._dateKey, { status: 'ok' }).catch(()=>{});
    }
  }

  // Atualiza o relatório "Tempo por Modelo" ao vivo:
  // - faz merge do registro recém-finalizado no cache (sem refazer fetch dos 90 dias)
  // - se a aba do relatório estiver visível, re-renderiza imediatamente
  if(h && Array.isArray(_modeloAllRecs)){
    const _existsIdx = _modeloAllRecs.findIndex(r => r._docId === h._docId);
    const _merged = { ..._modeloAllRecs[_existsIdx] || {}, ...h };
    if(_existsIdx >= 0) _modeloAllRecs[_existsIdx] = _merged;
    else _modeloAllRecs.unshift(_merged);
    try {
      const _modeloView = document.getElementById('reltab-modelo-view') || document.getElementById('view-modelo');
      const _visivel = _modeloView && _modeloView.offsetParent !== null;
      if(_visivel && typeof renderModeloRel === 'function') renderModeloRel();
    } catch(_){}
  }
  history.filter(x => x.uid===actionUid && x.status==='running' && x !== h)
         .forEach(x => { x.status='closed_stale'; });
  // totalDia não é mais incrementado manualmente — é calculado ao vivo pelo history[]
  if(res==='rep'||res==='scrap') u.repDia++;
  const _writeTs = Date.now();
  u._localRepDia  = u.repDia;
  u._lastWriteTs  = _writeTs;
  try {
    await dbPatch('/users/'+actionUid, {
      repDia:        u.repDia,
      _selb:         null,
      _status:       'idle',
      _startEpoch:   null,
      _elapsed:      null,
      _pausedElapsed:null,
      _lastWriteTs:  _writeTs
    });
  } catch(e) {
    if(res==='rep'||res==='scrap') u.repDia--;
    u._localRepDia = u.repDia;
    console.warn('[confirmarFin] dbPatch falhou:', e.message);
  }
  if(timers[actionUid]){ clearInterval(timers[actionUid]); delete timers[actionUid]; }
  s.selb=null; s.status='idle'; s.elapsed=0;
  s._frozenElapsed=0; s._activeFrom=null; if(typeof _localTimerClear==='function') _localTimerClear(actionUid);
  s._pausedAt=null; s._pauseAccum=0; 
  s.startEpoch=null; s.pausedElapsed=0;
  s.idleStart=Date.now();

  // ── Verifica se atingiu a meta agora ──
  const newTotal = getTotalDia(actionUid);
  const prevTotal = newTotal - 1; // valor antes desta finalização
  const meta = (u.sector === 'COMPLEXA') ? 1 : 8;
  // Só dispara no EXATO momento em que a meta é cruzada (evita bip duplo)
  const todayKey = new Date().toDateString();
  const bipKey = '_metaBip_' + actionUid + '_' + todayKey;
  const jaDisparou = localStorage.getItem(bipKey);
  if(res === 'ok' && newTotal >= meta && prevTotal < meta && !jaDisparou){
    localStorage.setItem(bipKey, '1');
    // Dispara celebração global via Firebase
    dbSet('/meta/latestCelebration', {
      uid: actionUid,
      name: u.name,
      timestamp: Date.now()
    }).catch(()=>{});
  }

  renderCard(actionUid); closeModal('modal-finish'); updateSummary();
  // FluxoLAB: ao finalizar, move o SELB conforme fluxo definido em _fluxolabDestinoFinal.
  // 'ok'    → próximo bolsão (LIMPEZA→LINHA_LIMPEZA, MONTAGEM/COMPLEXA→QUALIDADE)
  // 'scrap' → bolsão SCRAP
  // 'rep'   → mantém no bolsão atual (SELB reprovado fica no último bolsão registrado)
  // Usa h.selb como fonte principal; fallback para selbAtualSnapshot caso h seja nulo
  // (evita SELB ficar preso no bolsão quando listener Firebase limpa s.selb antes do fim do await)
  const selbParaMover = (h && h.selb) ? h.selb : selbAtualSnapshot;
  if(selbParaMover){
    fluxolabFinalizarSelb(selbParaMover, u.sector, res).catch(e => console.warn('[FluxoLAB] Erro ao mover SELB no FluxoLAB:', e));
  }
  if(currentUser && !currentUser.isAdmin && currentUser.id === actionUid &&
     document.getElementById('view-operador').classList.contains('active')){
    opRenderState(actionUid);
  }

  } catch (err) {
    console.error('Erro ao finalizar SELB:', err);
    alert('Erro ao finalizar SELB: ' + err.message);
  } finally {
    window._submittingSelb = false;
    const btn = document.querySelector('#modal-finish .bp');
    if(btn) { btn.disabled = false; btn.textContent = '💾 Salvar'; }
  }
}
async function addFollowupEntry(uid){
  const inp = document.getElementById('finp-'+uid);
  const text = inp.value.trim();
  if(!text) return;

  const h = history.find(x => x.uid === uid && x.status === 'running');
  if(!h) return;

  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const entry = `[${time}] ${text}`;
  
  const current = h.followup || '';
  const updated = current ? current + '\n' + entry : entry;
  
  h.followup = updated;
  inp.value = '';

  try {
    await dbUpdateHistory(h._docId, h._dateKey, { followup: updated });
    // Opcional: atualizar visualmente o log imediatamente se o Firebase demorar
    const logDiv = document.getElementById('flog-'+uid);
    if(logDiv){
      if(logDiv.textContent === 'Nenhum registro...') logDiv.innerHTML = '';
      logDiv.innerHTML += (current ? '<br>' : '') + entry.replace(/\[(\d{2}:\d{2})\]/g, '<b>[$1]</b>');
      logDiv.scrollTop = logDiv.scrollHeight;
    }
  } catch(e) {
    console.error("Erro ao salvar acompanhamento", e);
    alert("Erro ao salvar acompanhamento. Tente novamente.");
    inp.value = text; // devolve o texto
  }
}

function openFollowupDetails(uid, selb, name, sector, text){
  document.getElementById('mfu-sub').textContent = `SELB: ${selb} — ${name} (${sector})`;
  document.getElementById('mfu-content').textContent = text || 'Nenhum acompanhamento registrado.';
  document.getElementById('modal-followup-details').classList.remove('hidden');
}
function togglePause(uid){
  const s   = getS(uid);
  const now = Date.now();
  if(s.status === 'running'){
    // Congela: captura o valor atual do timer (líquido)
    const frozen       = calcElapsedRunning(uid);
    s._frozenElapsed   = frozen;
    s._activeFrom      = null;
    s.status           = 'paused';
    // Força o cache local a refletir o estado pausado imediatamente,
    // evitando que o tick do interval recalcule com runningSince ainda ativo.
    if(_localTimerCache[uid]){
      _localTimerCache[uid].baseSec      = frozen;
      _localTimerCache[uid].runningSince = null;
    }
    // Para o interval visual — timer congelado não precisa de tick
    if(timers[uid]){ clearInterval(timers[uid]); delete timers[uid]; }
    dbPatch('/users/'+uid, {_status:'paused', _frozenElapsed: frozen, _activeFrom: null}).catch(()=>{});
  } else {
    // Descongela: marca o instante de retomada
    s._activeFrom  = now;
    s.status       = 'running';
    // Atualiza cache local para retomar a partir do valor congelado
    if(_localTimerCache[uid]){
      _localTimerCache[uid].runningSince = now;
    }
    dbPatch('/users/'+uid, {_status:'running', _activeFrom: now, _frozenElapsed: s._frozenElapsed||0}).catch(()=>{});
    startTimer(uid);
  }
  renderCard(uid); updateSummary();
}
function updateTpb(uid, sec){
  const s   = getS(uid);
  const tpb = document.getElementById('tpb-' + uid);
  if(!tpb || sec == null) return;
  const mn = getEquipName(s.selb || '');
  if(!mn) return;
  const u = users.find(x => x.id === uid);
  const isMontLimp = u && (u.sector === 'MONTAGEM' || u.sector === 'LIMPEZA');
  const recs = history.filter(h => {
    if(h.equipamento !== mn || h.status !== 'ok' || !h.duracao) return false;
    if(isMontLimp){ const sc2 = calcDuracaoLiquida(h); return sc2 > 300 && sc2 < 9000; }
    return true;
  });
  if(!recs.length) return;
  const avgSec = calcAverage(recs, calcDuracaoLiquida);
  if(avgSec <= 0) return;
  const ratio = sec / avgSec;
  const over  = ratio >= 1;
  const pct   = Math.min(Math.round(ratio * 100), 100);
  const color = over        ? '#f25757'
              : ratio >= 0.8 ? '#f5a623'
              : ratio >= 0.5 ? '#f5c84a'
              : '#3dd68c';
  tpb.style.height     = pct + '%';
  tpb.style.background = color;
  tpb.classList.toggle('over', over);
  const wrap = tpb.parentElement;
  if(wrap){
    wrap.style.background = over          ? 'rgba(242,87,87,.18)'
                          : ratio >= 0.8   ? 'rgba(245,166,35,.18)'
                          : ratio >= 0.5   ? 'rgba(245,166,35,.10)'
                          : 'rgba(61,214,140,.10)';
  }
}

function startTimer(uid){
  if (!uid) {
    console.warn('[Sanity Check] startTimer called sem uid');
    return;
  }
  // Tick puramente visual — não grava nada no Firebase.
  // Atualiza o elemento #m-timer-<uid> a cada 1s enquanto status === 'running'.
  if(timers[uid]){ clearInterval(timers[uid]); delete timers[uid]; }
  timers[uid] = setInterval(()=>{
    const s = getS(uid);
    if(!s || !s.selb || s.status === 'idle'){
      clearInterval(timers[uid]); delete timers[uid];
      return;
    }
    // Parado quando pausado — o interval é limpo pelo togglePause,
    // mas esta guarda extra evita ticks residuais.
    if(s.status === 'paused'){
      clearInterval(timers[uid]); delete timers[uid];
      return;
    }
    const el = document.getElementById('m-timer-' + uid);
    if(el) el.textContent = fmt(calcElapsedRunning(uid));
    // updateTpb existente continua funcionando, baseado no tempo corrente
    try { updateTpb(uid, calcElapsedRunning(uid)); } catch(_){}
  }, 1000);
}
function updateSummary(){
  let running = 0;
  let paused = 0;
  users.forEach(u=>{ 
    const s=getS(u.id); 
    if(s.status==='running') running++; 
    if(s.status==='paused')  paused++;
  });
  const todayDk     = new Date().toDateString().replace(/ /g,'_');
  const src         = history.filter(h => h._dateKey === todayDk);
  
  // Deduplicação por SELB para os totais do topo
  const uniqueDone   = new Set(src.filter(h => h.status==='ok' && h.selb).map(h => h.selb)).size;
  const uniqueRep    = new Set(src.filter(h => h.status==='rep' && h.selb).map(h => h.selb)).size;
  const uniqueScrap  = new Set(src.filter(h => h.status==='scrap' && h.selb).map(h => h.selb)).size;
  
  const pecasCount  = history.filter(h => h.status === 'aguardando').length;
  
  const elRun   = document.getElementById('s-run');
  const elDone  = document.getElementById('s-done');
  const elRep   = document.getElementById('s-rep');
  const elScrap = document.getElementById('s-scrap');
  const elPeça  = document.getElementById('s-peça');

  if(elRun)   elRun.textContent   = running;
  if(elDone)  elDone.textContent  = uniqueDone;
  if(elRep)   elRep.textContent   = uniqueRep;
  if(elScrap) elScrap.textContent = uniqueScrap;
  if(elPeça)  elPeça.textContent  = pecasCount;

  // ── Aprovadas por equipe ──
  const okToday = history.filter(h => {
    if(h.status !== 'ok' || !h.end) return false;
    const dk = h.endDateKey || (h.endEpoch ? new Date(h.endEpoch).toDateString().replace(/ /g,'_') : h._dateKey);
    return dk === todayDk;
  });

  const getSector = h => h.sector || users.find(x => x.id === h.uid)?.sector || '';

  function countUniqueSector(sectorName) {
    const recs = okToday.filter(h => getSector(h) === sectorName);
    const selbs = new Set(recs.map(h => h.selb).filter(Boolean));
    const semSelb = recs.filter(h => !h.selb).length;
    return selbs.size + semSelb;
  }

  const tMont = countUniqueSector('MONTAGEM');
  const tLimp = countUniqueSector('LIMPEZA');
  const tComp = countUniqueSector('COMPLEXA');
  
  // Total Geral: Únicos em toda a empresa
  const selbsGlobal = new Set(okToday.map(h => h.selb).filter(Boolean));
  const semSelbGlobal = okToday.filter(h => !h.selb).length;
  const tTot = selbsGlobal.size + semSelbGlobal;

  const elMont = document.getElementById('t-mont');
  const elLimp = document.getElementById('t-limp');
  const elComp = document.getElementById('t-comp');
  const elTot  = document.getElementById('t-total');
  if(elMont) elMont.textContent = tMont;
  if(elLimp) elLimp.textContent = tLimp;
  if(elComp) elComp.textContent = tComp;
  if(elTot)  elTot.textContent  = tTot;
}

// ════ CONSULTA ════
let _consultaDateKey = null;   // dateKey currently shown in consulta (kept for compat)
let _consultaRecords = [];     // records for the selected date range

function _dateKeysInRange(fromIso, toIso){
  const keys = [];
  const from = new Date(fromIso + 'T12:00:00');
  const to   = new Date(toIso   + 'T12:00:00');
  if(from > to) return keys;
  const cur = new Date(from);
  while(cur <= to){
    keys.push(cur.toDateString().replace(/ /g,'_'));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

function _initConsultaDateSelect(){
  const todayIso = new Date().toISOString().slice(0,10);
  const sevenDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0,10);
  const fromEl = document.getElementById('consulta-date-from');
  const toEl   = document.getElementById('consulta-date-to');
  if(fromEl && !fromEl.value) fromEl.value = sevenDaysAgo;
  if(toEl   && !toEl.value)   toEl.value   = todayIso;
}

async function loadConsultaRange(){
  const fromEl = document.getElementById('consulta-date-from');
  const toEl   = document.getElementById('consulta-date-to');
  if(!fromEl || !toEl) return;

  const fromIso = fromEl.value;
  const toIso   = toEl.value;
  if(!fromIso || !toIso) return;
  if(fromIso > toIso){ toEl.value = fromIso; return loadConsultaRange(); }

  const todayDk  = new Date().toDateString().replace(/ /g,'_');
  const dateKeys = _dateKeysInRange(fromIso, toIso);

  document.getElementById('consulta-loading').style.display = 'block';
  document.getElementById('consulta-body').innerHTML = '';

  let allRecords = [];
  for(const dk of dateKeys){
    if(dk === todayDk && _consultaRecords.some(r => r._dateKey === dk)){
      // já temos os de hoje no cache
      allRecords.push(..._consultaRecords.filter(r => r._dateKey === dk));
      continue;
    }
    try {
      const data = await dbGet('/history/'+dk);
      if(data){
        allRecords.push(...Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk})));
      }
    } catch(e){}
  }

  allRecords.sort((a,b)=>(b.startEpoch||0)-(a.startEpoch||0));
  _consultaDateKey = dateKeys[dateKeys.length-1] || todayDk;
  _consultaRecords = allRecords;

  document.getElementById('consulta-loading').style.display = 'none';
  renderConsulta();
}

// ════ AGUARDANDO PEÇAS ════
async function renderPecasView(){
  const tbody = document.getElementById('pecas-body');
  const q = (document.getElementById('pecas-search').value||'').toUpperCase();
  if(!tbody) return;

  _renderSolicitacoesPanel('pecas-solicitacoes-panel', q);

  tbody.innerHTML = `<tr><td colspan="10" class="empty">Carregando...</td></tr>`;

  // ── Filtro de data ──
  const todayIso = new Date().toISOString().slice(0,10);
  const fromEl = document.getElementById('pecas-date-from');
  const toEl   = document.getElementById('pecas-date-to');
  // Se não tiver datas preenchidas, inicializa com hoje
  if(fromEl && !fromEl.value) fromEl.value = todayIso;
  if(toEl   && !toEl.value)   toEl.value   = todayIso;
  const fromIso = (fromEl && fromEl.value) ? fromEl.value : todayIso;
  const toIso   = (toEl   && toEl.value)   ? toEl.value   : todayIso;

  // Converte dateKey (Mon_May_22_2026) para ISO para comparação
  function dkToIso(dk){
    try { return new Date(dk.replace(/_/g,' ')).toISOString().slice(0,10); } catch(e){ return ''; }
  }

  const allAguardando = history.filter(h => {
    if(h.status !== 'aguardando') return false;
    const iso = dkToIso(h._dateKey||'');
    if(!iso) return false;
    return iso >= fromIso && iso <= toIso;
  });
  const filtered = allAguardando.filter(h => !q || h.selb.includes(q) || h.name.toUpperCase().includes(q));

  if(!filtered.length){
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Nenhum SELB aguardando peça.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(h => {
    // ── Checkbox "já solicitei" por SELB ──
    const solKey = 'selb_solicitado_' + h.selb;
    let jaSolicitado = false;
    try { jaSolicitado = localStorage.getItem(solKey) === '1'; } catch(e){}
    const chkStyle = jaSolicitado
      ? 'background:var(--accent2);border-color:var(--accent2);'
      : 'background:transparent;border:2px solid rgba(61,214,140,.4);';

    // ── Lista de peças do SELB (sem checkbox por peça) ──
    const solsDoSelb = Object.entries(_solicitacoesPecas || {})
      .filter(([,p]) => (p.selb||'').toUpperCase() === (h.selb||'').toUpperCase());
    const pecasCellHtml = solsDoSelb.length
      ? solsDoSelb.map(([,p]) => {
          const qtd = p.quantidade > 1 ? `<span style="background:rgba(245,166,35,.2);color:var(--warn);border-radius:4px;font-size:10px;font-weight:800;padding:0 5px;margin-left:3px">x${p.quantidade}</span>` : '';
          return `<div style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:2px"><span>🔩</span><span style="color:var(--text)">${p.peca||'—'}</span>${qtd}</div>`;
        }).join('')
      : '<span style="color:var(--muted);font-size:11px">—</span>';

    return `
    <tr style="${jaSolicitado ? 'opacity:0.5;' : ''}">
      <td style="text-align:center;width:44px">
        <label title="${jaSolicitado ? 'Solicitado!' : 'Marcar como solicitado'}" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;user-select:none">
          <input type="checkbox" ${jaSolicitado ? 'checked' : ''}
            onchange="toggleSelbSolicitado('${h.selb}', this)"
            style="width:18px;height:18px;border-radius:5px;${chkStyle}appearance:none;-webkit-appearance:none;cursor:pointer;transition:all .15s">
          <span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.02em">${jaSolicitado ? 'FEITO' : 'PEDIDO?'}</span>
        </label>
      </td>
      <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${h.selb}</td>
      <td style="font-size:12px;color:var(--muted)">${h.equipamento || '—'}</td>
      <td>${h.name}</td>
      <td>${h.sector}</td>
      <td style="font-family:var(--mono);font-size:12px">${h._dateKey.replace(/_/g,'/')} - ${h.start}</td>
      <td style="font-family:var(--mono);font-size:12px">${h.duracao || '—'}</td>
      <td style="font-size:11px;color:var(--muted);max-width:160px">${h.comentario || h.motivo || '—'}</td>
      <td>${pecasCellHtml}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="btn bp" style="font-size:11px;padding:6px 12px"
            onclick="liberarPeca('${h._docId}','${h._dateKey}')">✅ Aprovar / Liberar</button>
          ${(currentUser && currentUser.isAdmin) ? `
          <button style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:8px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap"
            onclick="admMoverParaMaquinaA('${h._docId}','${h._dateKey}','${h.selb}','${(h.equipamento||'').replace(/\'\'/g,"\\'")}','${(h.sector||'').replace(/\'\'/g,"\\'")}')">🅰️ → Máquinas A</button>
          ` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');

  // ── Card de SELBs sem confirmação de PEDIDO ──
  const pendBox   = document.getElementById('pecas-pendentes-pedido');
  const pendBody  = document.getElementById('pecas-pendentes-body');
  const pendCount = document.getElementById('pecas-pendentes-count');
  if(pendBox && pendBody){
    const pendentes = filtered.filter(h => {
      try { return localStorage.getItem('selb_solicitado_' + h.selb) !== '1'; }
      catch(e){ return true; }
    });
    if(!pendentes.length){
      pendBox.style.display = 'none';
      pendBody.innerHTML = '';
    } else {
      pendBox.style.display = 'block';
      if(pendCount) pendCount.textContent = pendentes.length;
      pendBody.innerHTML = pendentes.map(h => {
        const solsDoSelb = Object.entries(_solicitacoesPecas || {})
          .filter(([,p]) => (p.selb||'').toUpperCase() === (h.selb||'').toUpperCase());
        const pecasCellHtml = solsDoSelb.length
          ? solsDoSelb.map(([,p]) => {
              const qtd = p.quantidade > 1 ? `<span style="background:rgba(245,166,35,.2);color:var(--warn);border-radius:4px;font-size:10px;font-weight:800;padding:0 5px;margin-left:3px">x${p.quantidade}</span>` : '';
              return `<div style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:2px"><span>🔩</span><span style="color:var(--text)">${p.peca||'—'}</span>${qtd}</div>`;
            }).join('')
          : '<span style="color:var(--muted);font-size:11px">—</span>';
        return `
        <tr data-selb="${h.selb}">
          <td style="text-align:center;width:44px">
            <label title="Marcar como solicitado" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;user-select:none">
              <input type="checkbox"
                onchange="toggleSelbSolicitado('${h.selb}', this)"
                style="width:18px;height:18px;border-radius:5px;background:transparent;border:2px solid rgba(61,214,140,.4);appearance:none;-webkit-appearance:none;cursor:pointer;transition:all .15s">
              <span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.02em">PEDIDO?</span>
            </label>
          </td>
          <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${h.selb}</td>
          <td style="font-size:12px;color:var(--muted)">${h.equipamento || '—'}</td>
          <td>${h.name}</td>
          <td>${h.sector}</td>
          <td style="font-family:var(--mono);font-size:12px">${h._dateKey.replace(/_/g,'/')} - ${h.start}</td>
          <td style="font-family:var(--mono);font-size:12px">${h.duracao || '—'}</td>
          <td style="font-size:11px;color:var(--muted);max-width:160px">${h.comentario || h.motivo || '—'}</td>
          <td>${pecasCellHtml}</td>
        </tr>`;
      }).join('');
    }
  }
}

// ── Filtro de data: helpers ────────────────────────────────────────────────
function pecasDateHoje(){
  const today = new Date().toISOString().slice(0,10);
  const f = document.getElementById('pecas-date-from');
  const t = document.getElementById('pecas-date-to');
  if(f) f.value = today;
  if(t) t.value = today;
  renderPecasView();
}
function pecasDateTodos(){
  const f = document.getElementById('pecas-date-from');
  const t = document.getElementById('pecas-date-to');
  if(f) f.value = '2024-01-01';
  if(t) t.value = new Date().toISOString().slice(0,10);
  renderPecasView();
}

// ── Toggle: marca/desmarca SELB como "já solicitei a peça" (localStorage) ────
function toggleSelbSolicitado(selb, checkboxEl){
  const solKey = 'selb_solicitado_' + selb;
  const checked = checkboxEl.checked;
  try { localStorage.setItem(solKey, checked ? '1' : '0'); } catch(e){}
  checkboxEl.style.background = checked ? 'var(--accent2)' : 'transparent';
  checkboxEl.style.borderColor = checked ? 'var(--accent2)' : 'rgba(61,214,140,.4)';
  const label = checkboxEl.closest('label');
  if(label){ const txt = label.querySelector('span'); if(txt) txt.textContent = checked ? 'FEITO' : 'PEDIDO?'; }
  const row = checkboxEl.closest('tr');
  if(row) row.style.opacity = checked ? '0.5' : '1';

  // Sincroniza o card "SELBs sem confirmação de pedido"
  const pendBody  = document.getElementById('pecas-pendentes-body');
  const pendBox   = document.getElementById('pecas-pendentes-pedido');
  const pendCount = document.getElementById('pecas-pendentes-count');
  if(checked){
    if(pendBody){
      pendBody.querySelectorAll('tr[data-selb="'+selb+'"]').forEach(tr => tr.remove());
      const n = pendBody.children.length;
      if(pendCount) pendCount.textContent = n;
      if(pendBox && !n) pendBox.style.display = 'none';
    }
  } else {
    // Re-renderiza para o item voltar ao card
    if(typeof renderPecasView === 'function') renderPecasView();
  }
}



// ── Renderiza o painel de alertas de solicitações pendentes ────────────────
function _renderSolicitacoesPanel(panelId, q){
  var panel = document.getElementById(panelId);
  if(!panel) return;

  var todas = Object.entries(_solicitacoesPecas || {});
  var pendentes = todas
    .filter(function(e){ return !e[1].lida; })
    .filter(function(e){ var p=e[1]; return !q || (p.selb||'').toUpperCase().includes(q) || (p.nome||'').toUpperCase().includes(q); })
    .sort(function(a,b){ return (b[1].ts||0) - (a[1].ts||0); });

  if(!pendentes.length){
    panel.style.display = 'none';
    return;
  }

  var isAdmin = currentUser && currentUser.isAdmin;
  panel.style.display = 'block';

  var marcarTodasBtn = isAdmin
    ? '<button onclick="marcarTodasPecasLidas()" style="background:rgba(61,214,140,.1);border:1px solid rgba(61,214,140,.35);border-radius:8px;color:var(--accent2);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 12px;cursor:pointer">\u2713 Marcar todas como lidas</button>'
    : '';

  // Agrupar por SELB + UID (mesmo SELB, mesmo profissional)
  var groups = {};
  pendentes.forEach(function(entry){
    var p = entry[1];
    var key = (p.selb || 'SN') + '_' + (p.uid || '');
    if(!groups[key]) groups[key] = [];
    groups[key].push(entry);
  });

  var cards = Object.keys(groups).map(function(key){
    var groupItems = groups[key];
    var first = groupItems[0][1];
    var selb = first.selb || '—';
    var maxTs = Math.max.apply(null, groupItems.map(function(e){ return e[1].ts || 0; }));
    var tempoAtras = _tempoAtras(maxTs);

    var itemsHtml = groupItems.map(function(entry){
      var id = entry[0];
      var p  = entry[1];
      var qtdLabel = (p.quantidade > 1)
        ? '<span style="background:rgba(245,166,35,.3);color:var(--warn);border-radius:6px;font-size:10px;font-weight:800;padding:1px 7px;margin-left:4px">x' + p.quantidade + '</span>'
        : '';
      var obsHtml = p.obs ? '<div style="font-size:10px;color:var(--muted);font-style:italic;margin-left:18px;margin-bottom:4px">"' + p.obs + '"</div>' : '';

      var btnHtml = isAdmin
        ? '<div style="display:flex;gap:4px">'
          + '<button onclick="entregarPeca(\'' + id + '\',\'' + (selb||'').replace(/'/g,"") + '\')" title="Marcar como entregue" style="background:rgba(61,214,140,.1);border:1px solid rgba(61,214,140,.4);border-radius:6px;color:var(--accent2);font-size:9px;font-weight:700;padding:3px 8px;cursor:pointer;flex-shrink:0">✓ Entregar</button>'
          + '<button onclick="removerSolicitacaoPeca(\'' + id + '\',\'' + (selb||'').replace(/'/g,"") + '\')" title="Excluir solicitação" style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.4);border-radius:6px;color:var(--danger);font-size:10px;font-weight:700;padding:3px 8px;cursor:pointer;flex-shrink:0">×</button>'
        + '</div>'
        : '';

      return '<div style="display:flex;flex-direction:column;margin-bottom:6px;border-bottom:1px dashed rgba(255,255,255,0.05);padding-bottom:4px">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">'
          + '<div style="display:flex;align-items:center;gap:6px">'
            + '<span style="font-size:12px">\uD83D\uDD29</span>'
            + '<span style="font-size:12px;font-weight:600;color:var(--warn)">' + (p.peca||'—') + qtdLabel + '</span>'
          + '</div>'
          + btnHtml
        + '</div>'
        + obsHtml
        + '</div>';
    }).join('');

    return '<div style="background:var(--bg2);border:1px solid rgba(245,166,35,.4);border-left:4px solid var(--warn);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:8px">'
      + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;margin-bottom:4px">'
        + '<div>'
          + '<div style="font-family:var(--mono);font-weight:800;color:var(--accent);font-size:16px;letter-spacing:0.02em">' + selb + '</div>'
          + '<div style="font-size:12px;color:var(--text);font-weight:600;margin-top:2px">' + (first.nome||'—') + ' <span style="color:var(--muted);font-weight:400">\u00B7 ' + (first.setor||'—') + '</span></div>'
          + (first.equipamento ? '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + first.equipamento + '</div>' : '')
        + '</div>'
        + '<span style="font-size:10px;color:var(--muted);background:var(--bg3);padding:3px 8px;border-radius:6px">\u23F1 ' + tempoAtras + '</span>'
      + '</div>'
      + '<div style="background:rgba(255,255,255,0.03);border-radius:8px;padding:10px;border:1px solid rgba(255,255,255,0.05)">'
        + itemsHtml
      + '</div>'
    + '</div>';
  }).join('');

  panel.innerHTML = ''
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">'
      + '<div style="display:flex;align-items:center;gap:8px">'
        + '<span style="font-size:16px">\uD83D\uDD14</span>'
        + '<span style="font-size:14px;font-weight:700;color:var(--warn)">Solicita\u00E7\u00F5es de Pe\u00E7as Pendentes</span>'
        + '<span style="background:var(--warn);color:#000;border-radius:20px;font-size:11px;font-weight:800;padding:2px 9px">' + pendentes.length + '</span>'
      + '</div>'
      + marcarTodasBtn
    + '</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:10px">'
      + cards
    + '</div>';
}
function _tempoAtras(ts){
  if(!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff/60000);
  if(m < 1) return 'agora mesmo';
  if(m < 60) return m + ' min atrás';
  const h = Math.floor(m/60);
  if(h < 24) return h + 'h atrás';
  return Math.floor(h/24) + 'd atrás';
}

async function liberarPeca(docId, dateKey){
  if(!confirm("Deseja aprovar e liberar este SELB? Ele sairá da lista de aguardando peças.")) return;
  
  try {
    // Atualiza status no Firebase
    await dbUpdateHistory(docId, dateKey, { status: 'ok' });
    
    // Atualiza localmente
    const h = history.find(x => x._docId === docId);
    if(h) h.status = 'ok';

    // Remove solicitações de peça pendentes vinculadas a este SELB
    const selb = h ? h.selb : null;
    if (selb && typeof fluxolabRemoveSelbGlobal === 'function') {
      fluxolabRemoveSelbGlobal(selb).catch(e => console.warn('[FluxoLAB] Erro ao remover SELB liberado:', e));
    }
    if(selb && _solicitacoesPecas){
      const promises = Object.entries(_solicitacoesPecas)
        .filter(([,p]) => (p.selb||'').toUpperCase() === selb.toUpperCase())
        .map(([id]) => _db.ref('/solicitacoes_pecas/'+id).remove().catch(()=>{}));
      await Promise.all(promises);
    }
    
    // Recarrega vista e sumário
    renderPecasView();
    updateSummary();
    alert("SELB aprovado e liberado com sucesso!");
  } catch(e) {
    console.error("Erro ao liberar peça", e);
    alert("Erro ao salvar alteração no banco de dados.");
  }
}

// ════════════════════════════════════════════
// SOLICITAÇÃO DE PEÇAS — MONTAGEM
// Armazenado em /solicitacoes_pecas/{id}
// Campos: selb, equipamento, peca, obs, uid, nome, setor, ts, lida
// ════════════════════════════════════════════

// ════════════════════════════════════════════
// SOLICITAÇÃO DE PEÇAS — MONTAGEM
// /solicitacoes_pecas/{id}  → solicitações feitas pelos operadores
// /config_pecas/{id}        → lista de peças configurável pelo admin
// ════════════════════════════════════════════

const PECAS_PADRAO = [
  { nome: 'Unidade de Imagem', emoji: '🖼️' },
  { nome: 'Módulo Fusor',      emoji: '🔥' },
  { nome: 'Toner',             emoji: '🖨️' },
  { nome: 'Rolete',            emoji: '⚙️' }
];

let _solicitacoesPecas = {}; // cache local de solicitações
let _configPecas       = {}; // cache local da lista de peças configuráveis
let _solicitacaoPecaUid = null;

// ── Listener de solicitações ─────────────────────────────────────────────────
// ── Som de alerta para admin quando chega nova solicitação de peça ──────────
function _tocarAlertaPeca(){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Sequência: 3 bips curtos em tom descendente
    const notas = [880, 660, 440];
    notas.forEach((freq, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.4, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
      osc.start(t);
      osc.stop(t + 0.15);
    });
  } catch(e) { console.warn('AudioContext indisponível:', e); }
}

let _pecasIdsConhecidos = null; // null = primeira carga, não toca

async function startSolicitacoesPecasListener(){
  if(!_db) return;
  _db.ref('/solicitacoes_pecas').on('value', snap => {
    const novo = snap.val() || {};

    // Detectar novas solicitações (apenas para admin, após primeira carga)
    if(currentUser && currentUser.isAdmin && _pecasIdsConhecidos !== null){
      const idsNovos = Object.keys(novo).filter(id => !_pecasIdsConhecidos.has(id));
      if(idsNovos.length > 0) _tocarAlertaPeca();
    }
    // Atualizar conjunto de IDs conhecidos
    _pecasIdsConhecidos = new Set(Object.keys(novo));

    _solicitacoesPecas = novo;
    atualizarNotifPecasAdmin();
    atualizarBadgeTopbarPecas();
    if(currentUser && !currentUser.isAdmin) atualizarOpPecaPendente(currentUser.id);
    // Atualiza painéis de alerta nas views de peças
    if(document.getElementById('view-pecas')?.classList.contains('active')) _renderSolicitacoesPanel('pecas-solicitacoes-panel','');
    if(document.getElementById('subview-pecas-a')?.style.display !== 'none') _renderSolicitacoesPanel('pecas-a-solicitacoes-panel','');
    if(document.getElementById('view-solicitacoes')?.classList.contains('active')) renderSolicitacoesDoDia();
  });
  // Listener Supabase Realtime para config_pecas
  _supa.channel('config_pecas')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'config_pecas' }, async () => {
      await _reloadConfigPecas();
    })
    .subscribe();
  await _reloadConfigPecas();
}

async function _reloadConfigPecas() {
  const { data } = await _supa.from('config_pecas').select('*').order('ordem');
  _configPecas = {};
  (data || []).forEach(p => { _configPecas[p.id] = { nome: p.nome, emoji: p.emoji, ordem: p.ordem }; });
  renderConfigPecasAdmin();
  if (!document.getElementById('modal-solicitar-peca').classList.contains('hidden')) {
    renderPecasGrid();
  }
}

// ── Retorna lista ordenada de peças (config ou padrão) ───────────────────────
function getListaPecas(){
  const entries = Object.entries(_configPecas);
  if(!entries.length) return PECAS_PADRAO.map((p,i) => ({ id: 'pad_'+i, ...p }));
  return entries
    .sort(([,a],[,b]) => (a.ordem||0) - (b.ordem||0))
    .map(([id, p]) => ({ id, nome: p.nome, emoji: p.emoji || '⚙️' }));
}

// ── Renderiza o select de peças no modal de solicitação ─────────────────────
function renderPecasGrid(){
  const sel = document.getElementById('msp-peca-selecionada');
  if(!sel) return;
  const lista = getListaPecas();
  const opcoes = lista.map(p => '<option value="' + p.nome + '">' + p.emoji + ' ' + p.nome + '</option>').join('');
  sel.innerHTML = '<option value="">— Selecione uma peça —</option>' + opcoes + '<option value="Outras">📝 Outras</option>';
  // Também atualiza o dropdown de busca se existir
  mspRenderDropdown('');
  onMspPecaChange();
}

// ── Busca/dropdown de peças ──────────────────────────────────────────────────
function mspRenderDropdown(query){
  const dd = document.getElementById('msp-peca-dropdown');
  if(!dd) return;
  const lista = [...getListaPecas(), { id:'outras', nome:'Outras', emoji:'📝' }];
  const q = (query||'').toLowerCase().trim();
  const filtrado = q ? lista.filter(p => p.nome.toLowerCase().includes(q)) : lista;
  if(!filtrado.length){
    dd.innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:13px">Nenhuma peça encontrada</div>';
    return;
  }
  dd.innerHTML = filtrado.map(p => `
    <div onclick="mspSelecionarPeca('${p.nome.replace(/'/g,"\\'")}','${(p.emoji||'⚙️').replace(/'/g,"\\'")} ${p.nome.replace(/'/g,"\\'")}')"
      style="padding:10px 14px;cursor:pointer;font-size:13px;display:flex;align-items:center;gap:8px;
             border-bottom:1px solid var(--border);transition:background .1s"
      onmouseover="this.style.background='var(--bg4)'" onmouseout="this.style.background=''">
      <span style="font-size:16px">${p.emoji||'⚙️'}</span>
      <span>${p.nome}</span>
    </div>
  `).join('');
}

function mspFiltrarPecas(){
  const input = document.getElementById('msp-peca-busca');
  if(!input) return;
  const dd = document.getElementById('msp-peca-dropdown');
  if(dd) dd.style.display = 'block';
  mspRenderDropdown(input.value);
}

function mspAbrirDropdown(){
  const dd = document.getElementById('msp-peca-dropdown');
  if(!dd) return;
  const input = document.getElementById('msp-peca-busca');
  mspRenderDropdown(input ? input.value : '');
  dd.style.display = 'block';
}

function mspFecharDropdown(){
  const dd = document.getElementById('msp-peca-dropdown');
  if(dd) dd.style.display = 'none';
}

function mspSelecionarPeca(valor, label){
  // Atualiza o input visível
  const input = document.getElementById('msp-peca-busca');
  if(input) input.value = label;
  // Atualiza o select oculto (compatibilidade com adicionarPecaALista e confirmarSolicitarPeca)
  const sel = document.getElementById('msp-peca-selecionada');
  if(sel) { sel.value = valor; }
  mspFecharDropdown();
  onMspPecaChange();
}

// Limpa o campo de busca ao abrir o modal (chama após renderPecasGrid no abrirSolicitarPeca)
function mspResetBusca(){
  const input = document.getElementById('msp-peca-busca');
  if(input) input.value = '';
  mspFecharDropdown();
}

function onMspPecaChange(){
  const sel = document.getElementById('msp-peca-selecionada');
  const obs = document.getElementById('msp-obs');
  const req = document.getElementById('msp-obs-req');
  if(!sel || !obs || !req) return;
  if(sel.value === 'Outras'){
    req.textContent = '* obrigatório';
    req.style.color = 'var(--danger)';
    obs.placeholder = 'Descreva a peça necessária...';
    obs.style.borderColor = 'rgba(242,87,87,.5)';
  } else {
    req.textContent = '(opcional)';
    req.style.color = 'var(--muted)';
    obs.placeholder = 'Ex: necessário para o fusor do modelo X...';
    obs.style.borderColor = '';
  }
}

function mspAlterarQtd(delta){
  const inp = document.getElementById('msp-quantidade');
  if(!inp) return;
  let v = parseInt(inp.value) || 1;
  v = Math.max(1, Math.min(99, v + delta));
  inp.value = v;
}

// ── Abre modal de solicitação ────────────────────────────────────────────────
function abrirSolicitarPeca(uid){
  const u = users.find(x=>x.id===uid);
  if(!u){ alert('Usuário não encontrado.'); return; }

  const s = getS(uid);

  // Tenta obter o selb: wstate → elemento visível na tela do operador
  let selb = s.selb;
  if(!selb && !u.isAdmin){
    selb = document.getElementById('op-selb-code')?.textContent?.trim();
    if(selb && selb !== '—') s.selb = selb; // sincroniza wstate
    else selb = null;
  }

  if(!selb){
    return;
  }

  _solicitacaoPecaUid = uid;
  _mspLista = []; // limpa a lista ao abrir
  document.getElementById('msp-selb').textContent = selb;
  document.getElementById('msp-nome').textContent = u.name;
  document.getElementById('msp-obs').value = '';
  document.getElementById('msp-err').textContent = '';
  document.getElementById('msp-peca-selecionada').value = '';
  document.getElementById('msp-quantidade').value = '1';
  onMspPecaChange();
  renderPecasGrid();
  mspResetBusca();
  renderMspLista();
  document.getElementById('modal-solicitar-peca').classList.remove('hidden');
  // Impede que cliques fora do conteúdo fechem o modal (mantém dados preenchidos)
  const _mspModal = document.getElementById('modal-solicitar-peca');
  if(_mspModal && !_mspModal.dataset.outsideClickDisabled){
    _mspModal.dataset.outsideClickDisabled = '1';
    _mspModal.onclick = null;
    _mspModal.removeAttribute('onclick');
    _mspModal.addEventListener('click', function(e){
      if(e.target === _mspModal){ e.stopPropagation(); e.preventDefault(); }
    }, true);
  }
}

function adicionarPecaALista(){
  const peca = document.getElementById('msp-peca-selecionada').value;
  const qtd  = parseInt(document.getElementById('msp-quantidade').value) || 1;
  const obs  = document.getElementById('msp-obs').value.trim();
  const err  = document.getElementById('msp-err');

  if(!peca){ err.textContent = 'Selecione uma peça.'; return; }
  if(peca === 'Outras' && !obs){ err.textContent = 'Descreva a peça no campo Observação.'; return; }
  err.textContent = '';

  _mspLista.push({ peca, quantidade: qtd, obs });

  // Limpa campos para próxima peça
  document.getElementById('msp-peca-selecionada').value = '';
  document.getElementById('msp-quantidade').value = '1';
  document.getElementById('msp-obs').value = '';
  
  renderMspLista();
}

function removerPecaDaLista(index){
  _mspLista.splice(index, 1);
  renderMspLista();
}

function renderMspLista(){
  const container = document.getElementById('msp-lista-container');
  const listItems = document.getElementById('msp-lista-itens');
  const btnEnviar = document.getElementById('btn-enviar-solicitacao');

  if(!_mspLista.length){
    container.style.display = 'none';
    btnEnviar.style.opacity = '0.5';
    btnEnviar.style.pointerEvents = 'none';
    return;
  }

  container.style.display = 'block';
  btnEnviar.style.opacity = '1';
  btnEnviar.style.pointerEvents = 'auto';

  listItems.innerHTML = _mspLista.map((it, idx) => `
    <div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:var(--text)">${it.peca} <span style="color:var(--warn)">x${it.quantidade}</span></div>
        ${it.obs ? `<div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">"${it.obs}"</div>` : ''}
      </div>
      <button onclick="removerPecaDaLista(${idx})" style="background:none;border:none;color:var(--danger);font-size:16px;cursor:pointer;padding:2px 6px">×</button>
    </div>
  `).join('');
}

function abrirSolicitarPecaOperador(){
  if(!currentUser){ alert('Usuário não identificado.'); return; }
  const uid = currentUser.id;
  const s   = getS(uid);

  // Se o wstate já tem o selb, abre direto
  if(s.selb && s.status === 'running'){
    abrirSolicitarPeca(uid);
    return;
  }

  // Fallback: busca selb diretamente do Firebase (race condition entre sync e clique)
  dbGet('/users/'+uid).then(fbUser => {
    if(fbUser && fbUser._selb && fbUser._status === 'running'){
      // Garante que o wstate está atualizado
      s.selb   = fbUser._selb;
      s.status = 'running';
      abrirSolicitarPeca(uid);
    } else {
      // silencioso — não exibe popup
    }
  }).catch(() => {
    // Última tentativa: usa o que está visível na tela
    const selbVisivel = document.getElementById('op-selb-code')?.textContent?.trim();
    if(selbVisivel && selbVisivel !== '—'){
      s.selb   = selbVisivel;
      s.status = 'running';
      abrirSolicitarPeca(uid);
    } else {
      alert('Não foi possível identificar o SELB em andamento. Tente novamente.');
    }
  });
}

// ════════════════════════════════════════════════════════════════════════════
// CADASTRAR SELB — Operador solicita ao admin o cadastro de um novo SELB
// (cai na aba "Solicitação de Peças" do admin)
// ════════════════════════════════════════════════════════════════════════════
function abrirCadastrarSelb(){
  if(!currentUser){ alert('Usuário não identificado.'); return; }

  // Cria modal dinamicamente (não precisa editar o HTML)
  let mod = document.getElementById('modal-cadastrar-selb');
  if(mod) mod.remove();

  mod = document.createElement('div');
  mod.id = 'modal-cadastrar-selb';
  mod.style.cssText = 'position:fixed;inset:0;background:rgba(4,6,10,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:9998;padding:16px';
  mod.innerHTML = `
    <div style="width:min(420px,100%);background:var(--bg2,#11161f);border:1px solid var(--border,#1f2733);border-radius:16px;padding:22px;font-family:var(--font,sans-serif);box-shadow:0 24px 60px rgba(0,0,0,.55)">
      <h2 style="margin:0 0 4px;color:var(--accent,#4f8ef7);font-size:18px;font-weight:700">📝 Cadastrar novo SELB</h2>
      <p style="margin:0 0 18px;color:var(--muted,#7a8493);font-size:12px">A solicitação será enviada ao administrador.</p>

      <label style="display:block;font-size:11px;font-weight:600;color:var(--muted,#7a8493);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">SELB (4 caracteres)</label>
      <input id="cs-selb" maxlength="4" autocomplete="off" placeholder="Ex: A1B2" style="width:100%;padding:11px 14px;background:rgba(255,255,255,.04);border:1px solid var(--border,#1f2733);border-radius:10px;color:var(--text,#e6edf3);font-family:var(--mono,monospace);font-size:18px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;outline:none;margin-bottom:14px">

      <label style="display:block;font-size:11px;font-weight:600;color:var(--muted,#7a8493);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Descrição do modelo</label>
      <input id="cs-modelo" autocomplete="off" placeholder="Ex: HP LaserJet Pro M404" style="width:100%;padding:11px 14px;background:rgba(255,255,255,.04);border:1px solid var(--border,#1f2733);border-radius:10px;color:var(--text,#e6edf3);font-family:var(--font,sans-serif);font-size:14px;outline:none;margin-bottom:8px">

      <div id="cs-err" style="color:var(--danger,#f25757);font-size:12px;min-height:16px;margin-bottom:10px"></div>

      <div style="display:flex;gap:8px">
        <button onclick="document.getElementById('modal-cadastrar-selb').remove()" style="flex:0.5;padding:10px;background:transparent;color:var(--muted,#7a8493);border:1px solid var(--border,#1f2733);border-radius:10px;font-family:var(--font,sans-serif);font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
        <button onclick="confirmarCadastroSelb()" style="flex:1;padding:10px;background:linear-gradient(135deg,rgba(79,142,247,.85),rgba(79,142,247,.65));color:#fff;border:none;border-radius:10px;font-family:var(--font,sans-serif);font-size:13px;font-weight:700;cursor:pointer">Enviar solicitação</button>
      </div>
    </div>`;
  document.body.appendChild(mod);

  const selbInp = document.getElementById('cs-selb');
  selbInp.addEventListener('input', e => { e.target.value = (e.target.value||'').toUpperCase().replace(/[^A-Z0-9]/g,''); });
  setTimeout(()=>selbInp.focus(), 50);

  mod.addEventListener('click', e => { if(e.target === mod) mod.remove(); });
}

async function confirmarCadastroSelb(){
  const errEl = document.getElementById('cs-err');
  if(!errEl) return;
  errEl.textContent = '';

  const selb = (document.getElementById('cs-selb')?.value || '').trim().toUpperCase();
  const modelo = (document.getElementById('cs-modelo')?.value || '').trim();

  if(selb.length !== 4){ errEl.textContent = 'SELB precisa ter exatamente 4 caracteres.'; return; }
  if(!modelo){ errEl.textContent = 'Informe a descrição do modelo.'; return; }
  if(!currentUser){ errEl.textContent = 'Usuário não identificado.'; return; }

  try {
    const solicitacao = {
      tipo: 'cadastro_selb',
      selb,
      equipamento: modelo,
      peca: '📝 Cadastrar SELB — ' + modelo,
      quantidade: 1,
      obs: 'Solicitação de cadastro de novo SELB no sistema.',
      uid: currentUser.id,
      nome: currentUser.name,
      setor: currentUser.sector || '',
      ts: Date.now(),
      lida: false
    };
    await _db.ref('/solicitacoes_pecas').push(solicitacao);
    document.getElementById('modal-cadastrar-selb')?.remove();
    if(typeof mostrarToastPeca === 'function'){
      mostrarToastPeca('Solicitação de cadastro do SELB ' + selb + ' enviada!');
    } else {
      alert('Solicitação enviada!');
    }
  } catch(e){
    console.error('Erro ao cadastrar SELB:', e);
    errEl.textContent = 'Erro ao enviar solicitação. Tente novamente.';
  }
}


function getPecaQtd(){
  return Math.max(1, parseInt(document.getElementById('msp-quantidade')?.value) || 1);
}

async function confirmarSolicitarPeca(){
  const errEl = document.getElementById('msp-err');
  if(!_mspLista.length){ errEl.textContent = 'Adicione ao menos uma peça à lista.'; return; }
  errEl.textContent = '';

  const uid = _solicitacaoPecaUid;
  const u   = users.find(x=>x.id===uid);
  if(!u){ errEl.textContent = 'Usuário não encontrado.'; return; }

  const s = getS(uid);
  const selb = s.selb || document.getElementById('msp-selb')?.textContent?.trim();
  if(!selb || selb === '—'){ errEl.textContent = 'SELB não identificado.'; return; }

  const equipName = getEquipName(selb) || '';
  const now = Date.now();

  try {
    const promises = _mspLista.map(it => {
      const solicitacao = {
        selb, equipamento: equipName, peca: it.peca,
        quantidade: it.quantidade,
        obs: it.obs || '', uid, nome: u.name,
        setor: u.sector, ts: now, lida: false
      };
      return _db.ref('/solicitacoes_pecas').push(solicitacao);
    });

    await Promise.all(promises);
    closeModal('modal-solicitar-peca');
    atualizarOpPecaPendente(uid);
    mostrarToastPeca(`${_mspLista.length} peça(s) solicitada(s) com sucesso!`);
  } catch(e){
    errEl.textContent = 'Erro ao enviar solicitações.';
    console.error('Erro solicitar peças:', e);
  }
}

let _chartSolPecas = null;

function _initSolicitacoesFilters(){
  const from = document.getElementById('solicitacoes-date-from');
  const to = document.getElementById('solicitacoes-date-to');
  if(from && !from.value) from.value = new Date().toISOString().slice(0,10);
  if(to && !to.value) to.value = new Date().toISOString().slice(0,10);

  // Popula Modelos
  const modSel = document.getElementById('solicitacoes-model');
  if(modSel && modSel.options.length <= 1){
    const models = new Set();
    Object.values(equipamentos).forEach(m => { if(m) models.add(m.trim().toUpperCase()); });
    const sorted = Array.from(models).sort();
    sorted.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m;
      modSel.appendChild(opt);
    });
  }
}

function renderSolicitacoesDoDia(){
  const tbody = document.getElementById('solicitacoes-dia-body');
  if(!tbody) return;

  const q = (document.getElementById('solicitacoes-search').value||'').toUpperCase();
  const dFrom = document.getElementById('solicitacoes-date-from').value;
  const dTo = document.getElementById('solicitacoes-date-to').value;
  const modFilt = (document.getElementById('solicitacoes-model').value || '').toUpperCase();
  
  if(!dFrom || !dTo) return;

  const startTs = new Date(dFrom + 'T00:00:00').getTime();
  const endTs = new Date(dTo + 'T23:59:59').getTime();

  const todas = Object.values(_solicitacoesPecas || {});
  const filtered = todas.filter(p => {
    const dataOk = p.ts && p.ts >= startTs && p.ts <= endTs;
    const modelOk = !modFilt || (p.equipamento || '').toUpperCase().includes(modFilt);
    const match  = !q || (p.selb||'').includes(q) || (p.nome||'').toUpperCase().includes(q) || (p.peca||'').toUpperCase().includes(q);
    return dataOk && modelOk && match;
  }).sort((a,b) => (b.ts||0) - (a.ts||0));

  if(!filtered.length){
    tbody.innerHTML = `<tr><td colspan="8" class="empty">Nenhuma solicitação encontrada neste período.</td></tr>`;
    _renderSolicitacoesStats([]);
    return;
  }

  // Agrupar por SELB + UID + DATA para unificar linhas (por dia)
  const groups = {};
  filtered.forEach(p => {
    const key = (p.selb || 'SN') + '_' + (p.uid || '') + '_' + new Date(p.ts).toDateString();
    if(!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  tbody.innerHTML = Object.keys(groups).map(key => {
    const items = groups[key];
    const p = items[0];
    const totalPecas = items.reduce((acc, it) => acc + (parseInt(it.quantidade) || 1), 0);
    const pecasDesc = items.map(it => it.peca).join(', ');
    const todosLidos = items.every(it => it.lida);
    const statusClass = todosLidos ? 'bok' : 'bpec';
    const statusLabel = todosLidos ? 'Entregue' : 'Pendente';

    return `
      <tr onclick="abrirDetalhesSolicitacaoDia('${key}')" style="cursor:pointer">
        <td style="font-family:var(--mono);font-size:12px;color:var(--muted)">${new Date(p.ts).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})} ${new Date(p.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</td>
        <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${p.selb}</td>
        <td style="font-size:11px;color:var(--muted)">${p.equipamento || '—'}</td>
        <td>${p.nome} <span style="font-size:10px;color:var(--muted)">· ${p.setor}</span></td>
        <td>
          <span style="background:rgba(245,166,35,.15);color:var(--warn);border-radius:6px;font-size:11px;font-weight:700;padding:2px 8px;max-width:180px;display:inline-block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${items.length > 1 ? `(${items.length}) ${pecasDesc}` : p.peca}
          </span>
        </td>
        <td style="font-family:var(--mono);font-weight:700;color:var(--warn)">${totalPecas}</td>
        <td style="font-size:11px;color:var(--muted);max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${items.map(it => it.obs).filter(o=>o).join(' | ') || '—'}</td>
        <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      </tr>
    `;
  }).join('');

  _renderSolicitacoesStats(filtered);
}

function _renderSolicitacoesStats(data) {
  const stats = {};
  let total = 0;
  data.forEach(p => {
    const qtd = parseInt(p.quantidade) || 1;
    const pecaLimpa = p.peca.trim();
    stats[pecaLimpa] = (stats[pecaLimpa] || 0) + qtd;
    total += qtd;
  });

  document.getElementById('sol-total-pecas').textContent = `TOTAL: ${total} PEÇAS`;

  const sorted = Object.entries(stats).sort((a,b) => b[1] - a[1]);
  
  // Resumo Detalhado
  const listEl = document.getElementById('solicitacoes-resumo-lista');
  listEl.innerHTML = sorted.map(([name, count]) => `
    <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center">
      <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${name}</div>
      <div style="font-family:var(--mono);font-weight:700;color:var(--warn);font-size:14px">${count}</div>
    </div>
  `).join('');

  // Gráfico de Pizza
  const canvas = document.getElementById('chart-sol-pecas');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  if(_chartSolPecas) _chartSolPecas.destroy();

  const top10 = sorted.slice(0, 10);
  if(top10.length === 0){
    if(_chartSolPecas) _chartSolPecas.destroy();
    return;
  }

  _chartSolPecas = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: top10.map(s => s[0]),
      datasets: [{
        data: top10.map(s => s[1]),
        backgroundColor: [
          '#f5a623', '#4f8ef7', '#a78bfa', '#10b981', '#f25757',
          '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#06b6d4'
        ],
        borderWidth: 0,
        hoverOffset: 15
      }]
    },
    plugins: [outsideLabelsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 50, bottom: 50, left: 130, right: 130 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10,12,20,0.9)',
          titleFont: { size: 13, weight: 'bold' },
          bodyFont: { size: 12 },
          padding: 12,
          cornerRadius: 10,
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${ctx.raw} unidades`
          }
        }
      }
    }
  });
}

// ── Modal de Detalhes da Solicitação (Unificada) ──────────────────────────────
function abrirDetalhesSolicitacaoDia(key){
  const todas = Object.values(_solicitacoesPecas || {});
  const group = todas.filter(p => {
    const groupKey = (p.selb || 'SN') + '_' + (p.uid || '') + '_' + new Date(p.ts).toDateString();
    return groupKey === key;
  });

  if(!group.length) return;

  const p = group[0];
  const html = `
    <div style="background:var(--bg);border-radius:18px;padding:24px;max-width:500px;width:90%;position:relative;border:1px solid var(--border)">
      <button onclick="this.parentElement.parentElement.remove()" style="position:absolute;top:15px;right:15px;background:none;border:none;color:var(--muted);font-size:24px;cursor:pointer">×</button>
      
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <div style="width:48px;height:48px;background:rgba(245,166,35,.15);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px">📦</div>
        <div>
          <h2 style="font-size:18px;font-weight:700;color:var(--accent)">${p.selb}</h2>
          <div style="font-size:12px;color:var(--muted)">Solicitado em ${new Date(p.ts).toLocaleTimeString('pt-BR')}</div>
        </div>
      </div>

      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:15px;margin-bottom:20px">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:0.05em;margin-bottom:8px">Profissional</div>
        <div style="font-weight:600;font-size:14px">${p.nome} <span style="font-weight:400;color:var(--muted)">(${p.setor})</span></div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">${p.equipamento || ''}</div>
      </div>

      <div style="font-size:11px;color:var(--muted);text-transform:uppercase;font-weight:700;letter-spacing:0.05em;margin-bottom:10px">Peças Solicitadas</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${group.map(it => `
          <div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:5px">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span style="font-weight:700;color:var(--warn);font-size:13px">${it.peca} <span style="color:var(--muted);font-weight:400">x${it.quantidade}</span></span>
              <span class="badge ${it.lida ? 'bok' : 'bpec'}" style="font-size:9px">${it.lida ? 'Entregue' : 'Pendente'}</span>
            </div>
            ${it.obs ? `<div style="font-size:11px;color:var(--muted);font-style:italic">"${it.obs}"</div>` : ''}
          </div>
        `).join('')}
      </div>
      
      <button onclick="this.parentElement.parentElement.remove()" style="margin-top:24px;width:100%;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-family:var(--font);font-size:13px;font-weight:600;padding:12px;cursor:pointer">Fechar</button>
    </div>
  `;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(10,12,20,0.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center';
  overlay.onclick = (e) => { if(e.target === overlay) overlay.remove(); };
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

// ── Feedback operador: peça pendente ────────────────────────────────────────
function atualizarOpPecaPendente(uid){
  const box    = document.getElementById('op-peca-pendente');
  const nomeEl = document.getElementById('op-peca-pendente-nome');
  if(!box) return;
  const s = getS(uid);
  const pendentes = Object.values(_solicitacoesPecas)
    .filter(p => p.uid===uid && p.selb===s.selb && !p.lida)
    .sort((a,b)=>(a.ts||0)-(b.ts||0));
  if(pendentes.length){
    box.style.display='block';
    const tituloEl = box.querySelector('div');
    if(tituloEl) tituloEl.innerHTML = `🔔 Solicitação${pendentes.length>1?'ões':''} enviada${pendentes.length>1?'s':''} <span style="background:rgba(245,166,35,.2);color:var(--warn);border-radius:999px;font-size:10px;font-weight:700;padding:1px 7px;margin-left:4px">${pendentes.length}</span>`;
    nomeEl.innerHTML = pendentes.map(p => {
      const qtd = (p.qtd && p.qtd>1) ? ` <span style="color:var(--warn);font-weight:700">×${p.qtd}</span>` : '';
      const obs = p.obs ? `<div style="font-size:11px;color:var(--muted);opacity:.8;margin-top:1px">${p.obs}</div>` : '';
      return `<div style="padding:6px 0;border-top:1px solid rgba(245,166,35,.15)"><div style="font-size:12px;color:var(--text);font-weight:600">🔩 ${p.peca||'—'}${qtd}</div>${obs}</div>`;
    }).join('');
  } else {
    box.style.display='none';
  }
}

// ── Notificações admin: solicitações não lidas ───────────────────────────────
function atualizarNotifPecasAdmin(){
  const panel = document.getElementById('admin-pecas-notif-panel');
  const list  = document.getElementById('admin-pecas-notif-list');
  const badge = document.getElementById('admin-pecas-badge');
  if(!panel||!list) return;
  if(!(currentUser&&currentUser.isAdmin)){ panel.style.display='none'; return; }
  const pendentes = Object.entries(_solicitacoesPecas)
    .filter(([,p])=>!p.lida).sort(([,a],[,b])=>(b.ts||0)-(a.ts||0));
  if(!pendentes.length){ panel.style.display='none'; return; }
  panel.style.display='block';
  badge.textContent=pendentes.length;
  list.innerHTML=pendentes.map(([id,p])=>`
    <div style="display:flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid rgba(245,166,35,.25);border-radius:10px;padding:10px 14px;flex-wrap:wrap">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">
          <span style="font-family:var(--mono);font-weight:700;color:var(--accent);font-size:13px">${p.selb}</span>
          <span style="background:rgba(245,166,35,.15);color:var(--warn);border-radius:6px;font-size:10px;font-weight:700;padding:2px 8px">${p.peca}</span>
          <span style="font-size:11px;color:var(--muted)">${p.setor}</span>
        </div>
        <div style="font-size:12px;color:var(--text)">${p.nome}${p.equipamento?' · '+p.equipamento:''}</div>
        ${p.obs?`<div style="font-size:11px;color:var(--muted);margin-top:2px">${p.obs}</div>`:''}
        <div style="font-size:10px;color:var(--muted);margin-top:3px">${new Date(p.ts).toLocaleString('pt-BR')}</div>
      </div>
      <button onclick="entregarPeca('${id}','${p.selb||''}')" style="background:rgba(61,214,140,.15);border:1px solid rgba(61,214,140,.5);border-radius:8px;color:var(--accent2);font-family:var(--font);font-size:11px;font-weight:700;padding:6px 12px;cursor:pointer;white-space:nowrap">✅ Peça Entregue</button>
    </div>
  `).join('');
}

async function marcarPecaLida(id){
  try { await _db.ref('/solicitacoes_pecas/'+id).update({lida:true}); } catch(e){}
}
async function marcarPecaLida(id){
  try { await _db.ref('/solicitacoes_pecas/'+id).update({lida:true}); } catch(e){}
}

// ── Marca/desmarca peça como "já solicitada" via checkbox na tabela ──────────
async function marcarPecaSolicitada(id, checked, checkboxEl){
  // Feedback visual imediato
  if(checkboxEl){
    checkboxEl.style.background = checked ? 'var(--accent2)' : 'var(--bg3)';
    checkboxEl.style.borderColor = checked ? 'var(--accent2)' : 'rgba(61,214,140,.5)';
    const label = checkboxEl.closest('label');
    if(label){
      const nameEl = label.querySelector('span:last-child');
      if(nameEl){
        nameEl.style.color = checked ? 'var(--muted)' : 'var(--warn)';
        nameEl.style.textDecoration = checked ? 'line-through' : '';
      }
    }
  }
  try {
    await _db.ref('/solicitacoes_pecas/'+id).update({ lida: checked });
  } catch(e){
    // Reverte visual em caso de erro
    if(checkboxEl){
      checkboxEl.checked = !checked;
      checkboxEl.style.background = !checked ? 'var(--accent2)' : 'var(--bg3)';
      checkboxEl.style.borderColor = !checked ? 'var(--accent2)' : 'rgba(61,214,140,.5)';
    }
    alert('Erro ao salvar. Tente novamente.');
  }
}

async function entregarPeca(id, selb){
  if(!confirm('Confirmar entrega da peça para o SELB ' + selb + '?\n\nO registro será mantido no histórico.')) return;
  try {
    await _db.ref('/solicitacoes_pecas/'+id).update({ lida: true, entregueTs: Date.now() });
  } catch(e){
    alert('Erro ao confirmar entrega.');
    console.error('entregarPeca error:', e);
  }
}
async function removerSolicitacaoPeca(id, selb){
  if(!confirm('Tem certeza que deseja EXCLUIR permanentemente esta solicitação do SELB ' + selb + '?\n\nEsta ação não pode ser desfeita e removerá o registro do histórico.')) return;
  try {
    await _db.ref('/solicitacoes_pecas/'+id).remove();
  } catch(e){
    alert('Erro ao excluir solicitação.');
    console.error('removerSolicitacaoPeca error:', e);
  }
}
async function marcarTodasPecasLidas(){
  const pendentes=Object.entries(_solicitacoesPecas).filter(([,p])=>!p.lida);
  for(const [id] of pendentes) await _db.ref('/solicitacoes_pecas/'+id).update({lida:true}).catch(()=>{});
}

function atualizarBadgeTopbarPecas(){
  if(!(currentUser&&currentUser.isAdmin)){ document.getElementById('topbar-peca-notif-dot')?.remove(); return; }
  const count=Object.values(_solicitacoesPecas).filter(p=>!p.lida).length;
  const tabPecas=document.getElementById('tab-pecas'); if(!tabPecas) return;
  let badge=document.getElementById('topbar-peca-notif-dot');
  if(count>0){
    if(!badge){ badge=document.createElement('span'); badge.id='topbar-peca-notif-dot'; badge.style.cssText='display:inline-block;width:8px;height:8px;background:var(--warn);border-radius:50%;margin-left:5px;vertical-align:middle;animation:pulse 1.5s ease infinite;'; tabPecas.appendChild(badge); }
    tabPecas.title=`${count} solicitação(ões) de peça pendente(s)`;
  } else { badge?.remove(); tabPecas.title=''; }
}

function mostrarToastPeca(msg){
  const t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(245,166,35,.95);color:#000;border-radius:12px;padding:12px 22px;font-family:var(--font);font-size:13px;font-weight:700;z-index:9999;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none;white-space:nowrap;';
  t.textContent='🔩 '+msg; document.body.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .4s'; setTimeout(()=>t.remove(),400); },3500);
}

// ════════════════════════════════════════════
// CONFIGURAÇÃO DE PEÇAS — GERENCIAMENTO ADMIN
// /config_pecas/{id} → { nome, emoji, ordem }
// ════════════════════════════════════════════

function renderConfigPecasAdmin(){
  const panel  = document.getElementById('admin-config-pecas-panel');
  const lista  = document.getElementById('config-pecas-lista');
  const count  = document.getElementById('config-pecas-count');
  if(!panel||!lista) return;
  // Só exibe para admins e somente na view admin
  if(!(currentUser&&currentUser.isAdmin)){ panel.style.display='none'; return; }
  panel.style.display='block';

  const pecas = getListaPecas();
  count.textContent = pecas.length + (pecas.length===1?' peça':' peças');

  if(!pecas.length){
    lista.innerHTML=`<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">Nenhuma peça cadastrada.<br><span style="font-size:11px">Clique em "+ Adicionar Peça" para começar.</span></div>`;
    return;
  }

  lista.innerHTML = pecas.map((p,i) => `
    <div style="display:flex;align-items:center;gap:10px;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px 14px">
      <span style="font-size:22px;flex-shrink:0">${p.emoji}</span>
      <span style="flex:1;font-size:13px;font-weight:600;color:var(--text)">${p.nome}</span>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button onclick="moverPeca('${p.id}',-1)" title="Subir" ${i===0?'disabled':''}
          style="background:var(--bg2);border:1px solid var(--border2);border-radius:7px;color:var(--muted);font-size:13px;padding:4px 8px;cursor:pointer;${i===0?'opacity:.3;cursor:not-allowed':''}">▲</button>
        <button onclick="moverPeca('${p.id}',1)" title="Descer" ${i===pecas.length-1?'disabled':''}
          style="background:var(--bg2);border:1px solid var(--border2);border-radius:7px;color:var(--muted);font-size:13px;padding:4px 8px;cursor:pointer;${i===pecas.length-1?'opacity:.3;cursor:not-allowed':''}">▼</button>
        <button onclick="abrirModalEditarPeca('${p.id}')"
          style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:7px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">✏️ Editar</button>
        <button onclick="confirmarRemoverPeca('${p.id}','${p.nome.replace(/'/g,"\\'")}')"
          style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.3);border-radius:7px;color:var(--danger);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">🗑️</button>
      </div>
    </div>
  `).join('');
}

function abrirModalNovaPeca(){
  document.getElementById('mcp-title').textContent = '🔩 Nova Peça';
  document.getElementById('mcp-id').value   = '';
  document.getElementById('mcp-nome').value = '';
  document.getElementById('mcp-emoji').value= '⚙️';
  document.getElementById('mcp-err').textContent = '';
  document.getElementById('modal-config-peca').classList.remove('hidden');
}

function abrirModalEditarPeca(id){
  const p = _configPecas[id];
  if(!p){ alert('Peça não encontrada.'); return; }
  document.getElementById('mcp-title').textContent = '✏️ Editar Peça';
  document.getElementById('mcp-id').value   = id;
  document.getElementById('mcp-nome').value = p.nome || '';
  document.getElementById('mcp-emoji').value= p.emoji || '⚙️';
  document.getElementById('mcp-err').textContent = '';
  document.getElementById('modal-config-peca').classList.remove('hidden');
}

async function salvarConfigPeca(){
  const id    = document.getElementById('mcp-id').value.trim();
  const nome  = document.getElementById('mcp-nome').value.trim();
  const emoji = document.getElementById('mcp-emoji').value.trim() || '⚙️';
  const errEl = document.getElementById('mcp-err');
  if(!nome){ errEl.textContent='Informe o nome da peça.'; return; }
  errEl.textContent='';

  try {
    if (id) {
      const { error } = await _supa.from('config_pecas').update({ nome, emoji, raw: { nome, emoji } }).eq('id', id);
      if (error) throw error;
    } else {
      const maxOrdem = Object.values(_configPecas).reduce((m, p) => Math.max(m, p.ordem || 0), 0);
      const { error } = await _supa.from('config_pecas').insert({ nome, emoji, ordem: maxOrdem + 1, raw: { nome, emoji, ordem: maxOrdem + 1 } });
      if (error) throw error;
    }
    closeModal('modal-config-peca');
  } catch(e) {
    errEl.textContent = 'Erro ao salvar. Tente novamente.';
  }
}

async function confirmarRemoverPeca(id, nome){
  if(!confirm(`Remover a peça "${nome}"?\n\nEla deixará de aparecer para os operadores solicitarem.`)) return;
  try {
    const { error } = await _supa.from('config_pecas').delete().eq('id', id);
    if (error) throw error;
  } catch(e) { alert('Erro ao remover peça.'); }
}

// ── LOGS DE PEÇAS ──
function registrarLogPecas(selb, equip, msg) {
  const log = {
    ts: Date.now(),
    selb: selb || '—',
    equipamento: equip || '—',
    mensagem: msg,
    usuario: currentUser ? currentUser.name : 'Sistema',
    data: new Date().toLocaleDateString('pt-BR') + ' ' + new Date().toLocaleTimeString('pt-BR')
  };
  dbPush('/logs_pecas', log).catch(e => console.error("Erro log pecas:", e));
}

async function abrirModalLogsPecas() {
  const tbody = document.getElementById('logs-pecas-body');
  if(!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="empty">Carregando...</td></tr>';
  document.getElementById('modal-logs-pecas').classList.remove('hidden');
  
  try {
    const data = await dbGet('/logs_pecas');
    if(!data) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty">Nenhum registro encontrado.</td></tr>';
      return;
    }
    const list = Object.values(data).sort((a,b) => b.ts - a.ts).slice(0, 100); // últimos 100
    tbody.innerHTML = list.map(l => `
      <tr>
        <td style="font-size:11px;color:var(--muted);white-space:nowrap">${l.data || new Date(l.ts).toLocaleString('pt-BR')}</td>
        <td style="font-weight:600;color:var(--accent)">${l.selb}</td>
        <td>${l.usuario}</td>
        <td style="font-size:12px">${l.mensagem}</td>
      </tr>
    `).join('');
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty">Erro ao carregar logs.</td></tr>';
  }
}

async function moverPeca(id, direcao){
  const pecas = getListaPecas().filter(p=>!p.id.startsWith('pad_'));
  // Se ainda estiver usando padrão, inicializa no Firebase primeiro
  if (!Object.keys(_configPecas).length) {
    for (let i = 0; i < PECAS_PADRAO.length; i++) {
      const p = PECAS_PADRAO[i];
      await _supa.from('config_pecas').insert({ nome: p.nome, emoji: p.emoji, ordem: i + 1, raw: p });
    }
    await _reloadConfigPecas();
    return;
  }
  const idx = pecas.findIndex(p => p.id === id);
  if (idx === -1) return;
  const swapIdx = idx + direcao;
  if (swapIdx < 0 || swapIdx >= pecas.length) return;
  const a = pecas[idx], b = pecas[swapIdx];
  const ordemA = _configPecas[a.id]?.ordem ?? idx + 1;
  const ordemB = _configPecas[b.id]?.ordem ?? swapIdx + 1;
  await _supa.from('config_pecas').update({ ordem: ordemB }).eq('id', a.id);
  await _supa.from('config_pecas').update({ ordem: ordemA }).eq('id', b.id);
}

// ════════════════════════════════════════════
// GARANTIA
// Armazenado em /garantia/{id} no Firebase
// Campos: nome, codigo, motivo, status, registradoPor, registradoEm (ts), uid
// ════════════════════════════════════════════

let _garantiaCache    = {};   // cache local { id: {...} }
let _garantiaFilter   = '';   // filtro de status atual
let _garantiaListener = null; // referência ao listener Firebase

// ── Listener Firebase ────────────────────────────────────────────────────────
function startGarantiaListener(){
  if(!_db || _garantiaListener) return;
  _garantiaListener = _db.ref('/garantia').on('value', snap => {
    _garantiaCache = snap.val() || {};
    if(document.getElementById('view-garantia')?.classList.contains('active')){
      renderGarantiaView();
    }
  });
}

// ── Visibilidade dos controles admin ────────────────────────────────────────
function atualizarGarantiaAdminControls(){
  const isAdmin = currentUser && currentUser.isAdmin;
  const btnAdd  = document.getElementById('btn-add-garantia');
  const thAcoes = document.getElementById('garantia-th-acoes');
  if(btnAdd)  btnAdd.style.display  = isAdmin ? '' : 'none';
  if(thAcoes) thAcoes.style.display = isAdmin ? '' : 'none';
}

// ── Filtro de status ─────────────────────────────────────────────────────────
function setGarantiaFilter(status, btn){
  _garantiaFilter = status;
  // highlight stab
  document.querySelectorAll('#garantia-tabs .stab').forEach(b => b.classList.remove('a-all','a-mont','a-limp','a-comp'));
  if(btn) btn.classList.add('a-all');
  renderGarantiaView();
}

// ── Render principal ─────────────────────────────────────────────────────────
function renderGarantiaView(){
  atualizarGarantiaAdminControls();
  _renderGarantiaKpi();
  _renderGarantiaTabela();
}

function _renderGarantiaKpi(){
  const kpiEl = document.getElementById('garantia-kpi');
  if(!kpiEl) return;
  const all       = Object.values(_garantiaCache);
  const total     = all.length;
  const pendentes = all.filter(r => r.status === 'pendente' || !r.status).length;
  const aprovados = all.filter(r => r.status === 'aprovado').length;
  const reprov    = all.filter(r => r.status === 'reprovado').length;

  kpiEl.innerHTML = `
    <div class="sum-card" style="cursor:pointer" onclick="setGarantiaFilter('',document.querySelector('#garantia-tabs .stab'))">
      <div class="slbl">Total registros</div>
      <div class="sval" style="color:var(--purple)">${total}</div>
    </div>
    <div class="sum-card" style="cursor:pointer" onclick="setGarantiaFilter('pendente',document.querySelectorAll('#garantia-tabs .stab')[1])">
      <div class="slbl">Pendentes</div>
      <div class="sval" style="color:var(--warn)">${pendentes}</div>
    </div>
    <div class="sum-card" style="cursor:pointer" onclick="setGarantiaFilter('aprovado',document.querySelectorAll('#garantia-tabs .stab')[2])">
      <div class="slbl">Aprovados</div>
      <div class="sval" style="color:var(--accent2)">${aprovados}</div>
    </div>
    <div class="sum-card" style="cursor:pointer" onclick="setGarantiaFilter('reprovado',document.querySelectorAll('#garantia-tabs .stab')[3])">
      <div class="slbl">Reprovados</div>
      <div class="sval" style="color:var(--danger)">${reprov}</div>
    </div>
  `;
}

function _renderGarantiaTabela(){
  const tbody  = document.getElementById('garantia-body');
  if(!tbody) return;
  const q      = (document.getElementById('garantia-search')?.value || '').toUpperCase();
  const isAdmin = currentUser && currentUser.isAdmin;

  let registros = Object.entries(_garantiaCache)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.registradoEm || 0) - (a.registradoEm || 0));

  // Filtro de status
  if(_garantiaFilter){
    registros = registros.filter(r => (r.status || 'pendente') === _garantiaFilter);
  }

  // Filtro de busca
  if(q){
    registros = registros.filter(r =>
      (r.nome     || '').toUpperCase().includes(q) ||
      (r.codigo   || '').toUpperCase().includes(q) ||
      (r.motivo   || '').toUpperCase().includes(q) ||
      (r.registradoPor || '').toUpperCase().includes(q)
    );
  }

  if(!registros.length){
    tbody.innerHTML = `<tr><td colspan="8" class="empty" style="text-align:center;padding:28px;color:var(--muted)">
      ${q || _garantiaFilter ? 'Nenhum registro encontrado para este filtro.' : 'Nenhuma peça registrada em garantia ainda.'}
    </td></tr>`;
    return;
  }

  const statusMap = {
    pendente:  { label: '⏳ Pendente',  color: 'var(--warn)',    bg: 'rgba(245,166,35,.12)',   border: 'rgba(245,166,35,.35)'   },
    aprovado:  { label: '✅ Aprovado',  color: 'var(--accent2)', bg: 'rgba(61,214,140,.1)',    border: 'rgba(61,214,140,.3)'    },
    reprovado: { label: '❌ Reprovado', color: 'var(--danger)',  bg: 'rgba(242,87,87,.1)',     border: 'rgba(242,87,87,.3)'     },
  };

  tbody.innerHTML = registros.map((r, i) => {
    const st  = statusMap[r.status || 'pendente'] || statusMap.pendente;
    const dt  = r.registradoEm ? new Date(r.registradoEm).toLocaleString('pt-BR') : '—';
    const cod = r.codigo ? `<span style="font-family:var(--mono);font-size:11px;background:var(--bg3);padding:2px 7px;border-radius:5px;border:1px solid var(--border)">${r.codigo}</span>` : '<span style="color:var(--muted)">—</span>';
    return `
      <tr>
        <td style="color:var(--muted);font-size:11px;font-family:var(--mono)">${i + 1}</td>
        <td style="font-weight:600;color:var(--text);max-width:180px">${r.nome || '—'}</td>
        <td>${cod}</td>
        <td style="text-align:center"><span style="background:rgba(245,166,35,.15);color:var(--warn);border-radius:7px;font-family:var(--mono);font-size:12px;font-weight:700;padding:2px 10px">${r.quantidade || 1}</span></td>
        <td style="max-width:240px;font-size:12px;color:var(--muted);white-space:pre-wrap;word-break:break-word">${r.motivo || '—'}</td>
        <td style="font-size:12px">${r.registradoPor || '—'}</td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap">${dt}</td>
        <td>
          <span style="display:inline-block;padding:3px 10px;border-radius:8px;font-size:10px;font-weight:700;
            color:${st.color};background:${st.bg};border:1px solid ${st.border};white-space:nowrap">
            ${st.label}
          </span>
        </td>
        ${isAdmin ? `
        <td>
          <div style="display:flex;gap:5px;flex-wrap:wrap">
            <button onclick="abrirModalEditarGarantia('${r.id}')"
              style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:7px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">✏️ Editar</button>
            <button onclick="confirmarRemoverGarantia('${r.id}','${(r.nome||'').replace(/'/g,"\\'")}') "
              style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.3);border-radius:7px;color:var(--danger);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">🗑️</button>
          </div>
        </td>` : '<td style="display:none"></td>'}
      </tr>
    `;
  }).join('');
}


function mgAlterarQtd(delta){
  const inp = document.getElementById('mg-quantidade');
  if(!inp) return;
  let v = parseInt(inp.value) || 1;
  v = Math.max(1, Math.min(999, v + delta));
  inp.value = v;
}

// ── Abrir modais ─────────────────────────────────────────────────────────────
function abrirModalNovaGarantia(){
  document.getElementById('mg-title').textContent  = '🛡️ Registrar Peça em Garantia';
  document.getElementById('mg-id').value           = '';
  document.getElementById('mg-nome').value         = '';
  document.getElementById('mg-codigo').value       = '';
  document.getElementById('mg-motivo').value       = '';
  document.getElementById('mg-status').value       = 'pendente';
  document.getElementById('mg-quantidade').value   = '1';
  document.getElementById('mg-err').textContent    = '';
  document.getElementById('modal-garantia').classList.remove('hidden');
  setTimeout(() => document.getElementById('mg-nome').focus(), 80);
}

function abrirModalEditarGarantia(id){
  const r = _garantiaCache[id];
  if(!r){ alert('Registro não encontrado.'); return; }
  document.getElementById('mg-title').textContent  = '✏️ Editar Registro de Garantia';
  document.getElementById('mg-id').value           = id;
  document.getElementById('mg-nome').value         = r.nome       || '';
  document.getElementById('mg-codigo').value       = r.codigo     || '';
  document.getElementById('mg-motivo').value       = r.motivo     || '';
  document.getElementById('mg-status').value       = r.status     || 'pendente';
  document.getElementById('mg-quantidade').value   = r.quantidade || 1;
  document.getElementById('mg-err').textContent    = '';
  document.getElementById('modal-garantia').classList.remove('hidden');
}

// ── Salvar (criar ou editar) ─────────────────────────────────────────────────
async function salvarGarantia(){
  const id     = document.getElementById('mg-id').value.trim();
  const nome       = document.getElementById('mg-nome').value.trim();
  const codigo     = document.getElementById('mg-codigo').value.trim();
  const motivo     = document.getElementById('mg-motivo').value.trim();
  const status     = document.getElementById('mg-status').value;
  const quantidade = Math.max(1, parseInt(document.getElementById('mg-quantidade').value) || 1);
  const errEl      = document.getElementById('mg-err');

  if(!nome)  { errEl.textContent = 'Informe o nome da peça.';    document.getElementById('mg-nome').focus();   return; }
  if(!motivo){ errEl.textContent = 'Informe o motivo da garantia.'; document.getElementById('mg-motivo').focus(); return; }
  errEl.textContent = '';

  const registradoPor = currentUser?.name || 'Admin';

  try {
    if(id){
      // Editar
      await _db.ref('/garantia/'+id).update({ nome, codigo, motivo, status, quantidade, registradoPor });
    } else {
      // Novo
      await _db.ref('/garantia').push({ nome, codigo, motivo, status, quantidade, registradoPor, registradoEm: Date.now() });
    }
    closeModal('modal-garantia');
  } catch(e){
    errEl.textContent = 'Erro ao salvar. Tente novamente.';
    console.error('Garantia save error:', e);
  }
}

// ── Remover ──────────────────────────────────────────────────────────────────
async function confirmarRemoverGarantia(id, nome){
  if(!confirm(`Remover o registro da peça "${nome}"?\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    await _db.ref('/garantia/'+id).remove();
  } catch(e){
    alert('Erro ao remover registro.');
    console.error('Garantia remove error:', e);
  }
}

// ── Alterna entre as sub-abas "Registro de Garantia" e "Devolução" ───────────
function setGarantiaSubTab(tab){
  const vReg = document.getElementById('garview-registro');
  const vDev = document.getElementById('garview-devolucao');
  if(vReg) vReg.style.display = tab === 'registro'  ? 'block' : 'none';
  if(vDev) vDev.style.display = tab === 'devolucao' ? 'block' : 'none';

  const bReg = document.getElementById('gartab-registro');
  const bDev = document.getElementById('gartab-devolucao');
  [bReg, bDev].forEach(b => { if(b) b.classList.remove('a-all'); });
  if(tab === 'registro'  && bReg) bReg.classList.add('a-all');
  if(tab === 'devolucao' && bDev) bDev.classList.add('a-all');

  if(tab === 'devolucao') renderDevolucaoView();
}

// ════════════════════════════════════════════
// DEVOLUÇÃO DE PEÇAS
// Armazenado em /devolucoes/{id} no Firebase
// Campos: nome, codigo, motivo, quantidade, selb, registradoPor, registradoEm (ts)
// Registro somente interno no LabTech — NÃO altera o estoque do Pietro.
// ════════════════════════════════════════════

let _devolucaoCache    = {};   // cache local { id: {...} }
let _devolucaoListener = null; // referência ao listener Firebase

// ── Listener Firebase ────────────────────────────────────────────────────────
function startDevolucaoListener(){
  if(!_db || _devolucaoListener) return;
  _devolucaoListener = _db.ref('/devolucoes').on('value', snap => {
    _devolucaoCache = snap.val() || {};
    const aba = document.getElementById('garview-devolucao');
    if(aba && aba.style.display !== 'none'){
      renderDevolucaoView();
    }
  });
}

// ── Render principal ─────────────────────────────────────────────────────────
function renderDevolucaoView(){
  _renderDevolucaoKpi();
  _renderDevolucaoTabela();
}

function _renderDevolucaoKpi(){
  const kpiEl = document.getElementById('devolucao-kpi');
  if(!kpiEl) return;
  const all   = Object.values(_devolucaoCache);
  const total = all.length;
  const totalQtd = all.reduce((s,r)=>s+(parseInt(r.quantidade,10)||1), 0);

  kpiEl.innerHTML = `
    <div class="sum-card">
      <div class="slbl">Total de registros</div>
      <div class="sval" style="color:#22d3ee">${total}</div>
    </div>
    <div class="sum-card">
      <div class="slbl">Total de peças devolvidas</div>
      <div class="sval" style="color:#22d3ee">${totalQtd}</div>
    </div>
  `;
}

function _renderDevolucaoTabela(){
  const tbody = document.getElementById('devolucao-body');
  if(!tbody) return;
  const q = (document.getElementById('devolucao-search')?.value || '').toUpperCase();
  const isAdmin = currentUser && currentUser.isAdmin;

  let registros = Object.entries(_devolucaoCache)
    .map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => (b.registradoEm || 0) - (a.registradoEm || 0));

  if(q){
    registros = registros.filter(r =>
      (r.nome     || '').toUpperCase().includes(q) ||
      (r.codigo   || '').toUpperCase().includes(q) ||
      (r.selb     || '').toUpperCase().includes(q) ||
      (r.motivo   || '').toUpperCase().includes(q) ||
      (r.registradoPor || '').toUpperCase().includes(q)
    );
  }

  if(!registros.length){
    tbody.innerHTML = `<tr><td colspan="9" class="empty" style="text-align:center;padding:28px;color:var(--muted)">
      ${q ? 'Nenhum registro encontrado para este filtro.' : 'Nenhuma devolução registrada ainda.'}
    </td></tr>`;
    return;
  }

  tbody.innerHTML = registros.map((r, i) => {
    const dt  = r.registradoEm ? new Date(r.registradoEm).toLocaleString('pt-BR') : '—';
    const cod = r.codigo ? `<span style="font-family:var(--mono);font-size:11px;background:var(--bg3);padding:2px 7px;border-radius:5px;border:1px solid var(--border)">${r.codigo}</span>` : '<span style="color:var(--muted)">—</span>';
    const selb = r.selb ? `<span style="font-family:var(--mono);font-size:11px;color:#e879f9">${r.selb}</span>` : '<span style="color:var(--muted)">—</span>';
    return `
      <tr>
        <td style="color:var(--muted);font-size:11px;font-family:var(--mono)">${i + 1}</td>
        <td style="font-weight:600;color:var(--text);max-width:180px">${r.nome || '—'}</td>
        <td>${cod}</td>
        <td style="text-align:center"><span style="background:rgba(34,211,238,.15);color:#22d3ee;border-radius:7px;font-family:var(--mono);font-size:12px;font-weight:700;padding:2px 10px">${r.quantidade || 1}</span></td>
        <td>${selb}</td>
        <td style="max-width:220px;font-size:12px;color:var(--muted);white-space:pre-wrap;word-break:break-word">${r.motivo || '—'}</td>
        <td style="font-size:12px">${r.registradoPor || '—'}</td>
        <td style="font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap">${dt}</td>
        <td>
          ${isAdmin ? `
          <div style="display:flex;gap:5px;flex-wrap:wrap">
            <button onclick="abrirModalEditarDevolucao('${r.id}')"
              style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:7px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">✏️</button>
            <button onclick="confirmarRemoverDevolucao('${r.id}','${(r.nome||'').replace(/'/g,"\\'")}')"
              style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.3);border-radius:7px;color:var(--danger);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer">🗑️</button>
          </div>` : '—'}
        </td>
      </tr>
    `;
  }).join('');
}

function mdAlterarQtd(delta){
  const inp = document.getElementById('md-quantidade');
  if(!inp) return;
  let v = parseInt(inp.value) || 1;
  v = Math.max(1, Math.min(999, v + delta));
  inp.value = v;
}

// ── Consulta o nome da peça no sistema do Pietro a partir do código bipado ──
// Confirmado no painel do Supabase do Pietro: tabela "parts", colunas "code" (chave
// primária) e "descricao" (nome/descrição da peça). Colunas extras: marca, modelo_pattern.
const PIETRO_PECAS_TABELA      = 'parts';     // tabela no Supabase do Pietro
const PIETRO_PECAS_COL_CODIGO  = 'code';      // coluna com o código bipado (chave primária)
const PIETRO_PECAS_COL_NOME    = 'descricao'; // coluna com o nome/descrição da peça

async function _pietroBuscarNomePeca(codigo){
  // Reaproveita a mesma URL/chave já usadas em outras integrações com o Pietro neste arquivo.
  // Usa "ilike" (case-insensitive) em vez de "eq", pois o código pode estar salvo em
  // minúsculas no banco do Pietro (a tela de Estoque dele mostra os códigos assim),
  // mesmo que aqui no LabTech o campo seja digitado/bipado em maiúsculas.
  const codigoLimpo = String(codigo || '').trim();
  const url = PIETRO_URL + '/rest/v1/' + PIETRO_PECAS_TABELA +
    '?' + PIETRO_PECAS_COL_CODIGO + '=ilike.' + encodeURIComponent(codigoLimpo) +
    '&select=*&limit=1';
  const res = await fetch(url, { headers: _pietroHeaders() });
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const rows = await res.json();
  if(!rows || !rows.length) return null;
  return rows[0][PIETRO_PECAS_COL_NOME] || null;
}

async function buscarNomePecaDevolucao(){
  const codigo = document.getElementById('md-codigo').value.trim().toUpperCase();
  const statusEl = document.getElementById('md-busca-status');
  const btn = document.getElementById('md-btn-buscar');
  if(!codigo){
    statusEl.innerHTML = '<span style="color:var(--warn)">Digite ou bipe um código antes de buscar.</span>';
    return;
  }
  statusEl.innerHTML = '<span style="color:var(--muted)">🔎 Buscando peça "' + codigo + '" no sistema do Pietro...</span>';
  if(btn) btn.disabled = true;
  try{
    const nome = await _pietroBuscarNomePeca(codigo);
    if(nome){
      document.getElementById('md-nome').value = nome;
      statusEl.innerHTML = '<span style="color:var(--accent2)">✓ Peça encontrada: ' + nome + '</span>';
    } else {
      statusEl.innerHTML = '<span style="color:var(--warn)">⚠ Código não encontrado no Pietro. Preencha o nome manualmente.</span>';
      document.getElementById('md-nome').focus();
    }
  } catch(e){
    console.error('[Devolução] erro ao buscar peça no Pietro:', e);
    statusEl.innerHTML = '<span style="color:var(--danger)">✕ Não foi possível consultar o Pietro agora. Preencha o nome manualmente.</span>';
    document.getElementById('md-nome').focus();
  } finally {
    if(btn) btn.disabled = false;
  }
}

// ── Abrir modais ─────────────────────────────────────────────────────────────
function abrirModalNovaDevolucao(){
  document.getElementById('md-title').textContent  = '↩️ Registrar Devolução de Peça';
  document.getElementById('md-id').value           = '';
  document.getElementById('md-codigo').value       = '';
  document.getElementById('md-nome').value         = '';
  document.getElementById('md-selb').value         = '';
  document.getElementById('md-motivo').value       = '';
  document.getElementById('md-quantidade').value   = '1';
  document.getElementById('md-err').textContent    = '';
  document.getElementById('md-busca-status').innerHTML = '';
  document.getElementById('modal-devolucao').classList.remove('hidden');
  setTimeout(() => document.getElementById('md-codigo').focus(), 80);
}

function abrirModalEditarDevolucao(id){
  const r = _devolucaoCache[id];
  if(!r){ alert('Registro não encontrado.'); return; }
  document.getElementById('md-title').textContent  = '✏️ Editar Devolução';
  document.getElementById('md-id').value           = id;
  document.getElementById('md-codigo').value       = r.codigo     || '';
  document.getElementById('md-nome').value         = r.nome       || '';
  document.getElementById('md-selb').value         = r.selb       || '';
  document.getElementById('md-motivo').value       = r.motivo     || '';
  document.getElementById('md-quantidade').value   = r.quantidade || 1;
  document.getElementById('md-err').textContent    = '';
  document.getElementById('md-busca-status').innerHTML = '';
  document.getElementById('modal-devolucao').classList.remove('hidden');
}

// ── Salvar (criar ou editar) — registro 100% interno, não chama o Pietro ────
async function salvarDevolucao(){
  const id         = document.getElementById('md-id').value.trim();
  const codigo     = document.getElementById('md-codigo').value.trim();
  const nome       = document.getElementById('md-nome').value.trim();
  const selb       = document.getElementById('md-selb').value.trim();
  const motivo     = document.getElementById('md-motivo').value.trim();
  const quantidade = Math.max(1, parseInt(document.getElementById('md-quantidade').value) || 1);
  const errEl      = document.getElementById('md-err');

  if(!codigo){ errEl.textContent = 'Informe o código da peça.'; document.getElementById('md-codigo').focus(); return; }
  if(!nome)  { errEl.textContent = 'Informe o nome da peça.';   document.getElementById('md-nome').focus();   return; }
  errEl.textContent = '';

  const registradoPor = currentUser?.name || 'Admin';

  try {
    if(id){
      await _db.ref('/devolucoes/'+id).update({ nome, codigo, selb, motivo, quantidade, registradoPor });
    } else {
      await _db.ref('/devolucoes').push({ nome, codigo, selb, motivo, quantidade, registradoPor, registradoEm: Date.now() });
    }
    closeModal('modal-devolucao');
  } catch(e){
    errEl.textContent = 'Erro ao salvar. Tente novamente.';
    console.error('Devolução save error:', e);
  }
}

// ── Remover ──────────────────────────────────────────────────────────────────
async function confirmarRemoverDevolucao(id, nome){
  if(!confirm(`Remover o registro de devolução da peça "${nome}"?\n\nEsta ação não pode ser desfeita.`)) return;
  try {
    await _db.ref('/devolucoes/'+id).remove();
  } catch(e){
    alert('Erro ao remover registro.');
    console.error('Devolução remove error:', e);
  }
}

// ════════════════════════════════════════════
// MÁQUINAS PERDIDAS
// Armazenado em /maquinas_perdidas/{id} no Firebase
// Campos: selb, equipamento, setor, observacao, registradoPor, registradoEm, status ('perdida'|'encontrada')
// ════════════════════════════════════════════
let _maquinasPerdidas = {}; // cache local { id: {...} }
let _maquinaPerdidaliberandoId = null; // id da máquina sendo liberada pelo admin
let _maquinaPerdidaliberandoUid = null; // uid do usuário que tentou iniciar

// ── Listener Firebase para /maquinas_perdidas ──────────────────────────────
function startMaquinasPerdidasListener(){
  if(!_db) return;
  _db.ref('/maquinas_perdidas').on('value', snap => {
    _maquinasPerdidas = snap.val() || {};
    // Atualiza view se estiver ativa
    if(document.getElementById('view-perdidas')?.classList.contains('active')){
      renderPerdidasView();
    }
  });
}

// ── Abre modal para registrar nova máquina perdida (somente admin) ─────────
// ── Registrar equipamento da aba Equipamentos como Perdida ────────────────
function registrarEquipamentoPerdido(selb, nomeEquip){
  if(!currentUser || !currentUser.isAdmin){ alert('Apenas admins podem registrar máquinas perdidas.'); return; }
  // Pré-preenche os campos do modal
  document.getElementById('mperd-selb').value  = selb;
  document.getElementById('mperd-equip').value = nomeEquip || '';
  document.getElementById('mperd-setor').value = '';
  document.getElementById('mperd-obs').value   = '';
  document.getElementById('mperd-err').textContent = '';
  document.getElementById('modal-add-perdida').classList.remove('hidden');
  setTimeout(() => document.getElementById('mperd-obs').focus(), 100);
}

function abrirModalAdicionarPerdida(){
  if(!currentUser || !currentUser.isAdmin){ alert('Apenas admins podem registrar máquinas perdidas.'); return; }
  document.getElementById('mperd-selb').value = '';
  document.getElementById('mperd-equip').value = '';
  document.getElementById('mperd-setor').value = '';
  document.getElementById('mperd-obs').value = '';
  document.getElementById('mperd-err').textContent = '';
  document.getElementById('modal-add-perdida').classList.remove('hidden');
  setTimeout(() => document.getElementById('mperd-selb').focus(), 100);
}

// ── Salva máquina perdida no Firebase ─────────────────────────────────────
async function salvarMaquinaPerdida(){
  const selb  = document.getElementById('mperd-selb').value.trim().toUpperCase();
  const equip = document.getElementById('mperd-equip').value.trim();
  const setor = document.getElementById('mperd-setor').value;
  const obs   = document.getElementById('mperd-obs').value.trim();
  const errEl = document.getElementById('mperd-err');

  if(!selb){ errEl.textContent = 'Informe o SELB / código da máquina.'; return; }
  errEl.textContent = '';

  // Verifica duplicata
  const existente = Object.values(_maquinasPerdidas).find(m => m.selb === selb && m.status === 'perdida');
  if(existente){ errEl.textContent = 'Esta máquina já está registrada como perdida.'; return; }

  const id = 'perd_' + Date.now();
  const registro = {
    selb,
    equipamento: equip || '—',
    setor: setor || '—',
    observacao: obs || '',
    registradoPor: currentUser.name || 'Admin',
    registradoEm: new Date().toISOString(),
    status: 'perdida'
  };

  try {
    await dbSet('/maquinas_perdidas/' + id, registro);
    _maquinasPerdidas[id] = registro;
    closeModal('modal-add-perdida');
    renderPerdidasView();
  } catch(e){
    errEl.textContent = 'Erro ao salvar: ' + e.message;
  }
}

// ── Renderiza a aba de máquinas perdidas ──────────────────────────────────
function renderPerdidasView(){
  const tbody  = document.getElementById('perdidas-body');
  const kpiEl  = document.getElementById('perdidas-kpi');
  const isAdmin = currentUser && currentUser.isAdmin;

  // Mostra/oculta botão de registrar
  const btnAdd = document.getElementById('btn-add-perdida');
  if(btnAdd) btnAdd.style.display = isAdmin ? '' : 'none';

  const q = (document.getElementById('perdidas-search')?.value || '').toUpperCase().trim();

  // Filtra apenas as perdidas (status === 'perdida')
  const todas = Object.entries(_maquinasPerdidas)
    .filter(([,m]) => m.status === 'perdida')
    .map(([id, m]) => ({ id, ...m }));

  const filtradas = q
    ? todas.filter(m => m.selb.includes(q) || (m.equipamento||'').toUpperCase().includes(q))
    : todas;

  // KPIs
  if(kpiEl){
    const totalPerms = todas.length;
    const setores = [...new Set(todas.map(m => m.setor).filter(s => s && s !== '—'))];
    const maisAntiga = todas.sort((a,b) => new Date(a.registradoEm) - new Date(b.registradoEm))[0];
    const diasPerdida = maisAntiga
      ? Math.floor((Date.now() - new Date(maisAntiga.registradoEm).getTime()) / 86400000)
      : 0;

    kpiEl.innerHTML = `
      <div class="sum-card" style="border-color:rgba(242,87,87,.2)">
        <div class="sum-card::before" style="background:var(--danger)"></div>
        <div class="slbl">Total Perdidas</div>
        <div class="sval" style="color:var(--danger)">${totalPerms}</div>
      </div>
      <div class="sum-card" style="border-color:rgba(245,166,35,.2)">
        <div class="slbl">Setores Afetados</div>
        <div class="sval" style="color:var(--warn)">${setores.length || 0}</div>
      </div>
      <div class="sum-card" style="border-color:rgba(167,139,250,.2)">
        <div class="slbl">Mais antiga (dias)</div>
        <div class="sval" style="color:var(--purple)">${totalPerms ? diasPerdida + 'd' : '—'}</div>
      </div>`;
  }

  if(!filtradas.length){
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${
      q ? 'Nenhuma máquina encontrada para a busca.' : '✅ Nenhuma máquina perdida registrada.'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = filtradas.map(m => {
    const dt = new Date(m.registradoEm);
    const dataStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});

    const acoesHtml = isAdmin
      ? `<button onclick="admRemoverPerdida('${m.id}')" style="background:rgba(61,214,140,.12);border:1px solid rgba(61,214,140,.3);border-radius:8px;color:var(--accent2);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap">✅ Encontrada</button>
         <button onclick="admExcluirPerdida('${m.id}','${m.selb}')" style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.3);border-radius:8px;color:var(--danger);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap;margin-top:4px">🗑️ Excluir</button>`
      : `<span style="font-size:11px;color:var(--muted)">Somente Admin</span>`;

    return `<tr>
      <td style="font-family:var(--mono);font-weight:700;color:var(--danger)">${m.selb}</td>
      <td style="font-size:12px;color:var(--muted)">${m.equipamento || '—'}</td>
      <td><span class="stag stag-${sc(m.setor)}">${m.setor || '—'}</span></td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${dataStr}</td>
      <td style="font-size:12px">${m.registradoPor || '—'}</td>
      <td style="font-size:11px;color:var(--muted);max-width:200px;white-space:normal">${m.observacao || '—'}</td>
      <td><div style="display:flex;flex-direction:column;gap:4px">${acoesHtml}</div></td>
    </tr>`;
  }).join('');
}

// ── Admin marca como encontrada (libera da lista) ─────────────────────────
async function admRemoverPerdida(id){
  if(!currentUser || !currentUser.isAdmin){ alert('Apenas admins podem liberar máquinas.'); return; }
  if(!confirm('Confirma que a máquina foi encontrada? Ela sairá da lista de perdidas.')) return;
  try {
    await dbPatch('/maquinas_perdidas/' + id, { status: 'encontrada' });
    if(_maquinasPerdidas[id]) _maquinasPerdidas[id].status = 'encontrada';
    renderPerdidasView();
  } catch(e){ alert('Erro ao atualizar: ' + e.message); }
}

// ── Admin exclui o registro permanentemente ───────────────────────────────
async function admExcluirPerdida(id, selb){
  if(!currentUser || !currentUser.isAdmin){ return; }
  if(!confirm('Excluir permanentemente o registro de "' + selb + '"?')) return;
  try {
    await dbDelete('/maquinas_perdidas/' + id);
    delete _maquinasPerdidas[id];
    renderPerdidasView();
  } catch(e){ alert('Erro ao excluir: ' + e.message); }
}

// ── Verifica se o SELB sendo iniciado é uma máquina perdida ───────────────
// Chamado antes de abrir o modal de iniciar SELB. Retorna true se bloqueado.
function verificarMaquinaPerdida(selb, uid){
  if(!selb) return false;
  const sStr = selb.trim().toUpperCase();
  const perdida = Object.entries(_maquinasPerdidas).find(
    ([, m]) => m.status === 'perdida' && m.selb.toUpperCase() === sStr
  );
  if(!perdida) return false;

  const [perdId, perdData] = perdida;

  // Mostra alerta de máquina encontrada
  document.getElementById('mencon-sub').textContent =
    `O SELB ${selb} foi localizado! Estava registrado como perdido.`;
  document.getElementById('mencon-info').innerHTML = `
    <b>Equipamento:</b> ${perdData.equipamento || '—'}<br>
    <b>Setor:</b> ${perdData.setor || '—'}<br>
    <b>Registrado por:</b> ${perdData.registradoPor || '—'}<br>
    <b>Observação:</b> ${perdData.observacao || '—'}<br>
    <b>Em:</b> ${new Date(perdData.registradoEm).toLocaleString('pt-BR')}`;

  // Botão de liberação apenas para admin
  const btnLib = document.getElementById('btn-liberar-perdida');
  if(currentUser && currentUser.isAdmin){
    btnLib.style.display = '';
    _maquinaPerdidaliberandoId  = perdId;
    _maquinaPerdidaliberandoUid = uid;
  } else {
    btnLib.style.display = 'none';
  }

  document.getElementById('modal-maquina-encontrada').classList.remove('hidden');

  // Toca alerta sonoro
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    [440, 550, 660].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime + i*0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + i*0.15 + 0.25);
      osc.start(audioCtx.currentTime + i*0.15);
      osc.stop(audioCtx.currentTime + i*0.15 + 0.25);
    });
  } catch(e){}

  return true; // bloqueado — não abre modal de SELB
}

// ── Admin confirma: libera a máquina e continua com o SELB ───────────────
async function admLiberarMaquinaEncontrada(){
  if(!currentUser || !currentUser.isAdmin || !_maquinaPerdidaliberandoId){ return; }
  try {
    await dbPatch('/maquinas_perdidas/' + _maquinaPerdidaliberandoId, { status: 'encontrada' });
    if(_maquinasPerdidas[_maquinaPerdidaliberandoId])
      _maquinasPerdidas[_maquinaPerdidaliberandoId].status = 'encontrada';
    closeModal('modal-maquina-encontrada');
    // Continua para abrir o modal de SELB normalmente
    if(_maquinaPerdidaliberandoUid) openSelb(_maquinaPerdidaliberandoUid);
    _maquinaPerdidaliberandoId  = null;
    _maquinaPerdidaliberandoUid = null;
    renderPerdidasView();
  } catch(e){ alert('Erro ao liberar máquina: ' + e.message); }
}





function setCFilter(f,btn){
  cFilter=f;
  document.getElementById('cons-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f?'a-'+sc(f):'a-all');
  renderConsulta();
}

function renderConsulta(){
  const src = _consultaRecords;
  const q = (document.getElementById('search-q').value||'').toUpperCase();
  const tbody = document.getElementById('consulta-body');

  const isAdmin = currentUser && currentUser.isAdmin;
  const podeReprovar = currentUser && (isAdmin || (!currentUser.isAdmin && currentUser.sector==='QUALIDADE'));

  // Visibilidade das colunas extras
  const thAcao = document.getElementById('consulta-th-acao');
  const thEdit = document.getElementById('consulta-th-edit');
  const thReprovador = document.getElementById('consulta-th-reprovador');
  const temReprovados = src.some(h => h.status === 'rep' && h._reprovadoPor);
  if(thAcao) thAcao.style.display = podeReprovar ? '' : 'none';
  if(thEdit) thEdit.style.display = isAdmin ? '' : 'none';
  if(thReprovador) thReprovador.style.display = (temReprovados || isAdmin) ? '' : 'none';

  const fl = src.filter(h=>{
    if(h.status==='closed_stale') return false;
    const mq=!q||h.selb.includes(q)||h.name.toUpperCase().includes(q)||h.pin.includes(q)||(h.local||'').toUpperCase().includes(q)||(h.code||'').toUpperCase().includes(q);
    return mq&&(!cFilter||h.sector===cFilter);
  });

  const extraCols = (podeReprovar ? 1 : 0) + (isAdmin ? 1 : 0) + ((temReprovados || isAdmin) ? 1 : 0);
  const colspan = 12 + extraCols;
  if(!fl.length){ tbody.innerHTML=`<tr><td colspan="${colspan}" class="empty">Nenhum registro encontrado.</td></tr>`; return; }

  const bm={ok:'bok',rep:'brep',running:'brun',scrap:'bscr',aguardando:'bpec',cancelado:'brep',closed_stale:'brun'};
  const lm={ok:'Aprovado',rep:'Reprovado',running:'Em andamento',scrap:'SCRAP',aguardando:'Aguardando Peça',cancelado:'Cancelado',closed_stale:'—'};

  tbody.innerHTML=[...fl].map(h=>{
    // Coluna Ação (reprovar) — admin e qualidade
    let acaoTd = '';
    if(podeReprovar){
      const setorReprovavel = h.sector==='MONTAGEM'||h.sector==='LIMPEZA'||h.sector==='COMPLEXA'||h.sector==='ELETRÔNICA';
      if(h.status==='ok' && setorReprovavel){
        const jaReprovado = src.some(r => r.status==='rep' && r._reprovadoDe===h._docId);
        acaoTd = jaReprovado
          ? `<td><span style="font-size:11px;color:var(--danger);font-weight:600">&#x2715; Reprovado</span></td>`
          : `<td><button class="btn bd" style="font-size:11px;padding:5px 10px;white-space:nowrap"
               onclick="abrirReprovacao('${h._docId}','${h._dateKey||_consultaDateKey}','${h.selb}','${h.name}','${h.sector}')">
               &#x26A0;&#xFE0F; Reprovar</button></td>`;
      } else {
        acaoTd = `<td style="color:var(--muted);font-size:11px">—</td>`;
      }
    }

    // Coluna Editar — só admin (todos os registros finalizados + em andamento)
    let editTd = '';
    if(isAdmin){
      const editavel = h.status!=='closed_stale';
      editTd = editavel
        ? `<td><button onclick="abrirEdicaoStatus('${h._docId}','${h._dateKey||_consultaDateKey}')"
             style="background:rgba(79,142,247,.08);border:1px solid rgba(79,142,247,.25);border-radius:7px;color:var(--accent);
                    font-family:var(--font);font-size:11px;padding:4px 9px;cursor:pointer;transition:all .15s"
             onmouseover="this.style.background='rgba(79,142,247,.18)'"
             onmouseout="this.style.background='rgba(79,142,247,.08)'"
             title="Editar registro">✏️</button></td>`
        : `<td></td>`;
    }

    return `<tr>
    <td style="font-family:var(--mono);font-weight:500;color:var(--accent)">${h.selb||'—'}</td>
    <td>${h.name||'—'}</td>
    <td><span class="pinbadge">${h.pin||'—'}</span></td>
    <td style="font-size:11px;color:var(--muted);max-width:180px;white-space:normal">${h.equipamento||'—'}</td>
    <td style="font-size:11px;color:var(--muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;text-decoration:underline;text-underline-offset:3px" 
        title="Clique para ver o acompanhamento completo"
        onclick="openFollowupDetails('${h.uid}','${h.selb}','${(h.name||'').replace(/'/g,"\\'")}', '${h.sector}', \`${(h.followup||'').replace(/`/g,"\\`").replace(/\$/g,"\\$")}\`)">
        ${h.followup||'—'}
    </td>
    <td><span class="stag stag-${sc(h.sector)}">${h.sector||'—'}</span></td>
    <td style="color:var(--muted);font-size:11px;white-space:nowrap">${(()=>{ const dk=h._dateKey||''; const d=dk?new Date(dk.replace(/_/g,' ')):null; const ds=d&&!isNaN(d)?d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}):''; return (ds?`<span style="font-size:10px;opacity:.7;margin-right:4px">${ds}</span>`:'')+`<span>${h.start||'—'}</span>`; })()}</td>
    <td style="color:var(--muted);font-size:11px;white-space:nowrap">${(()=>{
      if(!h.end) return '—';
      const endDk = h.endDateKey || (h.endEpoch ? new Date(h.endEpoch).toDateString().replace(/ /g,'_') : null);
      if(endDk && endDk !== h._dateKey){
        const d = new Date(endDk.replace(/_/g,' '));
        const ds = !isNaN(d) ? d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}) : '';
        return `<span style="font-size:10px;opacity:.7;margin-right:3px">${ds}</span><span>${h.end}</span>`;
      }
      return h.end;
    })()}</td>
    <td style="font-family:var(--mono);font-size:11px">${calcDuracaoExibir(h)}</td>
    <td><span class="badge ${bm[h.status]||'brun'}">${lm[h.status]||h.status||'—'}</span></td>
    <td style="font-size:11px;color:var(--danger);max-width:150px;white-space:normal">${h.motivo||'—'}</td>
    <td style="font-family:var(--mono);font-size:11px;color:var(--elet)">${h.osNum||'—'}</td>
    <td style="font-size:11px;color:var(--muted);max-width:160px;white-space:normal">
      ${h.comentario||'—'}
      ${(()=>{
        const pcs = Object.values(_solicitacoesPecas).filter(p => p.selb === h.selb && p.ts >= (h.startEpoch||0) && p.ts <= (h.endEpoch || Date.now() + 86400000));
        if(!pcs.length) return '';
        return `<div style="margin-top:6px;border-top:1px dashed rgba(255,255,255,0.1);padding-top:4px">
          <b style="color:var(--warn);font-size:9px;text-transform:uppercase">Peças:</b><br>
          ${pcs.map(p => `<span style="font-size:10px;color:var(--text)">• ${p.peca} (x${p.quantidade})</span>`).join('<br>')}
        </div>`;
      })()}
    </td>
    ${(temReprovados || isAdmin) ? `<td style="font-size:11px;white-space:nowrap">${
      h.status === 'rep' && h._reprovadoPor
        ? `<span style="color:#f87171;font-weight:600">✗ ${h._reprovadoPor}</span>`
        : '<span style="color:var(--muted)">—</span>'
    }</td>` : ''}
    ${acaoTd}${editTd}
  </tr>`;
  }).join('');
}

// ════ QUALIDADE ════
let qualFilter = '';
let reprovandoDocId = null;

function setQualFilter(f, btn){
  qualFilter = f;
  document.getElementById('qual-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f ? 'a-'+sc(f) : 'a-all');
  renderQualidade();
}

let _qualRecords = [];
let _qualDateKey = null;

function _initQualDateSelect(){
  const sel = document.getElementById('qual-date');
  if(!sel || sel.options.length > 0) return;
  const today = new Date();
  for(let i = 0; i < 30; i++){
    const d = new Date(today); d.setDate(today.getDate() - i);
    const dk  = d.toDateString().replace(/ /g,'_');
    const lbl = i===0 ? 'Hoje — '+d.toLocaleDateString('pt-BR')
              : i===1 ? 'Ontem — '+d.toLocaleDateString('pt-BR')
              : d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'});
    const opt = document.createElement('option');
    opt.value = dk; opt.textContent = lbl;
    sel.appendChild(opt);
  }
}

async function loadQualDate(){
  const sel = document.getElementById('qual-date');
  const dk  = sel.value;
  const todayDk = new Date().toDateString().replace(/ /g,'_');
  _qualDateKey = dk;
  if(dk === todayDk){
    _qualRecords = history;
    renderQualidade();
    return;
  }
  document.getElementById('qual-loading').style.display = 'block';
  document.getElementById('qual-body').innerHTML = '';
  try {
    const data = await dbGet('/history/'+dk);
    _qualRecords = data
      ? Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}))
      : [];
  } catch(e){ _qualRecords = []; }
  document.getElementById('qual-loading').style.display = 'none';
  renderQualidade();
}

function renderQualidade(){
  const q      = (document.getElementById('qual-search').value||'').toUpperCase();
  const tbody  = document.getElementById('qual-body');
  const src    = (_qualRecords && _qualDateKey) ? _qualRecords : history;

  // Mostra SELBs aprovados (ok) de MONTAGEM e LIMPEZA
  const fl = src.filter(h => {
    if(h.status !== 'ok') return false;
    if(h.sector !== 'MONTAGEM' && h.sector !== 'LIMPEZA') return false;
    if(qualFilter && h.sector !== qualFilter) return false;
    if(q && !h.selb.includes(q) && !h.name.toUpperCase().includes(q) && !(h.pin||'').includes(q)) return false;
    return true;
  });

  const repCount = src.filter(h => h.status==='rep' && (h.sector==='MONTAGEM'||h.sector==='LIMPEZA')).length;
  document.getElementById('qual-stats').innerHTML = `
    <div class="sum-card" style="min-width:120px">
      <div class="slbl">Aprovados visíveis</div>
      <div class="sval" style="color:var(--accent2);font-size:18px">${fl.length}</div>
    </div>
    <div class="sum-card" style="min-width:120px">
      <div class="slbl">Reprovados</div>
      <div class="sval" style="color:var(--danger);font-size:18px">${repCount}</div>
    </div>`;

  if(!fl.length){
    tbody.innerHTML=`<tr><td colspan="9" class="empty">Nenhum SELB aprovado encontrado.</td></tr>`;
    return;
  }

  tbody.innerHTML = fl.map(h => {
    const jaReprovado = src.some(r => r.status==='rep' && r._reprovadoDe===h._docId);
    return `<tr>
      <td style="font-family:var(--mono);font-weight:500;color:var(--accent)">${h.selb}</td>
      <td style="font-size:11px;color:var(--muted)">${h.equipamento||'—'}</td>
      <td style="font-size:11px;color:var(--muted);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;text-decoration:underline;text-underline-offset:3px" 
          title="Clique para ver o acompanhamento completo"
          onclick="openFollowupDetails('${h.uid}','${h.selb}','${(h.name||'').replace(/'/g,"\\'")}', '${h.sector}', \`${(h.followup||'').replace(/`/g,"\\`").replace(/\$/g,"\\$")}\`)">
          ${h.followup||'—'}
      </td>
      <td style="font-weight:500">${h.name}</td>
      <td><span class="stag stag-${sc(h.sector)}">${h.sector}</span></td>
      <td style="color:var(--muted);font-size:11px">${h.start||'—'}</td>
      <td style="color:var(--muted);font-size:11px">${h.end||'—'}</td>
      <td style="font-family:var(--mono);font-size:11px">${calcDuracaoExibir(h)}</td>
      <td><span class="badge bok">Aprovado</span></td>
      <td>
        ${jaReprovado
          ? `<span style="font-size:11px;color:var(--danger);font-weight:600">✗ Reprovado</span>`
          : `<button class="btn bd" style="font-size:11px;padding:5px 10px;white-space:nowrap"
               onclick="abrirReprovacao('${h._docId}','${h._dateKey||_qualDateKey}','${h.selb}','${h.name}','${h.sector}')">
               ⚠️ Reprovar
             </button>`
        }
      </td>
    </tr>`;
  }).join('');
}

function abrirReprovacao(docId, dateKey, selb, nome, setor){
  reprovandoDocId  = docId;
  document.getElementById('mrep-sub').textContent = `SELB: ${selb} — ${nome} (${setor})`;
  document.getElementById('mrep-motivo').value    = '';
  document.getElementById('mrep-err').textContent = '';
  document.getElementById('modal-reprovar').classList.remove('hidden');
  setTimeout(()=>document.getElementById('mrep-motivo').focus(), 100);
}

async function confirmarReprovacao(){
  const motivo = document.getElementById('mrep-motivo').value.trim();
  const errEl  = document.getElementById('mrep-err');
  if(!motivo){ errEl.textContent='Informe o motivo da reprovação.'; return; }

  // Busca o registro original — primeiro em _consultaRecords, fallback em history
  const orig = _consultaRecords.find(h => h._docId === reprovandoDocId)
            || history.find(h => h._docId === reprovandoDocId);
  if(!orig){ errEl.textContent='Registro não encontrado.'; return; }

  const btn = document.querySelector('#modal-reprovar .btn.bd');
  btn.textContent = 'Salvando…'; btn.disabled = true;

  try {
    const now = new Date();
    const endTime = now.toLocaleTimeString('pt-BR');

    // 1. Cria novo registro de reprovação vinculado ao profissional original
    const repRec = {
      selb:          orig.selb,
      uid:           orig.uid,
      name:          orig.name,
      pin:           orig.pin,
      code:          orig.code  || '',
      local:         orig.local || '',
      sector:        orig.sector,
      start:         orig.start,
      end:           endTime,
      duracao:       orig.duracao || '—',
      status:        'rep',
      motivo:        motivo,
      equipamento:   orig.equipamento || '',
      startEpoch:    orig.startEpoch  || Date.now(),
      _reprovadoDe:     reprovandoDocId,
      _reprovadoPor:    currentUser.name,
      _reprovadoPorUid: currentUser.id || currentUser.uid || '',   // uid de quem reprovou
      _reprovadoEm:     endTime,
      _reprovadoUid:    orig.uid,       // uid do operador original — para vincular retrabalho
      _aguardandoRetrabalho: true     // flag: ainda não houve retrabalho
    };
    const { key, dateKey } = await dbAddHistory(repRec);
    history.unshift({...repRec, _docId:key, _dateKey:dateKey});

    // FluxoLAB: ao reprovar, devolve o SELB ao bolsão do setor original (Limpeza / Montagem / Complexa)
    try {
      const destBolsao = FLUXOLAB_SECTOR_BOLSAO[orig.sector];
      if(destBolsao && typeof fluxolabRemoveSelbGlobal === 'function'){
        const bolsaoAnterior = (typeof _fmovGetBolsaoAtual === 'function') ? (_fmovGetBolsaoAtual(orig.selb) || '—') : '—';
        await fluxolabRemoveSelbGlobal(orig.selb);
        const selfKey = orig.selb.replace(/[^a-zA-Z0-9_-]/g, '_');
        const equipNome = (typeof getEquipName === 'function' ? getEquipName(orig.selb) : '') || orig.equipamento || '';
        await dbSet('/fluxolab/' + destBolsao + '/' + selfKey, {
          selb:        orig.selb,
          uid:         orig.uid || '',
          userName:    orig.name || '',
          sector:      orig.sector,
          equipamento: equipNome,
          ts:          Date.now(),
          reprovado:   true,
          motivoRep:   motivo
        });
        if(typeof _fluxolabLogEntry === 'function'){
          _fluxolabLogEntry(orig.selb, bolsaoAnterior, destBolsao, equipNome);
        }
      }
    } catch(e){ console.warn('[FluxoLAB] Erro ao mover SELB reprovado:', e); }


    // 2. Incrementa repDia do profissional original no Firebase
    const profUser = users.find(u => u.id === orig.uid);
    if(profUser){
      profUser.repDia = (profUser.repDia || 0) + 1;
      profUser._localRepDia = profUser.repDia;
      await dbPatch('/users/'+profUser.id, { repDia: profUser.repDia });
    }

    // Atualiza _consultaRecords para refletir a reprovacao imediatamente
    const fullRepRec = {...repRec, _docId:key, _dateKey:dateKey};
    _consultaRecords = [fullRepRec, ..._consultaRecords.filter(r=>r._docId!==key)];

    closeModal('modal-reprovar');
    renderConsulta();
    renderQualidade();
  } catch(e){
    errEl.textContent = 'Erro ao salvar: ' + e.message;
  } finally {
    btn.textContent = 'Confirmar Reprovação'; btn.disabled = false;
  }
}

// ════ EDITAR REGISTRO SELB COMPLETO (admin only) ════
let _editDocId   = null;
let _editDateKey = null;
let _editStatus  = null;

function abrirEdicaoStatus(docId, dateKey){
  if(!currentUser || !currentUser.isAdmin) return;
  _editDocId   = docId;
  _editDateKey = dateKey;

  // Busca o registro nos caches disponíveis
  const rec = _consultaRecords.find(r => r._docId === docId)
           || history.find(r => r._docId === docId);

  _editStatus = rec ? rec.status : 'ok';

  // Cabeçalho
  document.getElementById('medit-sub').textContent =
    rec ? `SELB: ${rec.selb||'—'} — ${rec.name||'—'} · ${rec.sector||''}` : `ID: ${docId}`;

  // Preenche todos os campos
  document.getElementById('medit-selb').value      = rec?.selb      || '';
  document.getElementById('medit-equip').value     = rec?.equipamento|| '';
  document.getElementById('medit-local').value     = rec?.local      || '';
  document.getElementById('medit-os').value        = rec?.osNum      || '';
  document.getElementById('medit-start').value     = rec?.start      || '';
  document.getElementById('medit-end').value       = rec?.end        || '';
  document.getElementById('medit-duracao').value   = rec?.duracao    || '';
  document.getElementById('medit-motivo').value    = rec?.motivo     || '';
  document.getElementById('medit-comentario').value= rec?.comentario || '';

  const sel = document.getElementById('medit-status');
  sel.value = _editStatus || 'ok';

  document.getElementById('medit-err').textContent = '';
  toggleEditMotivo();
  document.getElementById('modal-edit-status').classList.remove('hidden');
}

function toggleEditMotivo(){
  const status = document.getElementById('medit-status').value;
  const wrap   = document.getElementById('medit-motivo-wrap');
  wrap.style.display = 'block';
  document.querySelector('#medit-motivo-wrap .flbl').textContent =
    status === 'rep' ? 'Motivo da reprovação *' : 'Motivo / Observação (opcional)';
}

async function confirmarEdicaoStatus(){
  if(!currentUser || !currentUser.isAdmin) return;

  const novoStatus  = document.getElementById('medit-status').value;
  const novoSelb    = document.getElementById('medit-selb').value.trim().toUpperCase();
  const novoEquip   = document.getElementById('medit-equip').value.trim();
  const novoLocal   = document.getElementById('medit-local').value.trim();
  const novoOs      = document.getElementById('medit-os').value.trim();
  const novoStart   = document.getElementById('medit-start').value.trim();
  const novoEnd     = document.getElementById('medit-end').value.trim();
  const novoDuracao = document.getElementById('medit-duracao').value.trim();
  const motivo      = document.getElementById('medit-motivo').value.trim();
  const comentario  = document.getElementById('medit-comentario').value.trim();
  const errEl       = document.getElementById('medit-err');

  if(novoStatus === 'rep' && !motivo){
    errEl.textContent = 'Informe o motivo da reprovação.'; return;
  }
  if(!novoSelb){ errEl.textContent = 'O código SELB não pode ficar vazio.'; return; }

  const btn = document.querySelector('#modal-edit-status .btn.bp');
  btn.textContent = 'Salvando…'; btn.disabled = true;
  errEl.textContent = '';

  const patch = {
    selb:       novoSelb,
    equipamento:novoEquip,
    local:      novoLocal,
    osNum:      novoOs,
    start:      novoStart,
    end:        novoEnd || null,
    duracao:    novoDuracao || null,
    status:     novoStatus,
    motivo:     motivo  || '',
    comentario: comentario || '',
    _editadoPor:currentUser.name,
    _editadoEm: new Date().toLocaleTimeString('pt-BR')
  };

  let logMovimentacao = null;
  const originalRec = _consultaRecords.find(r => r._docId === _editDocId) || history.find(r => r._docId === _editDocId);
  const setorRec = originalRec ? originalRec.sector : '—';

  if (novoStatus === 'maquina_a') {
    patch.status = 'ok'; // Mantém histórico como 'ok' para as métricas normais
    patch.motivo = patch.motivo || 'Enviado para Máquinas A via Consulta';
    const newId = 'ma_' + Date.now();
    const registro = {
      selb: novoSelb,
      equipamento: novoEquip,
      setor: setorRec,
      registradoPor: currentUser.name,
      registradoEm: new Date().toISOString(),
      observacao: patch.motivo,
      status: 'ativa'
    };
    try {
      await dbPatch('/maquinas_a/' + newId, registro);
      _maquinasA[newId] = registro;
      logMovimentacao = 'Enviado para Máquinas A via Edição de Status';
      // Remove o SELB de todos os bolsões do FluxoLAB ao entrar em Máquinas A
      if (typeof fluxolabRemoveSelbGlobal === 'function') {
        fluxolabRemoveSelbGlobal(novoSelb).catch(e => console.warn('[MáquinasA] Erro ao remover do FluxoLAB:', e));
      }
    } catch(e){}
  } else if (novoStatus === 'aguardando' && _editStatus !== 'aguardando') {
    logMovimentacao = 'Alterado para Aguardando Peças via Edição de Status';
    if (typeof fluxolabFinalizarSelb === 'function') {
      fluxolabFinalizarSelb(novoSelb, setorRec, 'aguardando').catch(e =>
        console.warn('[FluxoLAB] Erro ao mover para Gaiola Ag. peças:', e));
    }
  }

  try {
    await dbUpdateHistory(_editDocId, _editDateKey, patch);

    // Atualiza _consultaRecords
    const recIdx = _consultaRecords.findIndex(r => r._docId === _editDocId);
    if(recIdx !== -1){
      _consultaRecords[recIdx] = { ..._consultaRecords[recIdx], ...patch };
    }
    // Atualiza history[]
    const hIdx = history.findIndex(r => r._docId === _editDocId);
    if(hIdx !== -1){
      history[hIdx] = { ...history[hIdx], ...patch };
    }

    // Ajusta repDia se mudou de/para rep/scrap
    const rec = _consultaRecords[recIdx] || history[hIdx];
    if(rec){
      const profUser = users.find(u => u.id === rec.uid);
      if(profUser){
        const eraRep   = _editStatus === 'rep' || _editStatus === 'scrap';
        const agoraRep = novoStatus  === 'rep' || novoStatus  === 'scrap';
        if(eraRep && !agoraRep){
          profUser.repDia = Math.max(0, (profUser.repDia||0) - 1);
          await dbPatch('/users/'+profUser.id, { repDia: profUser.repDia }).catch(()=>{});
        } else if(!eraRep && agoraRep){
          profUser.repDia = (profUser.repDia||0) + 1;
          await dbPatch('/users/'+profUser.id, { repDia: profUser.repDia }).catch(()=>{});
        }
        profUser._localRepDia = profUser.repDia;
      }
    }

    if(logMovimentacao){
      registrarLogPecas(novoSelb, novoEquip, logMovimentacao);
    }

    closeModal('modal-edit-status');
    renderConsulta();
    updateSummary();

    // ── Redireciona para a aba correspondente ao novo status ──
    const destinos = {
      'aguardando': { tab: 'pecas',       render: renderPecasView      },
      'maquina_a':  { tab: 'maquinas-a',  render: renderMaquinasAView  },
      'scrap':      { tab: 'consulta',    render: renderConsulta       },
      'rep':        { tab: 'consulta',    render: renderConsulta       },
      'cancelado':  { tab: 'consulta',    render: renderConsulta       },
    };
    const destino = destinos[novoStatus];
    if(destino && novoStatus !== _editStatus){
      const tabBtn = document.getElementById('tab-' + destino.tab);
      if(tabBtn){
        setView(destino.tab, tabBtn);
        if(typeof destino.render === 'function') destino.render();
      }
    }

  } catch(e){
    errEl.textContent = 'Erro ao salvar: ' + e.message;
  } finally {
    btn.textContent = '💾 Salvar alterações'; btn.disabled = false;
  }
}

// ════ COPIAR SELBs ════
function copiarSelbs(){
  const q=(document.getElementById('search-q').value||'').toUpperCase();
  const src = (_consultaRecords && _consultaRecords.length > 0) ? _consultaRecords : history;
  const fl=src.filter(h=>{
    if(h.status==='closed_stale') return false;
    const mq=!q||h.selb.includes(q)||h.name.toUpperCase().includes(q)||h.pin.includes(q)||(h.local||'').toUpperCase().includes(q)||(h.code||'').toUpperCase().includes(q);
    return mq&&(!cFilter||h.sector===cFilter);
  });
  // unique SELBs preserving order
  const selbs=[...new Set([...fl].reverse().map(h=>h.selb))];
  if(!selbs.length){ alert('Nenhum SELB para copiar.'); return; }
  navigator.clipboard.writeText(selbs.join('\n')).then(()=>{
    const btn=document.getElementById('copy-selbs-btn');
    const orig=btn.innerHTML;
    btn.innerHTML='✅ Copiado! ('+selbs.length+')';
    btn.style.borderColor='var(--accent2)';
    btn.style.color='var(--accent2)';
    setTimeout(()=>{ btn.innerHTML=orig; btn.style.borderColor='var(--border2)'; btn.style.color='var(--muted)'; },2000);
  }).catch(()=>{
    // fallback for older browsers
    const ta=document.createElement('textarea');
    ta.value=selbs.join('\n');
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    alert('✅ '+selbs.length+' SELBs copiados!');
  });
}

// ════ ADMIN ════
function setAdmFilter(f,btn){
  admFilter=f;
  document.getElementById('adm-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f?'a-'+sc(f):'a-all');
  renderUsers();
}
function renderUsers(){
  const list=admFilter?users.filter(u=>u.sector===admFilter):users;
  document.getElementById('users-body').innerHTML=list.map(u=>{
    const s = getS(u.id);
    const busy = s.status === 'running' || s.status === 'paused';
    const elapsedNow = busy ? fmt(calcElapsedRunning(u.id)) : null;
    const btnAjuste = busy ? `
      <button class="tbtn" id="adm-elapsed-${u.id}" onclick="abrirAjusteTempo('${u.id}')" style="border-color:var(--warn);color:var(--warn)" title="Editar tempo manualmente">⏱ ${elapsedNow}</button>
      <button class="tbtn" onclick="autoSincronizarTempo('${u.id}', this)" style="border-color:var(--accent2);color:var(--accent2)" title="Recalcular tempo líquido pelo horário de início">↺ Sinc</button>
    ` : '';
    
    const hasFace = !!(u.faceDescriptor || u.face_descriptor || u.faceData || u.faceVector || u.facePrint);
    const faceCell = `<td style="text-align:center">
      <div style="display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap">
        ${hasFace
          ? `<span title="Facial cadastrado" style="color:#22d3ee;font-size:13px;font-weight:700">🟢 Cadastrado</span>`
          : `<span title="Sem facial" style="color:var(--muted);font-size:12px">— Sem facial</span>`}
        <button class="tbtn" onclick="resetFacialUser('${u.id}','${u.name}')" style="border-color:#f25757;color:#f25757;font-size:10px;padding:2px 7px" title="Apagar reconhecimento facial">🗑 Reset</button>
      </div>
    </td>`;
    return `<tr style="${u.hidden?'opacity:0.5':''}">
    <td style="font-weight:500">${u.name}${u.hidden?` <span style="font-size:10px;color:var(--muted);background:var(--bg4);padding:2px 7px;border-radius:6px;margin-left:6px">Oculto</span>`:''}</td>
    <td><span class="pinbadge">${u.pin}</span></td>
    <td style="font-family:var(--mono);font-size:12px;color:var(--muted)">${u.code||'—'}</td>
    <td style="font-size:12px;color:var(--muted)">${u.local||'—'}</td>
    <td><span class="stag stag-${sc(u.sector)}">${u.sector}</span></td>
    <td><span class="schip ${u.active?'con':'coff'}"></span>${u.active?'Ativo':'Inativo'}</td>
    <td style="font-family:var(--mono)">${getTotalDia(u.id)}</td>
    ${faceCell}
    <td><div class="tbl-acts">
      <button class="tbtn adm-edit" data-uid="${u.id}">Editar</button>
      ${btnAjuste}
      <button class="tbtn adm-toggle" data-uid="${u.id}">${u.active?'Desativar':'Ativar'}</button>
      <button class="tbtn adm-hide" data-uid="${u.id}" style="${u.hidden?'border-color:var(--accent);color:var(--accent)':''}">${u.hidden?'Mostrar':'Ocultar'}</button>
      <button class="tbtn del adm-del" data-uid="${u.id}">Remover</button>
    </div></td>
  </tr>`}).join('');
}
function openNewUser(){
  editingId=null;
  document.getElementById('mu-title').textContent='Novo usuário';
  document.getElementById('mu-sub').textContent='Preencha os dados do profissional.';
  ['mu-name','mu-pin','mu-code','mu-local'].forEach(i=>document.getElementById(i).value='');
  _renderMuSectorOpts('MONTAGEM');
  document.getElementById('mu-err').textContent='';
  document.getElementById('modal-user').classList.remove('hidden');
  setTimeout(()=>document.getElementById('mu-name').focus(),100);
}
function openEdit(id){
  editingId=id;
  const u=users.find(x=>x.id===id);
  document.getElementById('mu-title').textContent='Editar usuário';
  document.getElementById('mu-sub').textContent='Editando: '+u.name;
  document.getElementById('mu-name').value=u.name;
  document.getElementById('mu-pin').value=u.pin;
  document.getElementById('mu-code').value=u.code||'';
  document.getElementById('mu-local').value=u.local||'';
  _renderMuSectorOpts(u.sector);
  document.getElementById('mu-err').textContent='';
  document.getElementById('modal-user').classList.remove('hidden');
  setTimeout(()=>document.getElementById('mu-name').focus(),100);
}
async function saveUser(){
  const name=document.getElementById('mu-name').value.trim();
  const pin=document.getElementById('mu-pin').value.trim();
  const code=document.getElementById('mu-code').value.trim();
  const local=document.getElementById('mu-local').value.trim();
  const sector=document.getElementById('mu-sector').value;
  const err=document.getElementById('mu-err');
  if(!name){ err.textContent='Informe o nome.'; return; }
  if(!/^\d{2,5}$/.test(pin)){ err.textContent='PIN deve ter entre 2 e 5 dígitos numéricos.'; return; }
  const dup=users.find(u=>u.pin===pin&&u.id!==editingId);
  if(dup){ err.textContent='PIN '+pin+' já em uso por '+dup.name+'.'; return; }
  try {
    if(editingId){
      const u=users.find(x=>x.id===editingId);
      u.name=name;u.pin=pin;u.code=code;u.local=local;u.sector=sector;
      await dbSaveUser(u);
    } else {
      const newU={name,pin,code,local,sector,active:true,totalDia:0,repDia:0};
      const newId=await dbAddUser(newU);
      users.push({...newU,id:newId});
    }
    closeModal('modal-user'); renderUsers();
    if(editingId){
      renderCard(editingId);
    } else {
      const lastUser = users[users.length-1];
      if(lastUser && lastUser.active && lastUser.sector===activeSector){
        const grid = document.getElementById('cards-grid');
        const d = document.createElement('div'); d.id='card-'+lastUser.id; grid.appendChild(d);
        renderCard(lastUser.id);
      }
    }
    updateSummary();
  } catch(e) {
    err.textContent = 'Erro ao salvar: ' + e.message;
  }
}
async function toggleActive(id){
  const u=users.find(x=>x.id===id); u.active=!u.active;
  if(!u.active&&timers[id]){ clearInterval(timers[id]); getS(id).status='idle'; }
  try { await dbSaveUser(u); } catch(e){ u.active=!u.active; alert('Erro ao salvar: '+e.message); return; }
  renderUsers();
  if(!u.active){
    const card = document.getElementById('card-'+id);
    if(card) card.remove();
  } else {
    if(u.sector===activeSector){
      const grid = document.getElementById('cards-grid');
      if(!document.getElementById('card-'+id)){
        const d = document.createElement('div'); d.id='card-'+id; grid.appendChild(d);
      }
      renderCard(id);
    }
  }
  updateSummary();
}
async function toggleHidden(id){
  const u = users.find(x=>x.id===id);
  if(!u) return;
  u.hidden = !u.hidden;
  try { await dbSaveUser(u); } catch(e){ u.hidden=!u.hidden; alert('Erro ao salvar: '+e.message); return; }
  renderUsers();
  const card = document.getElementById('card-'+id);
  if(u.hidden){
    if(card) card.remove();
  } else {
    if(u.active && u.sector===activeSector && !card){
      const grid = document.getElementById('cards-grid');
      const d = document.createElement('div'); d.id='card-'+id; grid.appendChild(d);
      renderCard(id);
    }
  }
  updateSummary();
}
function openDel(id){
  deletingId=id;
  document.getElementById('mdel-sub').textContent='Remover '+users.find(u=>u.id===id).name+'?';
  document.getElementById('modal-del').classList.remove('hidden');
}
async function confirmDelete(){
  if(timers[deletingId]) clearInterval(timers[deletingId]);
  try {
    await dbDeleteUser(deletingId);
    users=users.filter(u=>u.id!==deletingId); delete wstate[deletingId];
    closeModal('modal-del'); renderUsers(); buildCards();
  } catch(e) {
    alert('Erro ao remover usuário: '+e.message);
  }
}
// ════ AJUSTAR TEMPO (admin tool) ════
let _ajusteUid = null;
let _majTimerInterval = null;

// ── Utilitário: calcula ms de não-expediente/intervalos entre dois timestamps ──
function _calcBreakMsFull(fromMs, toMs){
  if(fromMs >= toMs) return 0;
  let total = 0;
  const dayStart = new Date(fromMs); dayStart.setHours(0,0,0,0);
  const dayEnd   = new Date(toMs);   dayEnd.setHours(0,0,0,0);
  
  for(let d = new Date(dayStart); d <= dayEnd; d.setDate(d.getDate()+1)){
    const baseMs = d.getTime();
    const dayOfWeek = d.getDay(); // 0=Dom, 6=Sab
    
    if(dayOfWeek === 0 || dayOfWeek === 6){
      // Fim de semana: todo o horário de expediente é considerado "break" (não trabalhado)
      const wsMs = baseMs + (SCHEDULE.work.start[0]*3600 + SCHEDULE.work.start[1]*60)*1000;
      const weMs = baseMs + (SCHEDULE.work.end[0]*3600 + SCHEDULE.work.end[1]*60)*1000;
      
      // Fora do expediente (já descontado abaixo pelo pre e pos)
      // Mas no fim de semana, o período de expediente [wsMs, weMs] também deve ser descontado.
      const i_s = Math.max(fromMs, wsMs), i_e = Math.min(toMs, weMs);
      if(i_e > i_s) total += (i_e - i_s);
    } else {
      // Intervalos (café, almoço, etc.) - apenas dias de semana
      for(const b of SCHEDULE.breaks){
        const bsMs = baseMs + (b.start[0]*3600 + b.start[1]*60)*1000;
        const beMs = baseMs + (b.end[0]*3600   + b.end[1]*60)*1000;
        const i_s  = Math.max(fromMs, bsMs), i_e = Math.min(toMs, beMs);
        if(i_e > i_s) total += (i_e - i_s);
      }
    }
    
    // Fora do expediente (Madrugada/Noite) - sempre descontado
    // Antes do expediente
    const wsMs = baseMs + (SCHEDULE.work.start[0]*3600 + SCHEDULE.work.start[1]*60)*1000;
    const pre_s = Math.max(fromMs, baseMs), pre_e = Math.min(toMs, wsMs);
    if(pre_e > pre_s) total += (pre_e - pre_s);
    
    // Após expediente
    const weMs = baseMs + (SCHEDULE.work.end[0]*3600 + SCHEDULE.work.end[1]*60)*1000;
    const pos_s = Math.max(fromMs, weMs), pos_e = Math.min(toMs, baseMs+86400000);
    if(pos_e > pos_s) total += (pos_e - pos_s);
  }
  return total;
}

function abrirAjusteTempo(uid){
  _ajusteUid = uid;
  const u = users.find(x => x.id === uid);
  const s = getS(uid);

  // Cabeçalho
  document.getElementById('maj-sub').textContent = `${u.name} · ${u.sector}`;

  // Cards info
  const hRun = history.find(h => h.uid === uid && (h.status === 'running' || h.status === 'paused'));
  const horaInicio = (hRun && hRun.start) ? hRun.start : (s.startEpoch ? new Date(s.startEpoch).toLocaleTimeString('pt-BR') : '—');
  document.getElementById('maj-inicio-real').textContent = horaInicio;
  document.getElementById('maj-selb-tag').textContent    = s.selb || '—';
  const statusEl = document.getElementById('maj-status-tag');
  if(s.status === 'running'){
    statusEl.textContent = '▶ Em andamento';
    statusEl.style.color = 'var(--accent2)';
  } else if(s.status === 'paused'){
    statusEl.textContent = '⏸ Pausado';
    statusEl.style.color = 'var(--warn)';
  } else {
    statusEl.textContent = '— Ocioso';
    statusEl.style.color = 'var(--muted)';
  }

  // Campo com o tempo atual
  const currentSec = calcElapsedRunning(uid);
  document.getElementById('maj-tempo').value = fmt(currentSec || 0);
  document.getElementById('maj-err').textContent    = '';
  document.getElementById('maj-preview').textContent = '';

  // Abre modal
  document.getElementById('modal-ajuste-tempo').classList.remove('hidden');
  setTimeout(() => document.getElementById('maj-tempo').select(), 120);

  // Timer ao vivo dentro do modal
  if(_majTimerInterval) clearInterval(_majTimerInterval);
  function _updateLive(){
    const sec = calcElapsedRunning(_ajusteUid);
    document.getElementById('maj-timer-live').textContent = fmt(sec || 0);
  }
  _updateLive();
  _majTimerInterval = setInterval(_updateLive, 1000);
}

// Para o timer ao vivo quando o modal fecha
const _origCloseModal = window.closeModal;
window.closeModal = function(id){
  if(id === 'modal-ajuste-tempo' && _majTimerInterval){
    clearInterval(_majTimerInterval); _majTimerInterval = null;
  }
  if(_origCloseModal) _origCloseModal.apply(this, arguments);
};

function majPreviewAtualizar(){
  const val = document.getElementById('maj-tempo').value.trim();
  const preview = document.getElementById('maj-preview');
  const sec = timeStrToSec(val);
  if(sec === null || val.length < 7){
    preview.textContent = '';
    preview.style.color = 'var(--muted)';
    return;
  }
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s2 = sec%60;
  let parts = [];
  if(h) parts.push(h+'h');
  if(m) parts.push(m+'min');
  if(s2 || !parts.length) parts.push(s2+'s');
  preview.textContent = '→ ' + parts.join(' ') + ' de tempo líquido';
  preview.style.color = sec > 0 ? 'var(--accent2)' : 'var(--muted)';
}

function sincronizarTempoAutomatico(){
  const s = getS(_ajusteUid);
  // Usa diretamente o calcElapsedRunning que agora é preciso
  const sec = calcElapsedRunning(_ajusteUid);
  document.getElementById('maj-tempo').value = fmt(sec || 0);
  majPreviewAtualizar();
  const inp = document.getElementById('maj-tempo');
  inp.style.borderColor = 'var(--accent2)';
  setTimeout(() => inp.style.borderColor = '', 900);
}

// ── Sincronização automática: recalcula o tempo líquido a partir do startEpoch ──
async function autoSincronizarTempo(uid, btn){
  const s = getS(uid);
  if(s.status !== 'running' && s.status !== 'paused') return;

  if(btn){ btn.disabled = true; btn.textContent = '⏳'; }

  const nowTs = Date.now();

  // Fonte primária: _activeFrom no wstate ou startEpoch no history
  const hRun   = history.find(h => h.uid === uid && (h.status === 'running' || h.status === 'paused'));
  let startMs  = hRun?.startEpoch || null;
  if(!startMs && hRun?.start){
    const parts = hRun.start.split(':').map(Number);
    const d = new Date(); d.setHours(parts[0]||0, parts[1]||0, parts[2]||0, 0);
    startMs = d.getTime();
    if(startMs > nowTs) startMs -= 86400000;
  }
  if(!startMs){
    if(btn){ btn.textContent = '❌'; setTimeout(()=>{ btn.disabled=false; btn.textContent='Auto-Sinc'; },2000); }
    return;
  }

  // Ajusta effectiveNow se estiver em intervalo do sistema
  const schedState = getScheduleState();
  let effectiveNow = nowTs;
  if(schedState.type === 'break'){
    const b = schedState.break;
    const today = new Date(); today.setHours(0,0,0,0);
    effectiveNow = Math.min(nowTs, today.getTime() + (b.start[0]*3600 + b.start[1]*60)*1000);
  }

  const totalMs   = Math.max(0, effectiveNow - startMs);
  const breakMs   = _calcBreakMsFull(startMs, effectiveNow);
  const corrigido = Math.max(0, Math.floor((totalMs - breakMs) / 1000));

  const isPaused   = schedState.type !== 'work';
  const novoStatus = isPaused ? 'paused' : 'running';

  try {
    await dbPatch('/users/'+uid, {
      _frozenElapsed: corrigido,
      _activeFrom: isPaused ? null : nowTs,
      _status: novoStatus
    });

    s._frozenElapsed = corrigido;
    s._activeFrom    = isPaused ? null : nowTs;
    s.status         = novoStatus;

    // Reinicia timer para refletir imediatamente
    if(!isPaused){
      if(timers[uid]){ clearInterval(timers[uid]); delete timers[uid]; }
      startTimer(uid);
    }
    renderCard(uid);

    if(btn){
      btn.textContent = '✅';
      setTimeout(() => { btn.disabled=false; btn.textContent='Auto-Sinc'; }, 2000);
    }
  } catch(e){
    if(btn){ btn.textContent='❌'; setTimeout(()=>{ btn.disabled=false; btn.textContent='Auto-Sinc'; },2000); }
    console.error(e);
  }
}

async function sincronizarTodosTempos(){
  const running = users.filter(u => {
    const s = getS(u.id);
    return s.status === 'running' || s.status === 'paused';
  });

  if(!running.length){
    alert('Nenhum SELB em andamento para sincronizar.');
    return;
  }

  const schedState = getScheduleState();

  // ── BLOQUEIO: sincronização só é permitida durante o expediente ──
  if(schedState.type !== 'work'){
    const motivo = schedState.type === 'break'
      ? `durante o intervalo de ${schedState.break.name}`
      : schedState.type === 'before'
        ? 'antes do início do expediente (07:30)'
        : 'após o fim do expediente (17:30)';
    alert(`⚠️ Sincronização bloqueada!\n\nEssa operação não pode ser realizada ${motivo}.\n\nO cálculo de tempo é feito com base no expediente ativo (07:30 – 17:30). Execute durante o horário de trabalho.`);
    return;
  }

  if(!confirm(`Sincronizar ${running.length} usuário(s) com base no horário de início, descontando todos os intervalos do SCHEDULE?`)) return;

  const btn = document.getElementById('btn-sync-all');
  const origText = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.innerHTML = '⏳ Sincronizando...'; }

  let count = 0;
  for(const u of running){
    await autoSincronizarTempo(u.id);
    count++;
    if(btn) btn.innerHTML = `⏳ ${count}/${running.length}...`;
  }

  if(btn){
    btn.innerHTML = `✅ ${count} sincronizado${count !== 1 ? 's' : ''}!`;
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origText; }, 3000);
  }
}

// ── Sincronização automática em background a cada 4 minutos ──
async function autoSyncBackground(){
  const running = users.filter(u => {
    const s = getS(u.id);
    return s.status === 'running' || s.status === 'paused';
  });
  if(!running.length) return;
  const schedState = getScheduleState();
  if(schedState.type !== 'work') return;
  for(const u of running){
    try { await autoSincronizarTempo(u.id, null); } catch(e){}
  }
}
setInterval(autoSyncBackground, 4 * 60 * 1000);

async function confirmarAjusteTempo(){
  const val    = document.getElementById('maj-tempo').value.trim();
  const err    = document.getElementById('maj-err');
  const newSec = timeStrToSec(val);

  if(newSec === null){ err.textContent = 'Formato inválido. Use HH:MM:SS'; return; }
  if(newSec < 0)     { err.textContent = 'O tempo não pode ser negativo.';  return; }

  const s   = getS(_ajusteUid);
  const now = Date.now();

  err.textContent = '';

  try {
    const patch = {};

    if(s.status === 'running'){
      // Redefine o ponto de base: congela no valor novo e reinicia contagem a partir de agora
      s._frozenElapsed = newSec;
      s._activeFrom    = now;
      patch._frozenElapsed = newSec;
      patch._activeFrom    = now;
      // Reinicia timer local para refletir imediatamente
      if(timers[_ajusteUid]){ clearInterval(timers[_ajusteUid]); delete timers[_ajusteUid]; }
      startTimer(_ajusteUid);
    } else if(s.status === 'paused'){
      s._frozenElapsed = newSec;
      s._activeFrom    = null;
      patch._frozenElapsed = newSec;
      patch._activeFrom    = null;
    }

    await dbPatch('/users/' + _ajusteUid, patch);

    // Atualiza display imediato no card sem esperar o próximo tick
    const elCard = document.getElementById('elapsed-' + _ajusteUid);
    if(elCard){
      if(s.status === 'paused'){
        elCard.innerHTML = '<span style="color:var(--warn)">' + fmt(newSec) + '</span>';
      } else {
        elCard.textContent = fmt(newSec);
      }
    }
    updateTpb(_ajusteUid, newSec);

    closeModal('modal-ajuste-tempo');
    renderUsers();
    renderCard(_ajusteUid);
    // Garante timer ativo após re-render
    if(s.status === 'running' && !timers[_ajusteUid]) startTimer(_ajusteUid);

  } catch(e){
    err.textContent = 'Erro ao salvar: ' + e.message;
  }
}

// ════ RELATÓRIOS ════
let relFilter='';
let _relHistoryCache = null;
let _relSelectedUids = new Set(); // UIDs selecionados para os gráficos (vazio = todos)

// ── Sort state para cada tabela de relatório ──
let _relSort    = { col: 'eff', dir: 'desc' };   // tabela principal (Detalhe por profissional)
let _reprovSort = { col: 'date', dir: 'desc' };   // tabela de reprovações
let _scrapSort  = { col: 'date', dir: 'desc' };   // tabela SCRAP
let _mensalSort = { col: 'total', dir: 'desc' };  // tabela mensal

// ── Helpers de sort ──
function _toggleSort(state, col){
  if(state.col === col) state.dir = state.dir === 'desc' ? 'asc' : 'desc';
  else { state.col = col; state.dir = 'desc'; }
}
function _applySortIndicators(theadId, col, dir){
  const thead = document.getElementById(theadId);
  if(!thead) return;
  thead.querySelectorAll('th.sortable').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    const match = (th.getAttribute('onclick')||'').match(/'(\w+)'\)/);
    const thCol = match ? match[1] : null;
    if(thCol === col) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

function setRelSort(col){ _toggleSort(_relSort, col); renderRelatorios(); }
function setReprovSort(col){ _toggleSort(_reprovSort, col); renderReprovRel(); }
function setScrapSort(col){ _toggleSort(_scrapSort, col); renderScrapRel(); }
function setMensalSort(col){ _toggleSort(_mensalSort, col); renderMensalRel(); }

// ════════════════════════════════════════════════════════════════════════
// FILTRO GLOBAL DE DATA — compartilhado por todas as abas de relatórios
// ════════════════════════════════════════════════════════════════════════
let _globalDatePreset = null; // preset ativo (null = nenhum filtro selecionado)
window._relFilterChosen = false; // libera renderização dos relatórios quando true

// Injeta/atualiza placeholder "Selecione um filtro" no view-relatorios
function _relShowPlaceholder(){
  const view = document.getElementById('view-relatorios');
  if(!view) return;
  // esconde todos os relview-*
  view.querySelectorAll('[id^="relview-"]').forEach(el => { el.style.display = 'none'; });
  let ph = document.getElementById('rel-placeholder');
  if(!ph){
    ph = document.createElement('div');
    ph.id = 'rel-placeholder';
    ph.style.cssText = 'margin:24px auto;padding:28px 22px;max-width:520px;text-align:center;background:var(--bg2);border:1px dashed var(--border2);border-radius:12px;color:var(--muted);font-size:14px;line-height:1.5';
    ph.innerHTML = 'Selecione um filtro para visualizar o relatório.';
    const tabs = document.getElementById('rel-tabs');
    if(tabs && tabs.parentNode){ tabs.parentNode.parentNode.insertBefore(ph, tabs.parentNode.nextSibling); }
    else view.appendChild(ph);
  }
  ph.style.display = 'block';
}
function _relHidePlaceholder(){
  const ph = document.getElementById('rel-placeholder');
  if(ph) ph.style.display = 'none';
}

function _getGlobalDates(){
  const f = document.getElementById('global-date-from');
  const t = document.getElementById('global-date-to');
  return { from: f ? f.value : '', to: t ? t.value : '' };
}

function _fmtDateISO(iso){
  if(!iso) return '';
  const [y,m,d] = iso.split('-');
  return d+'/'+m+'/'+y;
}

function _updateGlobalDateLabel(){
  const {from, to} = _getGlobalDates();
  const lbl = document.getElementById('global-date-label');
  if(!lbl) return;
  if(!from && !to){ lbl.textContent=''; return; }
  lbl.textContent = from === to
    ? _fmtDateISO(from)
    : _fmtDateISO(from) + ' → ' + _fmtDateISO(to);
}

function _updateGlobalPresetButtons(preset){
  ['today','week','month','all'].forEach(p => {
    const btn = document.getElementById('gdp-'+p);
    if(!btn) return;
    if(p === preset){
      btn.style.background = 'var(--accent)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
    } else {
      btn.style.background = 'var(--bg3)';
      btn.style.color = 'var(--muted)';
      btn.style.borderColor = 'var(--border2)';
    }
  });
}

function gdpHover(btn){
  // restaura estilo se não for o ativo
  const id = btn.id; // gdp-today, gdp-week...
  const preset = id.replace('gdp-','');
  if(preset !== _globalDatePreset){
    btn.style.background='var(--bg3)';
    btn.style.color='var(--muted)';
    btn.style.borderColor='var(--border2)';
  }
}

function setGlobalDatePreset(preset){
  _globalDatePreset = preset;
  const todayISO = new Date().toISOString().slice(0,10);
  let from = todayISO, to = todayISO;
  if(preset === 'week'){
    const d = new Date(); d.setDate(d.getDate()-6);
    from = d.toISOString().slice(0,10);
  } else if(preset === 'month'){
    const d = new Date(); d.setDate(d.getDate()-29);
    from = d.toISOString().slice(0,10);
  } else if(preset === 'all'){
    const d = new Date(); d.setFullYear(d.getFullYear()-2);
    from = d.toISOString().slice(0,10);
  }
  const gf = document.getElementById('global-date-from');
  const gt = document.getElementById('global-date-to');
  if(gf) gf.value = from;
  if(gt) gt.value = to;
  _updateGlobalPresetButtons(preset);
  _updateGlobalDateLabel();
  _syncGlobalToLocalFilters();
  window._relFilterChosen = true;
  _relHidePlaceholder();
  _relHistoryCache = null; // limpa cache ao trocar o período
  if(typeof setRelSubTab === 'function' && window._currentRelSubTab){
    setRelSubTab(window._currentRelSubTab);
  } else {
    _reloadCurrentRelSubTab();
  }
}

// Sincroniza os inputs ocultos locais com o valor global
function _syncGlobalToLocalFilters(){
  const {from, to} = _getGlobalDates();
  // Produtividade
  const rf = document.getElementById('rel-date-from');
  const rt = document.getElementById('rel-date-to');
  if(rf) rf.value = from;
  if(rt) rt.value = to;
  // SCRAP
  const sf = document.getElementById('scrap-date-from');
  const st = document.getElementById('scrap-date-to');
  if(sf) sf.value = from;
  if(st) st.value = to;
}

async function onGlobalDateChange(){
  const {from, to} = _getGlobalDates();
  if(!from || !to) return;
  // Garante from <= to
  const gf = document.getElementById('global-date-from');
  const gt = document.getElementById('global-date-to');
  if(from > to && gf && gt){ gt.value = from; }
  _globalDatePreset = 'custom';
  _updateGlobalPresetButtons('');
  _updateGlobalDateLabel();
  _syncGlobalToLocalFilters();
  window._relFilterChosen = true;
  _relHidePlaceholder();
  // restaura a sub-aba ativa para sair do estado de placeholder
  if(typeof setRelSubTab === 'function' && window._currentRelSubTab){
    setRelSubTab(window._currentRelSubTab);
  } else {
    _reloadCurrentRelSubTab();
  }
}

// Recarrega a aba de relatório ativa com os novos filtros
async function _reloadCurrentRelSubTab(){
  const tab = window._currentRelSubTab || 'prod';
  if(tab === 'prod'){
    _relHistoryCache = null; // garante que o cache antigo não contamina o novo filtro
    await loadRelByDate();
    renderRelatorios();
  } else if(tab === 'scrap'){
    await loadScrapByDate();
    renderScrapRel();
  } else if(tab === 'reprov'){
    await _loadReprovByGlobalDate();
    renderReprovRel();
  } else if(tab === 'defeitos'){
    await _loadDefeitosByGlobalDate();
    renderDefeitos();
  } else if(tab === 'usuario'){
    await _loadUsuarioByGlobalDate();
    renderUsuarioRel();
  } else if(tab === 'modelo'){
    await renderModeloRel();
  } else if(tab === 'mensal'){
    renderMensalRel();
  }
}

// ── Carregadores globais por data para cada aba ──
async function _loadByGlobalDate(filterFn){
  const {from, to} = _getGlobalDates();
  if(!from || !to) return [];
  const todayDk  = new Date().toDateString().replace(/ /g,'_');
  const dateKeys = dateRangeKeys(from, to);
  let allRecs = [];
  const BATCH = 5;
  for(let i=0; i<dateKeys.length; i+=BATCH){
    const batch = dateKeys.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(async dk=>{
      if(dk===todayDk) return history;
      try{ const d=await dbGet('/history/'+dk); return d?Object.entries(d).map(([k,v])=>({...v,_docId:k,_dateKey:dk})):[];}catch(e){return[];}
    }));
    results.forEach(r=>allRecs=allRecs.concat(r));
  }
  return filterFn ? allRecs.filter(filterFn) : allRecs;
}

async function _loadReprovByGlobalDate(){
  document.getElementById('reprov-loading').style.display='block';
  document.getElementById('reprov-body').innerHTML='';
  _reprovAllRecs = await _loadByGlobalDate(h=>h.status==='rep');
  const lbl = document.getElementById('reprov-period-label');
  const {from,to} = _getGlobalDates();
  if(lbl) lbl.textContent = (from===to?_fmtDateISO(from):_fmtDateISO(from)+' → '+_fmtDateISO(to)) + ' — '+_reprovAllRecs.length+' reprovação(ões)';
  document.getElementById('reprov-loading').style.display='none';
}

async function _loadDefeitosByGlobalDate(){
  const loading = document.getElementById('defeitos-loading');
  if(loading) loading.style.display='block';
  _defeitosAllRecs = await _loadByGlobalDate(h=>h.status==='rep'&&h.motivo);
  const lbl = document.getElementById('defeitos-period-label');
  const {from,to} = _getGlobalDates();
  if(lbl) lbl.textContent = (from===to?_fmtDateISO(from):_fmtDateISO(from)+' → '+_fmtDateISO(to)) + ' — '+_defeitosAllRecs.length+' reprovação(ões)';
  if(loading) loading.style.display='none';
}

async function _loadUsuarioByGlobalDate(){
  const loading = document.getElementById('usuario-loading');
  if(loading) loading.style.display='block';
  _usuarioAllRecs = await _loadByGlobalDate(null);
  const lbl = document.getElementById('usuario-period-label');
  const {from,to} = _getGlobalDates();
  if(lbl) lbl.textContent = (from===to?_fmtDateISO(from):_fmtDateISO(from)+' → '+_fmtDateISO(to)) + ' — '+_usuarioAllRecs.length+' registro(s)';
  if(loading) loading.style.display='none';
}

// Inicializa o filtro global sem pré-selecionar data — o usuário precisa escolher
function initGlobalDateFilter(){
  // Não pré-preenche datas: força o usuário a selecionar um filtro
  _updateGlobalPresetButtons(_globalDatePreset);
  _updateGlobalDateLabel();
  _syncGlobalToLocalFilters();
}

function relSelecionarTodos(sel){
  const checks = document.querySelectorAll('#rel-prof-checks input[type=checkbox]');
  checks.forEach(cb => { cb.checked = sel; });
  relAtualizarSelecao();
}

function relAtualizarSelecao(){
  const checks = document.querySelectorAll('#rel-prof-checks input[type=checkbox]');
  _relSelectedUids.clear();
  checks.forEach(cb => { if(cb.checked) _relSelectedUids.add(cb.dataset.uid); });
  renderRelGraficos();
} // registros carregados para o período selecionado

function initRelDateFilter(){
  const today = new Date().toISOString().slice(0,10);
  const from = document.getElementById('rel-date-from');
  const to   = document.getElementById('rel-date-to');
  if(from && !from.value) from.value = today;
  if(to   && !to.value)   to.value   = today;
}

async function onRelDateChange(){
  await loadRelByDate();
  renderRelatorios();
}

async function loadRelByDate(){
  const fromVal = document.getElementById('rel-date-from').value;
  const toVal   = document.getElementById('rel-date-to').value;
  if(!fromVal || !toVal) return;
  if(fromVal > toVal){
    document.getElementById('rel-date-to').value = fromVal;
    return loadRelByDate();
  }

  document.getElementById('rel-loading').style.display = 'block';

  const todayISO  = new Date().toISOString().slice(0,10);
  const todayDk   = new Date().toDateString().replace(/ /g,'_');
  const dateKeys  = dateRangeKeys(fromVal, toVal); // reutiliza função existente do SCRAP

  let allRecs = [];
  const BATCH = 5;
  for(let i = 0; i < dateKeys.length; i += BATCH){
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async dk => {
      if(dk === todayDk) return history; // hoje: usa memory cache
      try {
        const data = await dbGet('/history/'+dk);
        if(!data) return [];
        return Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      } catch(e){ return []; }
    }));
    results.forEach(recs => allRecs = allRecs.concat(recs));
  }
  _relHistoryCache = allRecs;

  // Atualiza label
  const fmtDate = iso => { const [y,m,d]=iso.split('-'); return d+'/'+m+'/'+y; };
  const label = fromVal === toVal ? fmtDate(fromVal) : fmtDate(fromVal)+' → '+fmtDate(toVal);
  const lbl = document.getElementById('rel-period-label');
  if(lbl) lbl.textContent = label;

  document.getElementById('rel-loading').style.display = 'none';
  return allRecs;
}
let chartProd=null, chartTempo=null, chartStatus=null;
let scrapFilter='';
// ════════════════════════════════════════════════════════
// RELATÓRIO: TEMPO MÉDIO POR MODELO — POR USUÁRIO
// ════════════════════════════════════════════════════════
let _usuarioSector  = '';
let _usuarioSelUid  = null;
let _chartUsuario   = null;
let _usuarioAllRecs = null; // cache de registros carregados do Firebase para o período

// Carrega registros do Firebase conforme o período selecionado
async function loadUsuarioByPeriod(){
  const period  = (document.getElementById('usuario-period')||{}).value || 'today';
  const loading = document.getElementById('usuario-loading');
  if(loading) loading.style.display = 'block';

  const todayDk  = new Date().toDateString().replace(/ /g,'_');
  const todayISO = new Date().toISOString().slice(0,10);

  // Monta lista de dateKeys conforme o período
  let dateKeys = [];
  if(period === 'today'){
    dateKeys = [todayDk];
  } else {
    const days = period === 'week' ? 6 : period === 'month' ? 29 : 364;
    const from = new Date(); from.setDate(from.getDate() - days);
    const fromISO = from.toISOString().slice(0,10);
    dateKeys = dateRangeKeys(fromISO, todayISO);
  }

  let allRecs = [];
  const BATCH = 5;
  for(let i = 0; i < dateKeys.length; i += BATCH){
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async dk => {
      if(dk === todayDk) return history;
      try {
        const data = await dbGet('/history/'+dk);
        if(!data) return [];
        return Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      } catch(e){ return []; }
    }));
    results.forEach(recs => allRecs = allRecs.concat(recs));
  }

  _usuarioAllRecs = allRecs;
  if(loading) loading.style.display = 'none';
}

async function onUsuarioPeriodChange(){
  _usuarioSelUid = null; // reset seleção ao mudar período
  await loadUsuarioByPeriod();
  renderUsuarioRel();
}

function setUsuarioFilter(sector, btn){
  _usuarioSector = sector;
  document.querySelectorAll('#usuario-tabs .stab').forEach(b => b.classList.remove('a-all','a-mont','a-limp','a-comp','a-elet'));
  btn.classList.add('a-all');
  _usuarioSelUid = null; // reset seleção ao trocar setor
  renderUsuarioRel();
}


function _usuarioGetStatusFilter(){
  const v = (document.getElementById('usuario-status-filter')||{}).value || 'ok';
  return v; // 'ok' or 'all'
}

// Retorna a duração (em segundos) a usar nos cálculos de média por modelo.
// Regras para MONTAGEM e LIMPEZA:
//   <= 15min  → excluir (retorna 0)
//   > 6h      → ignorar  (retorna -1)
//   > 150min e <= 6h → contabilizar com cap de 150min (retorna 9000)
//   demais    → valor real
// Para outros setores, retorna o valor bruto sem restrições.
function calcDuracaoParaMedia(h){
  const _MIN    = 15  * 60;   //  15 min
  const _CAP    = 150 * 60;   // 150 min
  const _IGNORE = 6   * 3600; //   6 h
  const sec = calcDuracaoLiquida(h);
  if(h.sector === 'MONTAGEM' || h.sector === 'LIMPEZA'){
    if(!sec || sec <= _MIN) return 0;    // abaixo do mínimo
    if(sec > _IGNORE)       return -1;   // acima de 6h → ignorar
    if(sec > _CAP)          return _CAP; // entre 150min–6h → cap
    return sec;
  }
  return sec;
}

function _usuarioGetRecords(){
  const src     = _usuarioAllRecs !== null ? _usuarioAllRecs : history;
  const statusF = _usuarioGetStatusFilter();
  return src.filter(h => {
    if(statusF === 'ok' && h.status !== 'ok') return false;
    if(statusF === 'all' && !['ok','rep','scrap'].includes(h.status)) return false;
    if(!h.duracao || h.duracao === '00:00:00') return false;
    if(_usuarioSector && h.sector !== _usuarioSector) return false;
    // MONTAGEM/LIMPEZA: exclui abaixo de 15min e acima de 6h;
    // registros entre 150min–6h são mantidos e serão capados em calcDuracaoParaMedia.
    if(h.sector === 'MONTAGEM' || h.sector === 'LIMPEZA'){
      const d = calcDuracaoParaMedia(h);
      if(d <= 0) return false;
    }
    return true;
  });
}

function renderUsuarioRel(){
  const allRecs = _usuarioGetRecords();
  const searchQ = (document.getElementById('usuario-search')?.value || '').toUpperCase().trim();

  // ── Atualiza label de período ──
  const period  = (document.getElementById('usuario-period')||{}).value || 'today';
  const labels  = {today:'Hoje', week:'Últimos 7 dias', month:'Últimos 30 dias', all:'Todos os períodos'};
  const lbl     = document.getElementById('usuario-period-label');
  if(lbl) lbl.textContent = (labels[period]||'') + ' — ' + allRecs.length + ' registro(s)';

  // ── Monta lista de profissionais com registros ──
  const profMap = new Map(); // uid → {name, sector, recs[]}
  allRecs.forEach(h => {
    if(!h.uid || !h.name) return;
    if(!profMap.has(h.uid)) profMap.set(h.uid, {name: h.name, sector: h.sector||'', recs:[]});
    profMap.get(h.uid).recs.push(h);
  });
  // Filtra chips pelo nome do profissional OU por modelos que ele possui
  const profsAll = [...profMap.entries()].sort((a,b) => a[1].name.localeCompare(b[1].name));
  const profs    = searchQ
    ? profsAll.filter(([, p]) =>
        p.name.toUpperCase().includes(searchQ) ||
        p.recs.some(h => (h.equipamento||'').toUpperCase().includes(searchQ))
      )
    : profsAll;

  // ── Chips de seleção de usuário ──
  const chipsEl  = document.getElementById('usuario-chips');
  const selNomeEl = document.getElementById('usuario-sel-nome');
  if(chipsEl){
    chipsEl.innerHTML = '';
    if(!profs.length){
      chipsEl.innerHTML = '<span style="font-size:12px;color:var(--muted)">Nenhum profissional com registros no período.</span>';
      if(selNomeEl) selNomeEl.style.display = 'none';
    }
    profs.forEach(([uid, p]) => {
      const active   = uid === _usuarioSelUid;
      const secColor = p.sector==='MONTAGEM'?'var(--mont)':p.sector==='LIMPEZA'?'var(--limp)':p.sector==='ELETRÔNICA'?'var(--elet)':'var(--comp)';
      const initials = p.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
      const chip     = document.createElement('button');
      chip.innerHTML = `
        <span style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${active?'var(--purple)':secColor};color:#fff;font-size:10px;font-weight:700;flex-shrink:0">${initials}</span>
        <span style="display:flex;flex-direction:column;align-items:flex-start;gap:1px">
          <span style="font-size:12px;font-weight:600;color:${active?'var(--purple)':'var(--text)'};line-height:1.2">${p.name}</span>
          <span style="font-size:10px;color:${active?'rgba(167,139,250,.8)':'var(--muted)'};line-height:1.2">${p.recs.length} registro${p.recs.length!==1?'s':''} · ${p.sector}</span>
        </span>`;
      chip.style.cssText = `display:inline-flex;align-items:center;gap:9px;padding:7px 14px 7px 8px;border-radius:12px;cursor:pointer;font-family:var(--font);border:1px solid ${active?'var(--purple)':'var(--border2)'};background:${active?'rgba(167,139,250,.15)':'var(--bg3)'};transition:all .15s;text-align:left`;
      chip.onmouseover = () => { if(uid!==_usuarioSelUid){ chip.style.borderColor='var(--border2)'; chip.style.background='var(--bg4)'; } };
      chip.onmouseout  = () => { if(uid!==_usuarioSelUid){ chip.style.borderColor='var(--border2)'; chip.style.background='var(--bg3)'; } };
      chip.onclick = () => {
        _usuarioSelUid = uid === _usuarioSelUid ? null : uid;
        renderUsuarioRel();
      };
      chipsEl.appendChild(chip);
    });

    // Mostra nome do selecionado no header
    if(selNomeEl){
      if(_usuarioSelUid && profMap.has(_usuarioSelUid)){
        selNomeEl.textContent = '→ ' + profMap.get(_usuarioSelUid).name;
        selNomeEl.style.display = 'block';
      } else {
        selNomeEl.style.display = 'none';
      }
    }
  }

  // ── Média geral por modelo (todos os profissionais) ──
  const globalModelMap = new Map(); // modelo → [secs]
  allRecs.forEach(h => {
    const modelo = h.equipamento || h.modelo || '(sem modelo)';
    const sec    = calcDuracaoParaMedia(h); // cap 150min para MONTAGEM/LIMPEZA
    if(sec <= 0) return;
    if(!globalModelMap.has(modelo)) globalModelMap.set(modelo, []);
    globalModelMap.get(modelo).push(sec);
  });
  const globalAvg = new Map(); // modelo → avg secs
  globalModelMap.forEach((arr, modelo) => {
    globalAvg.set(modelo, calcAverage(arr));
  });

  // ── KPI geral ──
  const kpiEl = document.getElementById('usuario-kpi');
  if(kpiEl){
    const totalProfs  = profs.length;
    const totalRecs   = allRecs.length;
    const totalModels = globalModelMap.size;
    const allSecs     = allRecs.map(h => calcDuracaoLiquida(h)).filter(s=>s>0);
    const avgGeral    = calcAverage(allSecs);
    const mkKpi = (lbl, val, color) =>
      `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 16px">
         <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${lbl}</div>
         <div style="font-size:22px;font-weight:600;font-family:var(--mono);margin-top:5px;color:${color}">${val}</div>
       </div>`;
    kpiEl.innerHTML =
      mkKpi('Profissionais', totalProfs, 'var(--accent)') +
      mkKpi('Registros', totalRecs, 'var(--accent2)') +
      mkKpi('Modelos distintos', totalModels, 'var(--purple)') +
      mkKpi('Média geral', fmt(avgGeral), 'var(--warn)');
  }

  // ── Se nenhum usuário selecionado, limpa gráfico e tabela ──
  const bodyEl = document.getElementById('usuario-body');
  if(!_usuarioSelUid || !profMap.has(_usuarioSelUid)){
    if(bodyEl) bodyEl.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Selecione um profissional acima para ver o detalhe.</td></tr>`;
    if(_chartUsuario){ _chartUsuario.destroy(); _chartUsuario = null; }
    return;
  }

  const selProf = profMap.get(_usuarioSelUid);
  const selRecs = selProf.recs;

  // ── Agrupa registros do usuário por modelo ──
  const userModelMap = new Map(); // modelo → [secs]
  selRecs.forEach(h => {
    const modelo = h.equipamento || h.modelo || '(sem modelo)';
    const sec    = calcDuracaoParaMedia(h); // cap 150min para MONTAGEM/LIMPEZA
    if(sec <= 0) return;
    if(!userModelMap.has(modelo)) userModelMap.set(modelo, []);
    userModelMap.get(modelo).push(sec);
  });

  // Ordena por quantidade decrescente e filtra pelo termo de busca se aplicável
  const modelEntries = [...userModelMap.entries()]
    .map(([modelo, arr]) => {
      const avg = calcAverage(arr);
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      const gAvg = globalAvg.get(modelo) || avg;
      return {modelo, arr, avg, min, max, gAvg, diff: avg - gAvg};
    })
    .filter(e => !searchQ || e.modelo.toUpperCase().includes(searchQ))
    .sort((a,b) => b.arr.length - a.arr.length);

  // ── Gráfico ──
  const ctx = document.getElementById('chart-usuario');
  if(ctx){
    if(_chartUsuario){ _chartUsuario.destroy(); _chartUsuario = null; }
    const top = modelEntries.slice(0, 20); // max 20 modelos
    _chartUsuario = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: top.map(e => e.modelo),
        datasets: [
          {
            label: selProf.name,
            data: top.map(e => +(e.avg/3600).toFixed(4)),
            backgroundColor: 'rgba(167,139,250,.7)',
            borderColor: 'var(--purple)',
            borderWidth: 1,
            borderRadius: 4,
          },
          {
            label: 'Média geral',
            data: top.map(e => +(e.gAvg/3600).toFixed(4)),
            type: 'line',
            borderColor: 'var(--warn)',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointRadius: 4,
            pointBackgroundColor: 'var(--warn)',
            tension: 0.3,
          }
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#e8ecf4', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx2 => {
                const idx = ctx2.dataIndex;
                const e   = top[idx];
                const val = ctx2.datasetIndex === 0 ? e.avg : e.gAvg;
                return ' ' + ctx2.dataset.label + ': ' + fmtMin(val);
              }
            }
          }
        },
        scales: {
          x: { ticks: { color:'#7a83a0', font:{size:10} }, grid:{color:'rgba(255,255,255,.05)'} },
          y: {
            ticks: { color:'#7a83a0', font:{size:10},
              callback: v => v===0 ? '0' : fmtMin(v*3600)
            },
            grid: { color:'rgba(255,255,255,.05)' }
          }
        }
      }
    });
  }

  // ── Tabela ──
  if(bodyEl){
    if(!modelEntries.length){
      bodyEl.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:24px">Nenhum registro com duração válida para ${selProf.name}.</td></tr>`;
      return;
    }
    bodyEl.innerHTML = modelEntries.map(e => {
      const diffSec  = e.diff;
      const diffFmt  = (diffSec >= 0 ? '+' : '') + fmt(Math.abs(diffSec));
      const diffColor = diffSec > 60 ? 'var(--danger)' : diffSec < -60 ? 'var(--accent2)' : 'var(--muted)';
      const diffIcon  = diffSec > 60 ? '▲' : diffSec < -60 ? '▼' : '≈';
      return `<tr>
        <td style="font-weight:600;font-family:var(--mono);font-size:12px">${e.modelo}</td>
        <td style="text-align:right">${e.arr.length}</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--accent2)">${fmt(e.min)}</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--purple);font-weight:700">${fmt(e.avg)}</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--danger)">${fmt(e.max)}</td>
        <td style="text-align:right;font-family:var(--mono);color:var(--warn)">${fmt(e.gAvg)}</td>
        <td style="text-align:right;font-family:var(--mono);font-weight:700;color:${diffColor}">${diffIcon} ${diffFmt}</td>
      </tr>`;
    }).join('');
  }
}

let relSubTab='prod';

// ════ REFRESH BADGE — relatórios ════
// Em vez de redesenhar a cada update do Firebase (que pisca a tela),
// mostra um badge discreto. O usuário clica quando quiser atualizar.
function showRelRefreshBadge(){
  const badge = document.getElementById('rel-refresh-badge');
  if(badge) badge.style.display = 'block';
}
function hideRelRefreshBadge(){
  const badge = document.getElementById('rel-refresh-badge');
  if(badge) badge.style.display = 'none';
}
function refreshRelatorios(){
  hideRelRefreshBadge();
  _syncGlobalToLocalFilters();
  if(relSubTab==='prod'){
    _relHistoryCache = null;
    loadRelByDate().then(()=>renderRelatorios());
  } else if(relSubTab==='pedido') { /* nada a recarregar */ }
  else if(relSubTab==='scrap')  { loadScrapByDate().then(()=>renderScrapRel()); }
  else if(relSubTab==='modelo') renderModeloRel();
  else if(relSubTab==='usuario') { _usuarioAllRecs = null; _loadUsuarioByGlobalDate().then(()=>renderUsuarioRel()); }
  else if(relSubTab==='mensal') renderMensalRel();
  else if(relSubTab==='reprov') _loadReprovByGlobalDate().then(()=>renderReprovRel());
  else if(relSubTab==='defeitos') _loadDefeitosByGlobalDate().then(()=>renderDefeitos());
  else if(relSubTab==='duplicados') _loadDuplicadosByGlobalDate().then(()=>renderDuplicados());
}

function setRelSubTab(tab){
  // Bloqueia sub-abas não permitidas para o setor do usuário
  if(typeof currentUser !== 'undefined' && currentUser && !currentUser.isAdmin){
    const perms = (typeof getRelPermsFor === 'function') ? getRelPermsFor(currentUser.sector) : null;
    if(perms && perms[tab] === false){
      const firstAllowed = REL_TAB_DEFS.find(t => perms[t.key]);
      if(firstAllowed) tab = firstAllowed.key;
      else return;
    }
  }
  hideRelRefreshBadge();
  relSubTab=tab;
  window._currentRelSubTab = tab; // rastreia para o filtro global
  document.getElementById('relview-prod').style.display    = tab==='prod'    ? 'block':'none';
  document.getElementById('relview-pedido').style.display = tab==='pedido' ? 'block':'none';
  document.getElementById('relview-scrap').style.display  = tab==='scrap'  ? 'block':'none';
  document.getElementById('relview-modelo').style.display = tab==='modelo' ? 'block':'none';
  document.getElementById('relview-usuario').style.display= tab==='usuario'? 'block':'none';
  document.getElementById('relview-mensal').style.display = tab==='mensal' ? 'block':'none';
  document.getElementById('relview-reprov').style.display = tab==='reprov' ? 'block':'none';
  document.getElementById('relview-defeitos').style.display= tab==='defeitos'? 'block':'none';
  const vd = document.getElementById('relview-duplicados');
  if(vd) vd.style.display = tab==='duplicados' ? 'block':'none';
  const vb = document.getElementById('relview-busca-modelo');
  if(vb) vb.style.display = tab==='busca-modelo' ? 'block':'none';
  const vql = document.getElementById('relview-qual-liberados');
  if(vql) vql.style.display = tab==='qual-liberados' ? 'block':'none';

  const ids = ['reltab-prod','reltab-pedido','reltab-scrap','reltab-modelo','reltab-usuario','reltab-mensal','reltab-reprov','reltab-defeitos', 'reltab-duplicados', 'reltab-busca-modelo', 'reltab-qual-liberados'];
  ids.forEach(id => {
    const b = document.getElementById(id);
    if(b){
      b.style.background='none'; b.style.color='var(--muted)'; b.style.border='1px solid var(--border2)';
    }
  });

  const btnDireto = document.getElementById('btn-registrar-scrap-direto');
  if(btnDireto){
    const isDesMemOrAdmin = currentUser && (currentUser.isAdmin || currentUser.sector === 'DESMEMBRAMENTO');
    btnDireto.style.display = (tab === 'scrap' && isDesMemOrAdmin) ? 'block' : 'none';
  }

  // Garante filtro global inicializado
  initGlobalDateFilter();

  // Bloqueia exibição até o usuário escolher um filtro (data/preset)
  if(!window._relFilterChosen && tab !== 'pedido'){
    _relShowPlaceholder();
    return;
  }
  _relHidePlaceholder();



  if(tab==='pedido'){
    const b=document.getElementById('reltab-pedido');
    if(b){ b.style.background='var(--warn)'; b.style.color='#000'; b.style.border='none'; }
  } else if(tab==='prod'){
    const b=document.getElementById('reltab-prod');
    if(b){ b.style.background='var(--accent)'; b.style.color='#fff'; b.style.border='none'; }
    loadRelByDate().then(()=>renderRelatorios());
  } else if(tab==='scrap'){
    const b=document.getElementById('reltab-scrap');
    if(b){ b.style.background='var(--purple)'; b.style.color='#fff'; b.style.border='none'; }
    _syncGlobalToLocalFilters();
    loadScrapByDate().then(()=>renderScrapRel());
  } else if(tab==='modelo'){
    const b=document.getElementById('reltab-modelo');
    if(b){ b.style.background='var(--accent2)'; b.style.color='#000'; b.style.border='none'; }
    renderModeloRel();
  } else if(tab==='usuario'){
    const b=document.getElementById('reltab-usuario');
    if(b){ b.style.background='var(--purple)'; b.style.color='#fff'; b.style.border='none'; }
    _usuarioAllRecs = null;
    _loadUsuarioByGlobalDate().then(()=>renderUsuarioRel());
  } else if(tab==='mensal'){
    const b=document.getElementById('reltab-mensal');
    if(b){ b.style.background='var(--warn)'; b.style.color='#000'; b.style.border='none'; }
    initMensalSelect();
    renderMensalRel();
  } else if(tab==='reprov'){
    const b=document.getElementById('reltab-reprov');
    if(b){ b.style.background='var(--danger)'; b.style.color='#fff'; b.style.border='none'; }
    _loadReprovByGlobalDate().then(()=>renderReprovRel());
  } else if(tab==='defeitos'){
    const b=document.getElementById('reltab-defeitos');
    if(b){ b.style.background='var(--elet)'; b.style.color='#000'; b.style.border='none'; }
    _loadDefeitosByGlobalDate().then(()=>renderDefeitos());
  } else if(tab==='duplicados'){
    const b=document.getElementById('reltab-duplicados');
    if(b){ b.style.background='var(--mont)'; b.style.color='#000'; b.style.border='none'; }
    _loadDuplicadosByGlobalDate().then(()=>renderDuplicados());
  } else if(tab==='busca-modelo'){
    const b=document.getElementById('reltab-busca-modelo');
    if(b){ b.style.background='var(--accent)'; b.style.color='#fff'; b.style.border='none'; }
    renderBuscaModeloRel();
  } else if(tab==='qual-liberados'){
    const b=document.getElementById('reltab-qual-liberados');
    if(b){ b.style.background='#a78bfa'; b.style.color='#fff'; b.style.border='none'; }
    // Inicializa datas custom com hoje e renderiza
    const hojeStr = new Date().toISOString().split('T')[0];
    const deEl = document.getElementById('qual-rel-de');
    const ateEl = document.getElementById('qual-rel-ate');
    if (deEl && !deEl.value) deEl.value = hojeStr;
    if (ateEl && !ateEl.value) ateEl.value = hojeStr;
    const periodoEl = document.getElementById('qual-rel-periodo');
    if (periodoEl) {
      periodoEl.onchange = async function() {
        const wrap = document.getElementById('qual-rel-custom-wrap');
        if (wrap) wrap.style.display = this.value === 'custom' ? 'flex' : 'none';
        await _loadQualReprovByPeriodo();
        renderRelatorioUsuariosQual();
      };
    }
    // Renderiza imediatamente com dados já em cache (se houver), depois recarrega e re-renderiza
    if (typeof renderRelatorioUsuariosQual === 'function') renderRelatorioUsuariosQual();
    _loadQualReprovByPeriodo().then(() => {
      if (typeof renderRelatorioUsuariosQual === 'function') renderRelatorioUsuariosQual();
    });
  }
}


// ════ SCRAP — filtro por data ════
let _scrapAllRecs = [];

// Inicializa os campos de data com hoje
function initScrapDateFilter(){
  const today = new Date().toISOString().slice(0,10);
  const from  = document.getElementById('scrap-date-from');
  const to    = document.getElementById('scrap-date-to');
  if(from && !from.value) from.value = today;
  if(to   && !to.value)   to.value   = today;
}

async function onScrapDateChange(){
  await loadScrapByDate();
  renderScrapRel();
}

// Gera lista de dateKeys entre duas datas ISO (YYYY-MM-DD)
function dateRangeKeys(fromISO, toISO){
  const keys = [];
  const cur  = new Date(fromISO + 'T00:00:00');
  const end  = new Date(toISO   + 'T00:00:00');
  while(cur <= end){
    keys.push(cur.toDateString().replace(/ /g,'_'));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

async function loadScrapByDate(){
  const fromVal = document.getElementById('scrap-date-from').value;
  const toVal   = document.getElementById('scrap-date-to').value;
  if(!fromVal || !toVal) return;

  // Garante que from <= to
  if(fromVal > toVal){
    document.getElementById('scrap-date-to').value = fromVal;
    return loadScrapByDate();
  }

  document.getElementById('scrap-loading').style.display = 'block';
  document.getElementById('scrap-body').innerHTML = '';

  const todayDk  = new Date().toDateString().replace(/ /g,'_');
  const dateKeys = dateRangeKeys(fromVal, toVal);

  let allRecs = [];
  const BATCH = 5;
  for(let i = 0; i < dateKeys.length; i += BATCH){
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async dk => {
      if(dk === todayDk) return history;
      try {
        const data = await dbGet('/history/'+dk);
        if(!data) return [];
        return Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      } catch(e){ return []; }
    }));
    results.forEach(recs => allRecs = allRecs.concat(recs));
  }

  _scrapAllRecs = allRecs.filter(h => h.status === 'scrap');

  const fmtDate = iso => { const [y,m,d]=iso.split('-'); return d+'/'+m+'/'+y; };
  const label   = fromVal === toVal
    ? fmtDate(fromVal)
    : fmtDate(fromVal) + ' → ' + fmtDate(toVal);
  document.getElementById('scrap-period-label').textContent = label + ' — ' + _scrapAllRecs.length + ' registro(s)';
  document.getElementById('scrap-loading').style.display = 'none';
}

function setScrapFilter(f,btn){
  scrapFilter=f;
  document.getElementById('scrap-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f?'a-'+sc(f):'a-all');
  renderScrapRel();
}

function copiarScrapSelbs(){
  const src = _scrapAllRecs.length > 0 ? _scrapAllRecs : history.filter(h=>h.status==='scrap');
  const all  = src.filter(h => !scrapFilter || h.sector === scrapFilter);
  const selbs=[...new Set(all.map(h=>h.selb))];
  if(!selbs.length){ alert('Nenhum SCRAP registrado.'); return; }
  const btn=document.getElementById('copy-scrap-btn');
  navigator.clipboard.writeText(selbs.join('\n')).then(()=>{
    const orig=btn.innerHTML; btn.innerHTML='✅ Copiado! ('+selbs.length+')';
    btn.style.borderColor='var(--purple)'; btn.style.color='var(--purple)';
    setTimeout(()=>{ btn.innerHTML=orig; btn.style.borderColor='var(--border2)'; btn.style.color='var(--muted)'; },2000);
  }).catch(()=>{ alert('✅ '+selbs.length+' SELBs SCRAP copiados!'); });
}

// ════ REPROVADAS ════
let _reprovAllRecs = [];
let reprovFilter   = '';

function setReprovFilter(f, btn){
  reprovFilter = f;
  document.getElementById('reprov-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f ? 'a-'+sc(f) : 'a-all');
  renderReprovRel();
}

async function onReprovPeriodChange(){
  await loadReprovPeriod();
  renderReprovRel();
}

async function loadReprovPeriod(){
  const period  = document.getElementById('reprov-period').value;
  document.getElementById('reprov-loading').style.display = 'block';
  document.getElementById('reprov-body').innerHTML = '';
  const today   = new Date();
  const todayDk = today.toDateString().replace(/ /g,'_');
  const lbl     = document.getElementById('reprov-period-label');
  const months  = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};

  if(period === 'today'){
    _reprovAllRecs = history.filter(h => h.status === 'rep');
    if(lbl) lbl.textContent = 'Hoje — ' + today.toLocaleDateString('pt-BR');
    document.getElementById('reprov-loading').style.display = 'none';
    return;
  }

  const days = period === 'all' ? 90 : parseInt(period);
  const dateKeys = [];
  for(let i = 0; i < days; i++){
    const d = new Date(today); d.setDate(today.getDate() - i);
    dateKeys.push(d.toDateString().replace(/ /g,'_'));
  }

  let allRecs = [];
  const BATCH = 5;
  for(let i = 0; i < dateKeys.length; i += BATCH){
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async dk => {
      try {
        const data = await dbGet('/history/'+dk);
        if(!data) return [];
        return Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      } catch(e){ return []; }
    }));
    results.forEach(recs => allRecs = allRecs.concat(recs));
  }
  _reprovAllRecs = allRecs.filter(h => h.status === 'rep');

  if(period === 'all'){
    if(lbl) lbl.textContent = 'Todos os períodos — '+_reprovAllRecs.length+' reprovações';
  } else {
    const d0 = new Date(today); d0.setDate(today.getDate() - days + 1);
    const parts0 = d0.toDateString().replace(/ /g,' ').split(' ');
    if(lbl) lbl.textContent = 'Últimos '+days+' dias — '+
      parts0[2]+'/'+(months[parts0[1]]||'??')+' até hoje';
  }
  document.getElementById('reprov-loading').style.display = 'none';
}

function copiarReprovSelbs(){
  const src  = _reprovAllRecs.length > 0 ? _reprovAllRecs : history.filter(h=>h.status==='rep');
  const all  = src.filter(h => !reprovFilter || h.sector === reprovFilter);
  const selbs = [...new Set(all.map(h=>h.selb))];
  if(!selbs.length){ alert('Nenhuma reprovação registrada.'); return; }
  const btn = document.getElementById('copy-reprov-btn');
  navigator.clipboard.writeText(selbs.join('\n')).then(()=>{
    const orig = btn.innerHTML;
    btn.innerHTML = '✅ Copiado! ('+selbs.length+')';
    btn.style.borderColor='var(--danger)'; btn.style.color='var(--danger)';
    setTimeout(()=>{ btn.innerHTML=orig; btn.style.borderColor='var(--border2)'; btn.style.color='var(--muted)'; },2000);
  }).catch(()=>{ alert('✅ '+selbs.length+' SELBs copiados!'); });
}

function renderReprovRel(){
  const src  = _reprovAllRecs.length > 0 ? _reprovAllRecs : history.filter(h=>h.status==='rep');
  const all  = src.filter(h => !reprovFilter || h.sector === reprovFilter);

  // KPIs
  const withTime   = all.filter(h => parseDuracao(h.duracao) !== null);
  const tempos     = withTime.map(h => parseDuracao(h.duracao));
  const totalSec   = tempos.reduce((a,b)=>a+b,0);
  const avgSec     = tempos.length ? Math.round(totalSec/tempos.length) : 0;
  const maxSec     = tempos.length ? Math.max(...tempos) : 0;
  const byUser     = {};
  all.forEach(h=>{ byUser[h.name]=(byUser[h.name]||0)+1; });
  const topUser    = Object.entries(byUser).sort((a,b)=>b[1]-a[1])[0];

  // Motivos mais frequentes
  const byMotivo = {};
  all.forEach(h=>{ if(h.motivo){ byMotivo[h.motivo]=(byMotivo[h.motivo]||0)+1; } });
  const topMotivo = Object.entries(byMotivo).sort((a,b)=>b[1]-a[1])[0];

  // Retrabalho stats
  const comRetrab   = all.filter(h => h._duracaoRetrabalho);
  const aguardando  = all.filter(h => h._aguardandoRetrabalho === true);
  const retrabTempos = comRetrab.map(h => parseDuracao(h._duracaoRetrabalho)).filter(Boolean);
  const avgRetrab   = calcAverage(retrabTempos);

  document.getElementById('reprov-kpi').innerHTML = `
    <div class="sum-card"><div class="slbl">Total Reprovadas</div><div class="sval" style="color:var(--danger)">${all.length}</div></div>
    <div class="sum-card"><div class="slbl">Com retrabalho</div><div class="sval" style="color:var(--warn)">${comRetrab.length}</div></div>
    <div class="sum-card"><div class="slbl">Aguardando retrab.</div><div class="sval" style="color:var(--accent)">${aguardando.length}</div></div>
    <div class="sum-card"><div class="slbl">Tempo médio retrab.</div><div class="sval" style="color:var(--warn);font-size:18px">${avgRetrab?fmt(avgRetrab):'—'}</div></div>
    <div class="sum-card"><div class="slbl">Maior reprovador</div><div class="sval" style="font-size:13px;color:var(--danger)">${topUser?topUser[0]+' ('+topUser[1]+')':'—'}</div></div>
    <div class="sum-card"><div class="slbl">Motivo mais freq.</div><div class="sval" style="font-size:11px;color:var(--muted);white-space:normal;line-height:1.4">${topMotivo?topMotivo[0]+' ('+topMotivo[1]+'x)':'—'}</div></div>`;

  const tbody = document.getElementById('reprov-body');
  if(!all.length){
    tbody.innerHTML = `<tr><td colspan="11" class="empty">Nenhuma reprovação registrada.</td></tr>`;
    return;
  }

  const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  const _colValReprov = (h, col) => {
    if(col==='date')   return h.startEpoch||0;
    if(col==='start')  return h.start||'';
    if(col==='end')    return h.end||'';
    if(col==='dur')    return parseDuracao(h.duracao)||0;
    if(col==='name')   return (h.name||'').toLowerCase();
    if(col==='sector') return (h.sector||'').toLowerCase();
    if(col==='selb')   return (h.selb||'').toLowerCase();
    if(col==='equip')  return (h.equipamento||'').toLowerCase();
    if(col==='os')     return (h.osNum||'').toLowerCase();
    if(col==='motivo') return (h.motivo||'').toLowerCase();
    return 0;
  };
  const sorted = [...all].sort((a,b)=>{
    const va = _colValReprov(a, _reprovSort.col);
    const vb = _colValReprov(b, _reprovSort.col);
    if(typeof va==='string') return _reprovSort.dir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return _reprovSort.dir==='asc' ? va-vb : vb-va;
  });
  _applySortIndicators('reprov-thead', _reprovSort.col, _reprovSort.dir);
  tbody.innerHTML = sorted.map(h => {
    const dkParts = h._dateKey ? h._dateKey.replace(/_/g,' ').split(' ') : [];
    const dk = dkParts.length>=4 ? dkParts[2]+'/'+(months[dkParts[1]]||'??') : '—';
    const dur = h.duracao && h.duracao!=='00:00:00' ? h.duracao : '—';
    const durSec = parseDuracao(h.duracao);
    const durColor = durSec && durSec > 1800 ? 'var(--danger)' : durSec ? 'var(--warn)' : 'var(--muted)';
    // Retrabalho
    const retrabSec = parseDuracao(h._duracaoRetrabalho);
    const retrabColor = retrabSec && retrabSec > 1800 ? 'var(--danger)' : 'var(--warn)';
    let retrabCell;
    if(h._duracaoRetrabalho){
      retrabCell = `<span style="font-family:var(--mono);font-size:11px;color:${retrabColor};font-weight:600">${h._duracaoRetrabalho}</span>`;
    } else if(h._aguardandoRetrabalho){
      retrabCell = `<span style="font-size:11px;color:var(--accent);animation:pulse 1.5s infinite">⏳ Aguardando</span>`;
    } else {
      retrabCell = `<span style="font-size:11px;color:var(--muted)">—</span>`;
    }
    return `<tr>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${dk}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${h.start||'—'}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${h.end||'—'}</td>
      <td style="font-family:var(--mono);font-size:11px;color:${durColor};font-weight:600">${dur}</td>
      <td style="font-weight:500">${h.name||'—'}</td>
      <td><span class="stag stag-${sc(h.sector)}">${h.sector||'—'}</span></td>
      <td style="font-family:var(--mono);color:var(--danger);font-weight:600">${h.selb||'—'}</td>
      <td style="color:var(--muted);font-size:12px">${h.equipamento||'—'}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--elet)">${h.osNum||'—'}</td>
      <td style="color:var(--danger);font-size:12px;max-width:180px;white-space:normal">${h.motivo||'—'}</td>
      <td>${retrabCell}</td>
    </tr>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════════
// DEFEITOS FREQUENTES — agrupa reprovações por palavra-chave do motivo
// ════════════════════════════════════════════════════════════════════════
let _defeitosAllRecs = null;
let _defeitosSector  = '';

// Palavras-chave para normalizar motivos (ordem importa — mais específico primeiro)
const DEFEITO_KEYWORDS = [
  // ══════════════════════════════════════════════════════════════
  // FRASES COMPOSTAS — sempre vêm ANTES das palavras genéricas,
  // pois a busca usa "contém" e para no primeiro match encontrado.
  // ══════════════════════════════════════════════════════════════

  // Sujeira em tampas (antes de "tampa" genérico)
  { key:'tampa traseira suja', label:'Sujeira / Limpeza' },
  { key:'tampa suja',          label:'Sujeira / Limpeza' },
  { key:'tampa com sujeira',   label:'Sujeira / Limpeza' },

  // Revisão / limpeza geral (antes de "limpeza" genérico)
  { key:'revisao geral',       label:'Revisão Geral' },
  { key:'revisão geral',       label:'Revisão Geral' },
  { key:'limpeza geral',       label:'Revisão Geral' },

  // Cheiro de queimado (antes de "queimad" → Placa Eletrônica)
  { key:'cheiro de queimado',  label:'Odor / Cheiro' },
  { key:'cheiro queimado',     label:'Odor / Cheiro' },
  { key:'cheiro de queima',    label:'Odor / Cheiro' },

  // Fiação queimada (antes de "queimad" → Placa Eletrônica)
  { key:'fiacao queimad',      label:'Fiação Interna' },
  { key:'fiação queimad',      label:'Fiação Interna' },
  { key:'fio queimad',         label:'Fiação Interna' },
  { key:'cabo queimad',        label:'Fiação Interna' },

  // Conector quebrado (antes de "quebr" → Peça Quebrada)
  { key:'conector quebr',      label:'Conector / Porta' },
  { key:'entrada quebr',       label:'Conector / Porta' },
  { key:'porta usb quebr',     label:'Conector / Porta' },

  // Caixa amassada = embalagem (antes de "amassad" → Peça Quebrada)
  { key:'caixa amassad',       label:'Embalagem' },
  { key:'caixa danificad',     label:'Embalagem' },

  // Sem cabo/fonte = acessório faltando (antes de "cabo" → Cabo)
  { key:'sem cabo de forca',   label:'Acessório Faltando' },
  { key:'sem cabo de força',   label:'Acessório Faltando' },
  { key:'sem fonte de alimentacao', label:'Acessório Faltando' },
  { key:'sem fonte',           label:'Acessório Faltando' },
  { key:'sem manual',          label:'Acessório Faltando' },

  // ══════════════════════════════════════════════════════════════
  // PALAVRAS GENÉRICAS — ordem define prioridade entre sobrepostas
  // ══════════════════════════════════════════════════════════════

  { key:'gaveta',        label:'Gaveta' },
  { key:'caixa de papel',label:'Gaveta' },
  { key:'tampa',         label:'Tampa' },
  { key:'porta',         label:'Tampa' },
  { key:'lateral',       label:'Lateral' },
  { key:'capa',          label:'Lateral' },
  { key:'bandeja',       label:'Bandeja' },
  { key:'parafuso',      label:'Parafuso' },
  { key:'porca',         label:'Parafuso' },
  { key:'bypass',        label:'Bypass' },
  { key:'fusor',         label:'Fusor' },
  { key:'fusao',         label:'Fusor' },
  { key:'fusão',         label:'Fusor' },
  { key:'rolo',          label:'Rolo' },
  { key:'roller',        label:'Rolo' },
  { key:'roleta',        label:'Rolo' },
  { key:'rolete',        label:'Rolo' },
  { key:'careca',        label:'Rolo' },
  { key:'roda',          label:'Rolo' },
  { key:'sensor',        label:'Sensor' },
  { key:'toner',         label:'Toner' },
  { key:'tinta',         label:'Toner' },
  { key:'po de toner',   label:'Toner' },
  { key:'pó de toner',   label:'Toner' },
  { key:'po preto',      label:'Toner' },
  { key:'cartucho',      label:'Cartucho' },
  { key:'drum',          label:'Drum / Cilindro' },
  { key:'cilindro',      label:'Drum / Cilindro' },
  { key:'solenoide',     label:'Solenoide' },
  { key:'solenóide',     label:'Solenoide' },
  { key:'engrenagem',    label:'Engrenagem' },
  { key:'engrenage',     label:'Engrenagem' },
  { key:'motor',         label:'Motor' },
  { key:'cabo',          label:'Cabo' },
  { key:'fio',           label:'Cabo' },
  { key:'flat',          label:'Cabo' },
  { key:'usb',           label:'Cabo' },
  { key:'energia',       label:'Cabo / Fonte' },
  { key:'fonte',         label:'Cabo / Fonte' },
  { key:'tomada',        label:'Cabo / Fonte' },
  { key:'cabo de força', label:'Cabo / Fonte' },
  { key:'placa',         label:'Placa Eletrônica' },
  { key:'pci',           label:'Placa Eletrônica' },
  { key:'eletronic',     label:'Placa Eletrônica' },
  { key:'eletrônic',     label:'Placa Eletrônica' },
  { key:'curto',         label:'Placa Eletrônica' },
  { key:'queimad',       label:'Placa Eletrônica' },
  { key:'display',       label:'Display' },
  { key:'tela',          label:'Display' },
  { key:'touch',         label:'Display' },
  { key:'lcd',           label:'Display' },
  { key:'painel',        label:'Display' },
  { key:'scanner',       label:'Scanner / ADF' },
  { key:'adf',           label:'Scanner / ADF' },
  { key:'digitaliz',     label:'Scanner / ADF' },
  { key:'leitura',       label:'Scanner / ADF' },
  { key:'vidro',         label:'Scanner / ADF' },
  { key:'atol',          label:'Atolamento' },
  { key:'enrosc',        label:'Atolamento' },
  { key:'preso',         label:'Atolamento' },
  { key:'jam',           label:'Atolamento' },
  { key:'travand',       label:'Atolamento' },
  { key:'papel',         label:'Alimentação de Papel' },
  { key:'aliment',       label:'Alimentação de Papel' },
  { key:'puxa',          label:'Alimentação de Papel' },
  { key:'puxand',        label:'Alimentação de Papel' },
  { key:'arrast',        label:'Alimentação de Papel' },
  { key:'barulho',       label:'Barulho / Ruído' },
  { key:'ruido',         label:'Barulho / Ruído' },
  { key:'ruído',         label:'Barulho / Ruído' },
  { key:'ratinho',       label:'Barulho / Ruído' },
  { key:'estalo',        label:'Barulho / Ruído' },
  { key:'rangend',       label:'Barulho / Ruído' },
  { key:'chiad',         label:'Barulho / Ruído' },
  { key:'mancha',        label:'Mancha / Qualidade de Impressão' },
  { key:'impresso',      label:'Mancha / Qualidade de Impressão' },
  { key:'impressão',     label:'Mancha / Qualidade de Impressão' },
  { key:'copia',         label:'Mancha / Qualidade de Impressão' },
  { key:'cópia',         label:'Mancha / Qualidade de Impressão' },
  { key:'risco',         label:'Mancha / Qualidade de Impressão' },
  { key:'borrad',        label:'Mancha / Qualidade de Impressão' },
  { key:'borrão',        label:'Mancha / Qualidade de Impressão' },
  { key:'falha de impres', label:'Mancha / Qualidade de Impressão' },
  { key:'desbotad',      label:'Mancha / Qualidade de Impressão' },
  { key:'claro',         label:'Mancha / Qualidade de Impressão' },
  { key:'escuro',        label:'Mancha / Qualidade de Impressão' },
  { key:'listra',        label:'Mancha / Qualidade de Impressão' },
  { key:'pontos',        label:'Mancha / Qualidade de Impressão' },
  { key:'fantasm',       label:'Mancha / Qualidade de Impressão' },
  { key:'sujeir',        label:'Sujeira / Limpeza' },
  { key:'limpe',         label:'Sujeira / Limpeza' },
  { key:'limpeza',       label:'Sujeira / Limpeza' },
  { key:'poeira',        label:'Sujeira / Limpeza' },
  { key:'fuligem',       label:'Sujeira / Limpeza' },
  { key:'higien',        label:'Sujeira / Limpeza' },
  { key:'quebr',         label:'Peça Quebrada' },
  { key:'trincad',       label:'Peça Quebrada' },
  { key:'rachad',        label:'Peça Quebrada' },
  { key:'partid',        label:'Peça Quebrada' },
  { key:'danific',       label:'Peça Quebrada' },
  { key:'amassad',       label:'Peça Quebrada' },
  { key:'faltando',      label:'Peça Faltando' },
  { key:'falta',         label:'Peça Faltando' },
  { key:'ausente',       label:'Peça Faltando' },
  { key:'nao tem',       label:'Peça Faltando' },
  { key:'não tem',       label:'Peça Faltando' },
  { key:'trocad',        label:'Troca de Peça' },
  { key:'troca',         label:'Troca de Peça' },
  { key:'substitu',      label:'Troca de Peça' },
  { key:'peca nova',     label:'Troca de Peça' },
  { key:'peça nova',     label:'Troca de Peça' },
  { key:'componente novo',label:'Troca de Peça' },
  { key:'rede',          label:'Conectividade / Rede' },
  { key:'wifi',          label:'Conectividade / Rede' },
  { key:'conect',        label:'Conectividade / Rede' },
  { key:'ethernet',      label:'Conectividade / Rede' },
  { key:'lan',           label:'Conectividade / Rede' },
  { key:'ip',            label:'Conectividade / Rede' },
  { key:'bloqueio',      label:'Bloqueio / Travamento' },
  { key:'travad',        label:'Bloqueio / Travamento' },
  { key:'travament',     label:'Bloqueio / Travamento' },
  { key:'congel',        label:'Bloqueio / Travamento' },
  { key:'reinici',       label:'Bloqueio / Travamento' },
  { key:'desligand',     label:'Bloqueio / Travamento' },
  { key:'liga e desliga',label:'Bloqueio / Travamento' },
  { key:'nao liga',      label:'Não liga' },
  { key:'não liga',      label:'Não liga' },
  { key:'sem energia',   label:'Não liga' },
  { key:'morta',         label:'Não liga' },
  { key:'erro',          label:'Mensagem de Erro' },
  { key:'codigo de erro',label:'Mensagem de Erro' },
  { key:'código de erro',label:'Mensagem de Erro' },
  { key:'sc ',           label:'Mensagem de Erro' },
  { key:'lento',         label:'Lentidão / Performance' },
  { key:'demor',         label:'Lentidão / Performance' },
  { key:'lentid',        label:'Lentidão / Performance' },
  { key:'firmware',      label:'Firmware / Software' },
  { key:'software',      label:'Firmware / Software' },
  { key:'fw',            label:'Firmware / Software', boundary:true },
  { key:'atualiz',       label:'Firmware / Software' },
  { key:'driver',        label:'Firmware / Software' },
  { key:'duplex',        label:'Duplex / Frente e Verso' },
  { key:'frente e verso',label:'Duplex / Frente e Verso' },
  { key:'grampead',      label:'Finalizador / Grampo' },
  { key:'grampo',        label:'Finalizador / Grampo' },
  { key:'finalizador',   label:'Finalizador / Grampo' },
  { key:'esteira',       label:'Esteira / Correia' },
  { key:'correia',       label:'Esteira / Correia' },
  { key:'belt',          label:'Esteira / Correia' },
  { key:'mola',          label:'Mola' },
  { key:'graxa',         label:'Lubrificação' },
  { key:'lubrific',      label:'Lubrificação' },
  { key:'oleo',          label:'Lubrificação' },
  { key:'óleo',          label:'Lubrificação' },
  { key:'revis',         label:'Revisão Geral' },
  { key:'manutenc',      label:'Revisão Geral' },
  { key:'manutenç',      label:'Revisão Geral' },
  { key:'preventiv',     label:'Revisão Geral' },

  // ── Categorias adicionais (cobrem mais casos do dia a dia, reduzindo "Outros") ──
  { key:'pilha',         label:'Bateria / Pilha' },
  { key:'bateria',       label:'Bateria / Pilha' },
  { key:'relogio',       label:'Bateria / Pilha' },
  { key:'relógio',       label:'Bateria / Pilha' },

  { key:'etiqueta',      label:'Etiqueta / Identificação' },
  { key:'plaqueta',      label:'Etiqueta / Identificação' },
  { key:'numero de serie', label:'Etiqueta / Identificação' },
  { key:'número de série', label:'Etiqueta / Identificação' },
  { key:'selo',          label:'Etiqueta / Identificação' },

  { key:'arranh',        label:'Acabamento / Estética' },
  { key:'amarelad',      label:'Acabamento / Estética' },
  { key:'descascad',     label:'Acabamento / Estética' },
  { key:'desgast',       label:'Acabamento / Estética' },
  { key:'manchad',       label:'Acabamento / Estética' },
  { key:'pintura',       label:'Acabamento / Estética' },
  { key:'estetic',       label:'Acabamento / Estética' },
  { key:'estétic',       label:'Acabamento / Estética' },
  { key:'amassou',       label:'Acabamento / Estética' },
  { key:'deformad',      label:'Acabamento / Estética' },

  { key:'vazament',      label:'Vazamento' },
  { key:'vazand',        label:'Vazamento' },
  { key:'pingand',       label:'Vazamento' },
  { key:'goteira',       label:'Vazamento' },

  { key:'cheiro',        label:'Odor / Cheiro' },
  { key:'odor',          label:'Odor / Cheiro' },
  { key:'fedor',         label:'Odor / Cheiro' },
  { key:'queimado cheiro', label:'Odor / Cheiro' },

  { key:'calibr',        label:'Configuração / Calibração' },
  { key:'configurac',    label:'Configuração / Calibração' },
  { key:'configuraç',    label:'Configuração / Calibração' },
  { key:'ajuste de fabric', label:'Configuração / Calibração' },
  { key:'senha',         label:'Configuração / Calibração' },
  { key:'reset',         label:'Configuração / Calibração' },
  { key:'restaur',       label:'Configuração / Calibração' },

  { key:'conector',      label:'Conector / Porta' },
  { key:'porta usb',     label:'Conector / Porta' },
  { key:'entrada',       label:'Conector / Porta' },
  { key:'saida de cabo', label:'Conector / Porta' },
  { key:'saída de cabo', label:'Conector / Porta' },
  { key:'pino',          label:'Conector / Porta' },

  { key:'cartao de mem', label:'Memória / Armazenamento' },
  { key:'cartão de mem', label:'Memória / Armazenamento' },
  { key:'memoria',       label:'Memória / Armazenamento' },
  { key:'memória',       label:'Memória / Armazenamento' },
  { key:'hd ',           label:'Memória / Armazenamento', boundary:true },
  { key:'armazenamento', label:'Memória / Armazenamento' },

  { key:'empilhad',      label:'Bandeja de Saída / Empilhador' },
  { key:'bandeja de saida', label:'Bandeja de Saída / Empilhador' },
  { key:'bandeja de saída', label:'Bandeja de Saída / Empilhador' },
  { key:'saida de papel',label:'Bandeja de Saída / Empilhador' },
  { key:'saída de papel',label:'Bandeja de Saída / Empilhador' },

  { key:'embalagem',     label:'Embalagem' },
  { key:'caixa amassada',label:'Embalagem' },
  { key:'caixa danific', label:'Embalagem' },

  { key:'incompativ',    label:'Compatibilidade' },
  { key:'incompatív',    label:'Compatibilidade' },
  { key:'nao compativ',  label:'Compatibilidade' },
  { key:'não compatív',  label:'Compatibilidade' },
  { key:'nao reconhec',  label:'Compatibilidade' },
  { key:'não reconhec',  label:'Compatibilidade' },

  { key:'vibra',         label:'Vibração' },
  { key:'tremend',       label:'Vibração' },
  { key:'trepidand',     label:'Vibração' },

  { key:'desencaixad',   label:'Encaixe / Montagem' },
  { key:'desalinhad',    label:'Encaixe / Montagem' },
  { key:'fora do lugar', label:'Encaixe / Montagem' },
  { key:'frouxo',        label:'Encaixe / Montagem' },
  { key:'mal encaixad',  label:'Encaixe / Montagem' },
  { key:'nao encaixa',   label:'Encaixe / Montagem' },
  { key:'não encaixa',   label:'Encaixe / Montagem' },

  { key:'botao',         label:'Botão / Teclado' },
  { key:'botão',         label:'Botão / Teclado' },
  { key:'teclado',       label:'Botão / Teclado' },
  { key:'tecla',         label:'Botão / Teclado' },

  { key:'fiacao',        label:'Fiação Interna' },
  { key:'fiação',        label:'Fiação Interna' },
  { key:'curto circuito',label:'Fiação Interna' },
  { key:'fio solto',     label:'Fiação Interna' },

  { key:'ventoinha',     label:'Ventilação / Aquecimento' },
  { key:'cooler',        label:'Ventilação / Aquecimento' },
  { key:'esquent',       label:'Ventilação / Aquecimento' },
  { key:'superaquec',    label:'Ventilação / Aquecimento' },
  { key:'temperatura',   label:'Ventilação / Aquecimento' },

  { key:'acessorio',     label:'Acessório Faltando' },
  { key:'acessório',     label:'Acessório Faltando' },
  { key:'sem manual',    label:'Acessório Faltando' },
  { key:'sem fonte',     label:'Acessório Faltando' },
  { key:'sem cabo',      label:'Acessório Faltando' },
];

// Cache de classificações aprendidas via IA (legado, ainda lido por compatibilidade) — { motivoLower: label }
let _defeitoAICache = (()=>{ try { return JSON.parse(localStorage.getItem('defeito_ai_cache')||'{}'); } catch(e){ return {}; } })();
function _saveDefeitoAICache(){ try { localStorage.setItem('defeito_ai_cache', JSON.stringify(_defeitoAICache)); } catch(e){} }

// Cache de classificações feitas manualmente pelo usuário — { motivoLower: label }
let _defeitoManualCache = (()=>{ try { return JSON.parse(localStorage.getItem('defeito_manual_cache')||'{}'); } catch(e){ return {}; } })();
function _saveDefeitoManualCache(){ try { localStorage.setItem('defeito_manual_cache', JSON.stringify(_defeitoManualCache)); } catch(e){} }

function _defeitoNormalize(motivo){
  if(!motivo) return 'Outros';
  const m = motivo.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  // 1) classificação manual (definida pelo usuário) tem prioridade máxima
  if(_defeitoManualCache[m]) return _defeitoManualCache[m];
  // 2) cache da IA (legado) — palavras já aprendidas anteriormente
  if(_defeitoAICache[m]) return _defeitoAICache[m];
  for(const kw of DEFEITO_KEYWORDS){
    const k = kw.key.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    if(kw.boundary){
      // Palavras curtas/abreviações (ex.: "fw") só casam como palavra isolada,
      // para evitar falso-positivo dentro de outra palavra qualquer.
      const re = new RegExp('\\b'+k.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b');
      if(re.test(m)) return kw.label;
    } else if(m.includes(k)){
      return kw.label;
    }
  }
  return 'Outros';
}

// ── Categorias conhecidas (para o seletor de classificação manual) ──
function _defeitoCategoriasConhecidas(){
  return [...new Set(DEFEITO_KEYWORDS.map(k=>k.label))].sort();
}

// ── Classifica manualmente um único motivo (clique direto numa ocorrência) ──
// Abre o mesmo modal, já filtrado/focado naquele motivo específico.
window.classificarMotivoManual = function(motivoOriginal){
  abrirModalClassificarOutros(motivoOriginal);
};

// ── Abre o modal com TODOS os motivos distintos atualmente em "Outros" ──
// Em vez de um prompt() por motivo (que travava a tela em loop), mostra uma lista
// única, rolável, onde cada motivo tem seu próprio campo de categoria.
window.classificarOutrosManual = function(){
  abrirModalClassificarOutros(null);
};

function _coletarMotivosOutros(){
  const src = (_defeitosAllRecs||history.filter(h=>h.status==='rep'&&h.motivo))
    .filter(h=>!_defeitosSector||h.sector===_defeitosSector);

  const mapa = new Map(); // norm → { original, count }
  src.forEach(h=>{
    if(_defeitoNormalize(h.motivo)==='Outros'){
      const norm = (h.motivo||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
      if(!norm) return;
      if(!mapa.has(norm)) mapa.set(norm, { original: h.motivo, count: 0 });
      mapa.get(norm).count++;
    }
  });
  return [...mapa.entries()]
    .map(([norm, info]) => ({ norm, original: info.original, count: info.count }))
    .sort((a,b) => b.count - a.count);
}

function abrirModalClassificarOutros(motivoFoco){
  const motivos = _coletarMotivosOutros();
  if(!motivos.length){ alert('Nenhum motivo em "Outros" para classificar.'); return; }

  const categorias = _defeitoCategoriasConhecidas();
  const optionsHTML = '<option value="">— escolher categoria —</option>' +
    categorias.map(c=>`<option value="${c.replace(/"/g,'&quot;')}">${c}</option>`).join('');

  // Remove modal anterior, se existir
  const old = document.getElementById('modal-classificar-outros');
  if(old) old.remove();

  const linhasHTML = motivos.map((m,i)=>{
    const focado = motivoFoco && m.original === motivoFoco;
    return `<div class="mco-row" data-norm="${encodeURIComponent(m.norm)}" style="display:flex;align-items:center;gap:10px;padding:10px 6px;border-bottom:1px solid var(--border);${focado?'background:rgba(79,142,247,.1);border-radius:8px':''}">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${m.original.replace(/"/g,'&quot;')}">${m.original}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">${m.count}x ocorrência(s)</div>
      </div>
      <select class="mco-select" style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--font);font-size:12px;padding:6px 8px;min-width:200px;flex-shrink:0">
        ${optionsHTML}
      </select>
      <input class="mco-custom" type="text" placeholder="ou nome novo..." style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-family:var(--font);font-size:12px;padding:6px 8px;width:140px;flex-shrink:0">
    </div>`;
  }).join('');

  const modalHTML = `
    <div id="modal-classificar-outros" style="position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;max-width:760px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)">
        <div style="padding:20px 24px 14px;border-bottom:1px solid var(--border2);display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
          <div>
            <div style="font-size:16px;font-weight:700;color:var(--text)">🏷️ Classificar motivos em "Outros"</div>
            <div style="font-size:12px;color:var(--muted);margin-top:4px">${motivos.length} motivo(s) distinto(s). Escolha uma categoria existente ou digite uma nova para cada um. Os que ficarem em branco continuam em "Outros".</div>
          </div>
          <button onclick="document.getElementById('modal-classificar-outros').remove()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:50%;width:28px;height:28px;color:var(--muted);cursor:pointer;flex-shrink:0">✕</button>
        </div>
        <div style="padding:8px 24px;overflow-y:auto;flex:1">
          ${linhasHTML}
        </div>
        <div style="padding:16px 24px;border-top:1px solid var(--border2);display:flex;justify-content:flex-end;gap:10px">
          <button onclick="document.getElementById('modal-classificar-outros').remove()" style="background:var(--bg3);border:1px solid var(--border2);border-radius:9px;color:var(--muted);font-family:var(--font);font-size:12px;font-weight:600;padding:9px 18px;cursor:pointer">Fechar</button>
          <button onclick="salvarClassificacaoOutrosModal()" style="background:var(--accent);border:none;border-radius:9px;color:#fff;font-family:var(--font);font-size:12px;font-weight:700;padding:9px 20px;cursor:pointer">💾 Salvar classificações</button>
        </div>
      </div>
    </div>`;

  document.body.insertAdjacentHTML('beforeend', modalHTML);

  // Pré-seleciona a categoria no <select> quando o usuário digitar no campo customizado,
  // e vice-versa: ao escolher no select, limpa o campo customizado (evita ambiguidade).
  document.querySelectorAll('#modal-classificar-outros .mco-select').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const custom = sel.closest('.mco-row').querySelector('.mco-custom');
      if(sel.value) custom.value = '';
    });
  });
  document.querySelectorAll('#modal-classificar-outros .mco-custom').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const sel = inp.closest('.mco-row').querySelector('.mco-select');
      if(inp.value.trim()) sel.value = '';
    });
  });

  // Rola até a linha em foco, se houver
  if(motivoFoco){
    const linhaFoco = [...document.querySelectorAll('#modal-classificar-outros .mco-row')]
      .find(row => motivos.find(m => m.original === motivoFoco && encodeURIComponent(m.norm) === row.dataset.norm));
    if(linhaFoco && typeof linhaFoco.scrollIntoView === 'function') linhaFoco.scrollIntoView({block:'center'});
  }
}

// ── Lê todas as linhas do modal e salva as classificações preenchidas ──
window.salvarClassificacaoOutrosModal = function(){
  const rows = document.querySelectorAll('#modal-classificar-outros .mco-row');
  let alterados = 0;
  rows.forEach(row=>{
    const norm = decodeURIComponent(row.dataset.norm);
    const sel  = row.querySelector('.mco-select');
    const custom = row.querySelector('.mco-custom');
    const categoria = (custom.value.trim() || sel.value || '').trim();
    if(!categoria) return; // deixou em branco — continua em "Outros"
    _defeitoManualCache[norm] = categoria;
    alterados++;
  });

  const modal = document.getElementById('modal-classificar-outros');
  if(modal) modal.remove();

  if(alterados > 0){
    _saveDefeitoManualCache();
    renderDefeitos();
    alert(`${alterados} motivo(s) classificado(s) com sucesso.`);
  } else {
    alert('Nenhuma categoria foi escolhida — nada foi alterado.');
  }
};

async function loadDefeitosByPeriod(){
  const period = (document.getElementById('defeitos-period')||{}).value || 'today';
  const loading = document.getElementById('defeitos-loading');
  if(loading) loading.style.display = 'block';

  const todayDk  = new Date().toDateString().replace(/ /g,'_');
  const todayISO = new Date().toISOString().slice(0,10);
  let dateKeys = [];
  if(period === 'today'){
    dateKeys = [todayDk];
  } else {
    const days = period==='week' ? 6 : period==='month' ? 29 : 364;
    const from = new Date(); from.setDate(from.getDate()-days);
    dateKeys = dateRangeKeys(from.toISOString().slice(0,10), todayISO);
  }

  let allRecs = [];
  const BATCH = 5;
  for(let i=0;i<dateKeys.length;i+=BATCH){
    const batch = dateKeys.slice(i,i+BATCH);
    const results = await Promise.all(batch.map(async dk=>{
      if(dk===todayDk) return history;
      try { const d=await dbGet('/history/'+dk); return d?Object.entries(d).map(([k,v])=>({...v,_docId:k,_dateKey:dk})):[];} catch(e){ return []; }
    }));
    results.forEach(r => allRecs=allRecs.concat(r));
  }
  _defeitosAllRecs = allRecs.filter(h=>h.status==='rep' && h.motivo);
  if(loading) loading.style.display='none';

  const labels={today:'Hoje',week:'Últimos 7 dias',month:'Últimos 30 dias',all:'Todos os períodos'};
  const lbl=document.getElementById('defeitos-period-label');
  if(lbl) lbl.textContent=(labels[period]||'')+ ' — '+_defeitosAllRecs.length+' reprovação(ões)';
}

async function onDefeitosPeriodChange(){
  _defeitosAllRecs=null;
  await loadDefeitosByPeriod();
  renderDefeitos();
}

function setDefeitosFilter(sector, btn){
  _defeitosSector = sector;
  document.getElementById('defeitos-sector-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  btn.classList.add(sector?'a-'+sc(sector):'a-all');
  renderDefeitos();
}

function renderDefeitos(){
  const src = (_defeitosAllRecs||history.filter(h=>h.status==='rep'&&h.motivo))
    .filter(h=>!_defeitosSector||h.sector===_defeitosSector);

  // ── KPIs ──
  const totalRep  = src.length;
  const modelos   = new Set(src.map(h=>h.equipamento||'').filter(Boolean));
  const byUser    = {};
  src.forEach(h=>{ byUser[h.name]=(byUser[h.name]||0)+1; });
  const topUser   = Object.entries(byUser).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('defeitos-kpi').innerHTML=`
    <div class="sum-card"><div class="slbl">Total Reprovações</div><div class="sval" style="color:var(--danger)">${totalRep}</div></div>
    <div class="sum-card"><div class="slbl">Modelos afetados</div><div class="sval" style="color:var(--warn)">${modelos.size}</div></div>`;

  if(!totalRep){
    document.getElementById('defeitos-grid').innerHTML=
      `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted);font-size:13px">Nenhuma reprovação encontrada.</div>`;
    return;
  }

  // ── Agrupa por categoria de defeito ──
  const grupos = new Map(); // label → { count, modelos: Map<modelo,count>, registros[] }
  src.forEach(h=>{
    const cat = _defeitoNormalize(h.motivo);
    if(!grupos.has(cat)) grupos.set(cat,{count:0,modelos:new Map(),registros:[]});
    const g = grupos.get(cat);
    g.count++;
    const modelo = h.equipamento||'(sem modelo)';
    g.modelos.set(modelo,(g.modelos.get(modelo)||0)+1);
    g.registros.push(h);
  });

  // Ordena por frequência
  const sorted = [...grupos.entries()].sort((a,b)=>b[1].count-a[1].count);
  const maxCount = sorted[0]?.[1]?.count || 1;

  const grid = document.getElementById('defeitos-grid');
  // Pie chart com distribuição dos defeitos (top categorias + "Outras categorias" pequenas)
  // IMPORTANTE: a categoria real "Outros" (motivos NÃO classificados) é sempre destacada
  // separadamente, mesmo que pequena — ela nunca é misturada dentro do agrupamento de
  // "Outras categorias", para não confundir com o botão "Classificar Outros".
  const TOP_PIE = 14;
  const semClassificacao = sorted.find(([c])=>c==='Outros'); // categoria real "Outros"
  const sortedSemOutrosReal = sorted.filter(([c])=>c!=='Outros');

  const pieTop = sortedSemOutrosReal.slice(0, TOP_PIE);
  const pieRestoPequenas = sortedSemOutrosReal.slice(TOP_PIE).reduce((s,[,g])=>s+g.count,0);

  const pieLabels = pieTop.map(([c])=>c)
    .concat(pieRestoPequenas>0?['Outras categorias']:[])
    .concat(semClassificacao?['Outros (não classificado)']:[]);
  const pieData = pieTop.map(([,g])=>g.count)
    .concat(pieRestoPequenas>0?[pieRestoPequenas]:[])
    .concat(semClassificacao?[semClassificacao[1].count]:[]);
  const pieColors = ['#ef4444','#f59e0b','#a78bfa','#22d3ee','#34d399','#f472b6','#60a5fa','#fbbf24',
    '#fb923c','#4ade80','#e879f9','#38bdf8','#facc15','#c084fc','#94a3b8','#64748b'];

  const pieCardHTML = `<div style="grid-column:1/-1;background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:8px">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
      <div>
        <div style="font-size:15px;font-weight:700;color:var(--text)">Distribuição dos Defeitos</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">Proporção e volume de cada tipo de defeito</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <button onclick="classificarOutrosManual()" id="btn-classificar-outros"
          title="Classifica os motivos que ainda não têm categoria nenhuma (diferente das fatias pequenas do gráfico, que já são categorias conhecidas)"
          style="background:rgba(79,142,247,.15);border:1px solid rgba(79,142,247,.4);border-radius:8px;color:var(--accent);font-size:11px;font-weight:700;padding:7px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px">
          🏷️ Classificar "Outros"
        </button>
        <div style="font-family:var(--mono);font-size:11px;color:var(--muted)">${totalRep} reprovação(ões)</div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:center">
      <div style="position:relative;height:360px">
        <canvas id="defeitos-pie-chart"></canvas>
      </div>
      <div style="position:relative;height:360px">
        <canvas id="defeitos-bar-chart"></canvas>
      </div>
    </div>
    ${pieRestoPequenas>0?`<div style="margin-top:10px;font-size:11px;color:var(--muted);text-align:center">
      ℹ️ "Outras categorias" reúne ${sortedSemOutrosReal.slice(TOP_PIE).length} categoria(s) já identificada(s) que, por terem poucos casos, não couberam entre as maiores fatias — não é a mesma coisa que motivos sem classificação.
    </div>`:''}
  </div>`;

  grid.innerHTML = pieCardHTML + sorted.map(([cat, g])=>{
    const pct = Math.round((g.count/totalRep)*100);
    const barW = Math.round((g.count/maxCount)*100);
    // Top 3 modelos mais afetados
    const topModelos = [...g.modelos.entries()]
      .sort((a,b)=>b[1]-a[1])
      .slice(0,3)
      .map(([m,c])=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:11px;color:var(--text);flex:1;margin-right:8px">${m}</span>
        <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--danger);flex-shrink:0">${c}x</span>
      </div>`).join('');

    // Últimas 3 ocorrências (motivos originais) — clicáveis para classificar manualmente quando a categoria é "Outros"
    const ultimosMotivos = [...g.registros]
      .sort((a,b)=>(b.startEpoch||0)-(a.startEpoch||0))
      .slice(0,3)
      .map(h=>{
        const motivoEsc = (h.motivo||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'");
        const clicavel = cat === 'Outros';
        return `<div style="font-size:10px;color:var(--muted);padding:3px 0;border-bottom:1px solid var(--border);line-height:1.4${clicavel?';cursor:pointer':''}"${clicavel?` onclick="classificarMotivoManual('${motivoEsc}')" title="Clique para classificar este motivo"`:''}>
        <span style="color:var(--accent);font-family:var(--mono);margin-right:6px">${h.selb||''}</span>${h.motivo}${clicavel?' <span style="color:var(--accent)">🏷️</span>':''}
      </div>`;
      }).join('');

    return `<div style="background:var(--bg2);border:1px solid ${cat==='Outros'?'rgba(79,142,247,.4)':'var(--border)'};border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">${cat}${cat==='Outros'?' <span style="font-size:10px;font-weight:600;color:var(--accent)">(não classificado)</span>':''}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${pct}% das reprovações</div>
        </div>
        <div style="font-family:var(--mono);font-size:26px;font-weight:700;color:var(--danger);flex-shrink:0">${g.count}</div>
      </div>
      <!-- barra de frequência relativa -->
      <div style="height:5px;background:var(--bg4);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${barW}%;background:var(--danger);border-radius:3px;transition:width .4s ease"></div>
      </div>
      ${cat==='Outros'?`<button onclick="classificarOutrosManual()" style="background:rgba(79,142,247,.15);border:1px solid rgba(79,142,247,.4);border-radius:8px;color:var(--accent);font-size:11px;font-weight:700;padding:7px 10px;cursor:pointer">🏷️ Classificar todos os motivos desta categoria</button>`:''}
      <!-- modelos mais afetados -->
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Modelos mais afetados</div>
        ${topModelos||'<div style="font-size:11px;color:var(--muted)">—</div>'}
        ${g.modelos.size>3?`<div style="font-size:10px;color:var(--muted);margin-top:4px">+${g.modelos.size-3} outro(s) modelo(s)</div>`:''}
      </div>
      <!-- últimas ocorrências -->
      <div>
        <div style="font-size:10px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Últimas ocorrências${cat==='Outros'?' (clique para classificar)':''}</div>
        ${ultimosMotivos||'<div style="font-size:11px;color:var(--muted)">—</div>'}
      </div>
    </div>`;
  }).join('');

  // ── Defeitos por Usuário ──
  const porUsuario = new Map(); // user → { total, defeitos: Map<cat,count> }
  src.forEach(h=>{
    const u = h.name || '—';
    if(!porUsuario.has(u)) porUsuario.set(u,{total:0,defeitos:new Map()});
    const pu = porUsuario.get(u);
    pu.total++;
    const cat = _defeitoNormalize(h.motivo);
    pu.defeitos.set(cat,(pu.defeitos.get(cat)||0)+1);
  });
  const usuariosSorted = [...porUsuario.entries()].sort((a,b)=>b[1].total-a[1].total);
  const userRows = usuariosSorted.map(([user,info])=>{
    const topDefs = [...info.defeitos.entries()]
      .sort((a,b)=>b[1]-a[1])
      .slice(0,5)
      .map(([cat,c])=>{
        const pct = Math.round((c/info.total)*100);
        return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <span style="font-size:11px;color:var(--text);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cat}</span>
          <div style="flex:1;height:5px;background:var(--bg4);border-radius:3px;overflow:hidden;max-width:120px">
            <div style="height:100%;width:${pct}%;background:var(--danger)"></div>
          </div>
          <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--danger);min-width:34px;text-align:right">${c}x</span>
        </div>`;
      }).join('');
    return `<div style="background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px">
        <div style="font-size:13px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${user}</div>
        <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:var(--danger);flex-shrink:0">${info.total}</div>
      </div>
      ${topDefs}
      ${info.defeitos.size>5?`<div style="font-size:10px;color:var(--muted);margin-top:6px">+${info.defeitos.size-5} outro(s) tipo(s)</div>`:''}
    </div>`;
  }).join('');

  grid.insertAdjacentHTML('beforeend', `
    <div style="grid-column:1/-1;background:var(--bg2);border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:8px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-size:15px;font-weight:700;color:var(--text)">Defeitos por Usuário</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">Quais defeitos cada operador mais apresenta</div>
        </div>
        <div style="font-size:11px;color:var(--muted)">${usuariosSorted.length} usuário(s)</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px">
        ${userRows||'<div style="color:var(--muted);font-size:12px">Sem dados</div>'}
      </div>
    </div>`);

  // ── Renderiza Pie Chart ──
  if(typeof Chart!=='undefined'){
    const canvas = document.getElementById('defeitos-pie-chart');
    if(canvas){
      const existing = Chart.getChart(canvas);
      if(existing) existing.destroy();
      new Chart(canvas, {
        type:'pie',
        data:{
          labels: pieLabels,
          datasets:[{
            data: pieData,
            backgroundColor: pieColors.slice(0, pieLabels.length),
            borderColor: 'rgba(0,0,0,0.25)',
            borderWidth: 1
          }]
        },
        plugins:[outsideLabelsPlugin],
        options:{
          responsive:true,
          maintainAspectRatio:false,
          layout:{ padding:{ top:28, bottom:28, left:110, right:110 } },
          plugins:{
            legend:{ display:false },
            tooltip:{
              callbacks:{
                label:(ctx)=>{
                  const v = ctx.parsed;
                  const pct = Math.round((v/totalRep)*100);
                  return ` ${ctx.label}: ${v} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    }

    // ── Renderiza Bar Chart (todas as categorias, ordenadas por volume) ──
    const barCanvas = document.getElementById('defeitos-bar-chart');
    if(barCanvas){
      const existingBar = Chart.getChart(barCanvas);
      if(existingBar) existingBar.destroy();

      // Usa TODOS os dados ordenados (não só o top 8 do pie), excluindo agrupamentos artificiais
      const barLabels = sorted.map(([cat])=>cat);
      const barData   = sorted.map(([,g])=>g.count);
      // Cor: vermelho para "Outros" (não classificado), accent para os demais
      const barColors = sorted.map(([cat])=>
        cat==='Outros'
          ? 'rgba(239,68,68,0.85)'
          : cat==='Outros (não classificado)'
            ? 'rgba(239,68,68,0.85)'
            : 'rgba(79,142,247,0.80)'
      );
      const barHover = sorted.map(([cat])=>
        cat==='Outros'||cat==='Outros (não classificado)'
          ? 'rgba(239,68,68,1)'
          : 'rgba(79,142,247,1)'
      );

      new Chart(barCanvas, {
        type:'bar',
        data:{
          labels: barLabels,
          datasets:[{
            label:'Reprovações',
            data: barData,
            backgroundColor: barColors,
            hoverBackgroundColor: barHover,
            borderRadius: 5,
            borderSkipped: false,
          }]
        },
        options:{
          indexAxis:'y',
          responsive:true,
          maintainAspectRatio:false,
          plugins:{
            legend:{ display:false },
            tooltip:{
              callbacks:{
                label:(ctx)=>{
                  const v = ctx.parsed.x;
                  const pct = Math.round((v/totalRep)*100);
                  return ` ${v} ocorrência(s) — ${pct}% do total`;
                }
              }
            }
          },
          scales:{
            x:{
              grid:{ color:'rgba(255,255,255,0.06)' },
              ticks:{ color:'#94a3b8', font:{ size:10 } },
              beginAtZero:true
            },
            y:{
              grid:{ display:false },
              ticks:{
                color:'#e2e8f0',
                font:{ size:11 },
                // Trunca labels muito longos
                callback: function(val){
                  const label = this.getLabelForValue(val);
                  return label.length > 22 ? label.slice(0,20)+'…' : label;
                }
              }
            }
          }
        }
      });
    }
  }
}

function renderScrapRel(){
  const src = _scrapAllRecs.length > 0 ? _scrapAllRecs : history.filter(h=>h.status==='scrap');
  const all  = src.filter(h => !scrapFilter || h.sector === scrapFilter);

  // Separa registros de Desmembramento (descarte direto, sem tempo) dos demais
  const isDesmem = h => h._direto === true || h.sector === 'DESMEMBRAMENTO';
  const allNormal  = all.filter(h => !isDesmem(h));  // conta no Total SCRAP
  const allDesmem  = all.filter(h =>  isDesmem(h));  // exibidos na tabela mas não contam

  const withTime = allNormal.filter(h => parseDuracao(h.duracao) !== null);
  const tempos   = withTime.map(h => parseDuracao(h.duracao));
  const totalScrapSec = tempos.reduce((a,b)=>a+b,0);
  const avgScrapSec   = tempos.length ? Math.round(totalScrapSec/tempos.length) : 0;
  const maxScrapSec   = tempos.length ? Math.max(...tempos) : 0;
  const byUser={};
  allNormal.forEach(h=>{ byUser[h.name]=(byUser[h.name]||0)+1; });
  const topUser=Object.entries(byUser).sort((a,b)=>b[1]-a[1])[0];
  document.getElementById('scrap-kpi').innerHTML=`
    <div class="sum-card" title="Descarte por setores operacionais (exclui Desmembramento)">
      <div class="slbl">Total SCRAP</div>
      <div class="sval" style="color:var(--purple)">${allNormal.length}</div>
    </div>
    ${allDesmem.length ? `<div class="sum-card" title="Registros de descarte do setor Desmembramento (não contam no total operacional)" style="border-color:rgba(245,166,35,.3)">
      <div class="slbl" style="color:#f5a623">Desmembramento</div>
      <div class="sval" style="color:#f5a623">${allDesmem.length}</div>
    </div>` : ''}
    <div class="sum-card"><div class="slbl">Tempo total gasto</div><div class="sval" style="color:var(--danger);font-size:18px">${fmt(totalScrapSec)}</div></div>
    <div class="sum-card"><div class="slbl">Tempo médio por SCRAP</div><div class="sval" style="color:var(--warn);font-size:18px">${avgScrapSec?fmt(avgScrapSec):'—'}</div></div>
    <div class="sum-card"><div class="slbl">Maior tempo em SCRAP</div><div class="sval" style="color:var(--danger);font-size:18px">${maxScrapSec?fmt(maxScrapSec):'—'}</div></div>
    <div class="sum-card"><div class="slbl">Maior descartante</div><div class="sval" style="font-size:14px;color:var(--danger)">${topUser?topUser[0]+' ('+topUser[1]+')':'—'}</div></div>`;
  const tbody=document.getElementById('scrap-body');
  if(!all.length){ tbody.innerHTML=`<tr><td colspan="10" class="empty">Nenhum SCRAP registrado.</td></tr>`; return; }
  const _colValScrap = (h, col) => {
    if(col==='date')   return h.startEpoch||0;
    if(col==='start')  return h.start||'';
    if(col==='name')   return (h.name||'').toLowerCase();
    if(col==='sector') return (h.sector||'').toLowerCase();
    if(col==='selb')   return (h.selb||'').toLowerCase();
    if(col==='equip')  return (h.equipamento||'').toLowerCase();
    if(col==='os')     return (h.osNum||'').toLowerCase();
    if(col==='dur')    return parseDuracao(h.duracao)||0;
    if(col==='motivo') return (h.motivo||'').toLowerCase();
    return 0;
  };
  const sorted = [...all].sort((a,b)=>{
    const va = _colValScrap(a, _scrapSort.col);
    const vb = _colValScrap(b, _scrapSort.col);
    if(typeof va==='string') return _scrapSort.dir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return _scrapSort.dir==='asc' ? va-vb : vb-va;
  });
  _applySortIndicators('scrap-thead', _scrapSort.col, _scrapSort.dir);
  tbody.innerHTML=sorted.map(h=>{
    const dkParts = h._dateKey ? h._dateKey.replace(/_/g,' ').split(' ') : [];
    const months = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
    const dk = dkParts.length>=4 ? dkParts[2]+'/'+(months[dkParts[1]]||'??') : '—';
    const selbEsc = (h.selb||'').replace(/'/g,"\\'");
    const btnEtq = h.selb ? `<button onclick="qualGerarEtiquetaUnica('${selbEsc}')" title="Gerar etiqueta" style="background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.4);border-radius:7px;color:var(--purple);font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">🏷️ Etiqueta</button>` : '—';
    return `<tr>
    <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${dk}</td>
    <td style="font-family:var(--mono);font-size:11px">${h.start||'—'}</td>
    <td style="font-weight:500">${h.name}</td>
    <td><span class="stag stag-${sc(h.sector)}">${h.sector}</span></td>
    <td style="font-family:var(--mono);color:var(--purple)">${h.selb||'—'}</td>
    <td style="color:var(--muted);font-size:12px">${h.equipamento||'—'}</td>
    <td style="font-family:var(--mono);font-size:11px;color:var(--elet)">${h.osNum||'—'}</td>
    <td style="font-family:var(--mono);font-size:11px;color:${parseDuracao(h.duracao)>300?'var(--warn)':'var(--muted)'}">${h.duracao&&h.duracao!=='00:00:00'?h.duracao:'—'}</td>
    <td style="color:var(--danger);font-size:12px;max-width:200px">${h.motivo||'—'}</td>
    <td>${btnEtq}</td>
  </tr>`;}).join('');
}

// ════ TEMPO POR MODELO — todos os períodos ════
let modeloFilter = '';
// Janela de tempo (em dias) usada pelo relatório Tempo Médio por Modelo.
// Valores válidos: 30, 60, 90. Default = 90.
let _modeloWindowDays = 90;
function setModeloWindow(days, btn){
  _modeloWindowDays = days;
  document.querySelectorAll('#modelo-window-tabs .modelo-win-btn').forEach(b => b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  if(typeof renderModeloRel === 'function') renderModeloRel();
}
// chartModelo removido — Chart.js gerenciado via Chart.getChart() por canvas
let _modeloAllRecs = [];

function setModeloFilter(f, btn){
  modeloFilter = f;
  const tabs = document.getElementById('modelo-tabs');
  if(tabs) tabs.querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f ? 'a-'+sc(f) : 'a-all');
  renderModeloRel();
}

function parseDuracao(dur){
  if(!dur) return null;
  const p = dur.split(':').map(Number);
  if(p.length !== 3) return null;
  const secs = p[0]*3600 + p[1]*60 + p[2];
  return secs > 0 ? secs : null;
}

async function loadModeloAllPeriods(){
  document.getElementById('modelo-loading').style.display = 'block';
  const today = new Date();
  const todayDk = today.toDateString().replace(/ /g,'_');
  const dateKeys = [];
  for(let i = 1; i < 90; i++){
    const d = new Date(today); d.setDate(today.getDate() - i);
    dateKeys.push(d.toDateString().replace(/ /g,'_'));
  }
  let allRecs = [...history];
  const BATCH = 5;
  for(let i = 0; i < dateKeys.length; i += BATCH){
    const batch = dateKeys.slice(i, i+BATCH);
    const results = await Promise.all(batch.map(async dk => {
      try {
        const data = await dbGet('/history/'+dk);
        if(!data) return [];
        return Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk}));
      } catch(e){ return []; }
    }));
    results.forEach(recs => allRecs = allRecs.concat(recs));
  }
  _modeloAllRecs = allRecs;
  document.getElementById('modelo-loading').style.display = 'none';
}

async function recarregarModeloRel(){
  const btn = document.getElementById('btn-recarregar-modelo');
  if(btn){ btn.textContent = '⏳ Carregando...'; btn.disabled = true; }
  _modeloAllRecs = [];
  await renderModeloRel();
  if(btn){ btn.textContent = '🔄 Recarregar dados'; btn.disabled = false; }
}

// Abre modal com todos os SELBs de um modelo específico
function abrirModeloDetalhes(equipNome, sector){
  const statusSel = (document.getElementById('modelo-status-filter')?.value) || 'ok';
  const statusOk  = statusSel === 'ok' ? ['ok'] : ['ok','rep','scrap'];

  const _isMontLimp2 = (sector === 'MONTAGEM' || sector === 'LIMPEZA');
  const regs = _modeloAllRecs.filter(h =>
    h.equipamento && h.equipamento.trim() === equipNome &&
    h.sector === sector &&
    statusOk.includes(h.status) &&
    h.duracao
  ).map(h => {
    const rawSecs = calcDuracaoLiquida(h);
    // Para MONTAGEM e LIMPEZA: registros > 150min são exibidos com cap de 150min
    const cappedSecs = (_isMontLimp2 && rawSecs > 9000 && rawSecs <= 6 * 3600) ? 9000 : rawSecs;
    return {...h, _secs: cappedSecs, _secsRaw: rawSecs};
  })
   .filter(h => {
     if(!h._secsRaw || h._secsRaw <= 0) return false;
     // Para MONTAGEM e LIMPEZA: exclui abaixo de 15min e acima de 6h; acima de 150min entra com cap
     if(_isMontLimp2) return h._secsRaw > 900 && h._secsRaw <= 6 * 3600;
     return true;
   })
   .sort((a,b) => (b._secsRaw||0) - (a._secsRaw||0)); // maior tempo primeiro

  const modal = document.getElementById('modal-modelo-selbs');
  document.getElementById('mms-title').textContent = equipNome;
  document.getElementById('mms-sub').textContent = sector + ' · ' + regs.length + ' registro(s)';

  _renderModalSelbsBody(regs);
  modal.classList.remove('hidden');
}

function _renderModalSelbsBody(regs){
  const tbody = document.getElementById('mms-body');
  if(!regs.length){
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Nenhum registro encontrado.</td></tr>`;
    return;
  }
  const ativos  = regs.filter(h => !_selbsExcluidos.has(h._docId));
  const avgAtivo = calcAverage(ativos, h => h._secs);

  tbody.innerHTML = regs.map(h => {
    const exc = _selbsExcluidos.has(h._docId);
    const id  = (h._docId||'').replace(/'/g,"\\'");
    const dur = fmt(h._secs);
    // Data legível
    const dateStr = h._dateKey ? h._dateKey.replace(/_/g,' ') : '';
    const dateFmt = dateStr ? (() => { try { return new Date(dateStr).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'}); } catch(e){ return dateStr; } })() : '—';
    return `<tr style="${exc ? 'opacity:0.4;' : ''}">
      <td style="font-family:var(--mono);font-weight:600;color:var(--accent);font-size:11px">${h.selb||'—'}</td>
      <td style="font-size:11px;color:var(--muted)">${h.name||'—'}</td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${dateFmt}</td>
      <td style="font-family:var(--mono);font-size:12px;color:${exc?'var(--muted)':'var(--accent2)'};">${dur}</td>
      <td style="font-size:10px;color:var(--muted)">${h.start||'—'} → ${h.end||'—'}</td>
      <td>
        ${exc
          ? `<button class="tbtn" onclick="restaurarSelb('${id}')" style="color:var(--accent2);border-color:rgba(61,214,140,.3);font-size:10px;padding:3px 8px">↩ Restaurar</button>`
          : `<button class="tbtn del" onclick="excluirSelb('${id}')" style="font-size:10px;padding:3px 8px">⊘ Excluir</button>`
        }
      </td>
    </tr>`;
  }).join('');

  // Rodapé com média recalculada
  const foot = document.getElementById('mms-footer');
  if(foot){
    const excCount = regs.filter(h=>_selbsExcluidos.has(h._docId)).length;
    foot.innerHTML = excCount > 0
      ? `<span style="color:var(--muted);font-size:11px">${excCount} registro(s) excluído(s) · </span>
         <span style="color:var(--accent);font-size:12px;font-weight:600">Média recalculada: ${fmt(avgAtivo)}</span>`
      : `<span style="color:var(--muted);font-size:11px">Média atual: </span>
         <span style="color:var(--accent);font-size:12px;font-weight:600">${fmt(avgAtivo)}</span>`;
  }

  // guarda regs para re-render sem fechar modal
  window._mmsRegsCache = regs;
}

function excluirSelb(docId){
  _selbsExcluidos.add(docId);
  dbPatch('/config/modelo_selbs_excluidos', {[docId]: true}).catch(()=>{});
  _atualizarPainelExcluidos();
  if(window._mmsRegsCache) _renderModalSelbsBody(window._mmsRegsCache);
  renderModeloRel();
}

function restaurarSelb(docId){
  _selbsExcluidos.delete(docId);
  dbDelete('/config/modelo_selbs_excluidos/'+docId).catch(()=>{});
  _atualizarPainelExcluidos();
  if(window._mmsRegsCache) _renderModalSelbsBody(window._mmsRegsCache);
  renderModeloRel();
}

function limparTodosExcluidos(){
  _selbsExcluidos.clear();
  dbDelete('/config/modelo_selbs_excluidos').catch(()=>{});
  _atualizarPainelExcluidos();
  if(window._mmsRegsCache) _renderModalSelbsBody(window._mmsRegsCache);
  renderModeloRel();
}

function toggleModeloExcluidos(){
  const panel = document.getElementById('modelo-excluidos-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function _atualizarPainelExcluidos(){
  const count = _selbsExcluidos.size;
  const btnEx  = document.getElementById('btn-modelo-excluidos');
  const countEl = document.getElementById('modelo-excluidos-count');
  const list   = document.getElementById('modelo-excluidos-list');
  if(btnEx) btnEx.style.display = count > 0 ? 'inline-flex' : 'none';
  if(countEl) countEl.textContent = count;
  if(list){
    if(!count){
      list.innerHTML = '<span style="color:var(--muted)">Nenhum SELB excluído.</span>';
    } else {
      list.innerHTML = [..._selbsExcluidos].map(docId => {
        const rec = _modeloAllRecs.find(h => h._docId === docId);
        const label = rec ? `${rec.selb||docId} — ${rec.equipamento||''}` : docId;
        const id = docId.replace(/'/g,"\\'");
        return `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--bg3);
          border:1px solid rgba(242,87,87,.3);border-radius:20px;padding:4px 10px;font-size:11px">
          <span style="color:var(--text)">${label}</span>
          <span onclick="restaurarSelb('${id}')" style="cursor:pointer;color:var(--danger);font-weight:700;margin-left:2px" title="Restaurar">×</span>
        </span>`;
      }).join('');
    }
  }
}

async function renderModeloRel(){
  if(_modeloAllRecs.length === 0) await loadModeloAllPeriods();

  // Filtro de status: 'ok' apenas ou 'ok'+'rep'+'scrap' (todas concluídas)
  const statusSel = (document.getElementById('modelo-status-filter')?.value) || 'ok';
  const statusOk  = statusSel === 'ok' ? ['ok'] : ['ok','rep','scrap'];

  // Janela deslizante de 90 dias — descarta qualquer registro mais antigo,
  // mesmo que ainda esteja no cache em memória.
  const _winDays = (typeof _modeloWindowDays === 'number' && _modeloWindowDays > 0) ? _modeloWindowDays : 90;
  const _cutoff90 = Date.now() - _winDays * 24 * 60 * 60 * 1000;
  const _recDateMs = (h) => {
    if(h.endEpoch && h.endEpoch > 0) return h.endEpoch;
    if(h.startEpoch && h.startEpoch > 0) return h.startEpoch;
    if(h._dateKey){ const t = Date.parse(h._dateKey.replace(/_/g,' ')); if(!isNaN(t)) return t; }
    return Date.now(); // sem data → assume hoje (não descarta)
  };
  const recs = _modeloAllRecs.filter(h =>
    statusOk.includes(h.status) &&
    (h.sector === 'MONTAGEM' || h.sector === 'LIMPEZA' || h.sector === 'COMPLEXA' || h.sector === 'ELETRÔNICA') &&
    (!modeloFilter || h.sector === modeloFilter) &&
    h.equipamento && h.duracao &&
    _recDateMs(h) >= _cutoff90
  );

  // Agrupa por equipamento+setor; exclui SELBs individualmente por _docId
  const byEquip = {};
  const _MONT_LIMP_MIN = 15 * 60; //  15 min em segundos
  const _MONT_LIMP_MAX = 150 * 60; // 150 min em segundos

  recs.forEach(h => {
    const key     = h.equipamento.trim() + '||' + h.sector;
    const secsRaw = calcDuracaoLiquida(h);
    if(!secsRaw || secsRaw <= 0) return;
    // Para MONTAGEM e LIMPEZA (alinhado com calcDuracaoParaMedia):
    //   <= 15 min             → descarta
    //   > 6 h                 → descarta (outlier extremo)
    //   entre 150 min e 6 h   → contabiliza com cap de 150 min
    //   entre 15 min e 150min → valor real
    let secs = secsRaw;
    if(h.sector === 'MONTAGEM' || h.sector === 'LIMPEZA'){
      if(secsRaw <= _MONT_LIMP_MIN)  return;              // abaixo do mínimo → descarta
      if(secsRaw > 6 * 3600)         return;              // acima de 6h → descarta
      if(secsRaw > _MONT_LIMP_MAX)   secs = _MONT_LIMP_MAX; // entre 150min–6h → cap 150min
    }
    if(!byEquip[key]) byEquip[key] = { nome: h.equipamento.trim(), sector: h.sector, tempos: [], allTempos: [], docIds: [] };
    byEquip[key].allTempos.push(secs);
    byEquip[key].docIds.push(h._docId);
    if(!_selbsExcluidos.has(h._docId)) byEquip[key].tempos.push(secs);
  });

  const rows = Object.values(byEquip).map(e => {
    const n      = e.tempos.length;
    const nTotal = e.allTempos.length;
    const nExc   = e.docIds.filter(id => _selbsExcluidos.has(id)).length;
    const sum    = e.tempos.reduce((a,b)=>a+b,0);
    const avg    = n > 0 ? Math.round(sum / n) : 0;
    const min    = n > 0 ? Math.min(...e.tempos) : 0;
    const max    = n > 0 ? Math.max(...e.tempos) : 0;
    return { nome: e.nome, sector: e.sector, n, nTotal, nExc, avg, min, max, sum };
  }).sort((a,b) => b.avg - a.avg);

  const totalExc = _selbsExcluidos.size;
  const lbl = document.getElementById('modelo-period-label');
  const statusLabel = statusSel === 'ok' ? 'aprovadas' : 'concluídas';
  if(lbl) lbl.textContent = 'Últimos '+_winDays+' dias — '+recs.length+' registros '+statusLabel+' de '+rows.length+' modelos'
    + (totalExc > 0 ? ` · ${totalExc} SELB(s) excluído(s) da média` : '');

  _atualizarPainelExcluidos();

  const clr = { grid:'rgba(255,255,255,0.07)', text:'#7a83a0' };

  function renderSetorModelo(sector, colorVar, chartId, kpiId, bodyId, labelId){
    const searchQ = (document.getElementById('modelo-search')?.value || '').toUpperCase().trim();
    const sRows    = rows.filter(r => r.sector === sector && (!searchQ || r.nome.toUpperCase().includes(searchQ))).sort((a,b)=>b.avg-a.avg);
    const sRowsVis = sRows.filter(r => r.n > 0); // tem ao menos 1 registro ativo
    const sRecs    = sRowsVis.reduce((a,r)=>a+r.n, 0);
    const sTotal   = sRowsVis.reduce((a,r)=>a+r.sum, 0);
    const sAvg     = sRecs > 0 ? Math.round(sTotal/sRecs) : 0;
    const sExcTotal= sRows.reduce((a,r)=>a+r.nExc, 0);

    const lbl = document.getElementById(labelId);
    if(lbl) lbl.textContent = sRows.length+' modelos · '+sRecs+' registros ativos'+(sExcTotal>0?' · '+sExcTotal+' SELB(s) excluído(s)':'');

    document.getElementById(kpiId).innerHTML = sRows.length ? `
      <div class="sum-card"><div class="slbl">Modelos</div><div class="sval" style="color:${colorVar}">${sRows.length}</div></div>
      <div class="sum-card"><div class="slbl">Registros ativos</div><div class="sval" style="color:var(--accent2)">${sRecs}</div></div>
      <div class="sum-card"><div class="slbl">Média geral</div><div class="sval" style="color:var(--warn)">${fmt(sAvg)}</div></div>
    ` : `<div style="font-size:12px;color:var(--muted);padding:8px">Nenhum registro para este setor.</div>`;

    const chartEl = document.getElementById(chartId);
    const existingChart = Chart.getChart(chartEl);
    if(existingChart) existingChart.destroy();

    if(!sRowsVis.length){ chartEl.style.display='none'; }
    else {
      chartEl.style.display='';
      const top = sRowsVis.slice(0,15);
      new Chart(chartEl, {
        type: 'bar',
        data: {
          labels: top.map(r => r.nome.length > 28 ? r.nome.slice(0,26)+'…' : r.nome),
          datasets: [
            { label:'Mínimo', data: top.map(r=>+(r.min/3600).toFixed(4)), backgroundColor:'rgba(61,214,140,0.5)', borderRadius:4 },
            { label:'Médio',  data: top.map(r=>+(r.avg/3600).toFixed(4)), backgroundColor:colorVar.includes('mont')?'rgba(79,142,247,0.85)':'rgba(61,214,140,0.85)', borderRadius:4 },
            { label:'Máximo', data: top.map(r=>+(r.max/3600).toFixed(4)), backgroundColor:'rgba(245,166,35,0.5)', borderRadius:4 }
          ]
        },
        options: {
          responsive:true,
          plugins:{
            legend:{ labels:{ color:clr.text, font:{size:11}, boxWidth:12 } },
            tooltip:{ callbacks:{
              label: ctx2 => {
                const idx = ctx2.dataIndex;
                const r   = top[idx];
                const val = ctx2.dataset.label === 'Mínimo' ? r.min
                          : ctx2.dataset.label === 'Máximo' ? r.max : r.avg;
                return ' ' + ctx2.dataset.label + ': ' + fmtMin(val);
              }
            }}
          },
          scales:{
            x:{ ticks:{ color:clr.text, font:{size:10} }, grid:{ color:clr.grid } },
            y:{ ticks:{ color:clr.text, font:{size:10}, callback: v => v===0?'0':fmtMin(v*3600) },
                grid:{ color:clr.grid },
                title:{ display:true, text:'tempo', color:clr.text, font:{size:10} } }
          }
        }
      });
    }

    const tbody = document.getElementById(bodyId);
    if(!sRows.length){
      tbody.innerHTML=`<tr><td colspan="6" class="empty">Nenhum registro.</td></tr>`;
      return;
    }
    tbody.innerHTML = sRows.map(r => {
      const escNome = r.nome.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
      const escSec  = r.sector.replace(/'/g,"\\'");
      const hasExc  = r.nExc > 0;
      return `<tr>
        <td style="font-weight:500;max-width:260px">${r.nome}
          ${hasExc ? `<span style="font-size:10px;color:var(--danger);margin-left:6px">(${r.nExc} excluído${r.nExc>1?'s':''})</span>` : ''}
        </td>
        <td style="font-family:var(--mono);color:var(--muted)">${r.nTotal}</td>
        <td style="font-family:var(--mono);color:var(--accent2)">${r.n > 0 ? fmt(r.min) : '—'}</td>
        <td style="font-family:var(--mono);color:var(--accent);font-weight:600">${r.n > 0 ? fmt(r.avg) : '<span style="color:var(--muted)">—</span>'}</td>
        <td style="font-family:var(--mono);color:var(--warn)">${r.n > 0 ? fmt(r.max) : '—'}</td>
        <td>
          <button class="tbtn" onclick="abrirModeloDetalhes('${escNome}','${escSec}')"
            style="font-size:10px;padding:3px 10px;white-space:nowrap">
            🔍 Ver SELBs
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  renderSetorModelo('MONTAGEM',  'var(--mont)', 'chart-modelo-mont', 'modelo-mont-kpi', 'modelo-mont-body', 'modelo-mont-label');
  renderSetorModelo('LIMPEZA',   'var(--limp)', 'chart-modelo-limp', 'modelo-limp-kpi', 'modelo-limp-body', 'modelo-limp-label');
  renderSetorModelo('COMPLEXA',  'var(--comp)', 'chart-modelo-comp', 'modelo-comp-kpi', 'modelo-comp-body', 'modelo-comp-label');
  renderSetorModelo('ELETRÔNICA','var(--elet)', 'chart-modelo-elet', 'modelo-elet-kpi', 'modelo-elet-body', 'modelo-elet-label');
}

// ════════════════════════════════════════
// RELATÓRIO MENSAL
// Lê todos os dias do mês diretamente do Firebase (/history/dateKey)
// ════════════════════════════════════════
let mensalSector  = '';
let _mensalData   = null; // cached loaded month data { monthKey, days: {dateKey: records[]} }
let chartMensalDaily  = null;
let chartMensalStatus = null;

// Populate month selector with available months (current + past 11)
function initMensalSelect(){
  const sel = document.getElementById('mensal-month');
  if(sel.options.length > 0) return; // already populated
  const now = new Date();
  for(let i = 0; i < 12; i++){
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    const lbl = d.toLocaleDateString('pt-BR', {month:'long', year:'numeric'});
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = lbl.charAt(0).toUpperCase()+lbl.slice(1);
    sel.appendChild(opt);
  }
}

function setMensalSector(f, btn){
  mensalSector = f;
  document.getElementById('mensal-sector-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f ? 'a-'+sc(f) : 'a-all');
  renderMensalRel();
}

// Build list of dateKeys for a given YYYY-MM
function getDaysInMonth(yearMonth){
  const [y, m] = yearMonth.split('-').map(Number);
  const days = [];
  const daysInMonth = new Date(y, m, 0).getDate();
  for(let d = 1; d <= daysInMonth; d++){
    const date = new Date(y, m-1, d);
    // Firebase stores dateKeys as JS toDateString().replace(/ /g,'_')
    days.push(date.toDateString().replace(/ /g,'_'));
  }
  return days;
}

async function loadMensalData(yearMonth){
  const loading = document.getElementById('mensal-loading');
  loading.style.display = 'block';

  const days    = getDaysInMonth(yearMonth);
  const result  = { monthKey: yearMonth, days: {} };

  // Load all days in parallel (capped at 5 concurrent to avoid rate limits)
  const BATCH = 5;
  for(let i = 0; i < days.length; i += BATCH){
    const batch = days.slice(i, i+BATCH);
    await Promise.all(batch.map(async dk => {
      try {
        const data = await dbGet('/history/'+dk);
        if(data){
          result.days[dk] = Object.entries(data)
            .map(([k,v]) => ({...v, _docId:k, _dateKey:dk}));
        }
      } catch(e){ /* day has no data */ }
    }));
  }

  loading.style.display = 'none';
  return result;
}

async function renderMensalRel(){
  const sel       = document.getElementById('mensal-month');
  const yearMonth = sel.value;
  if(!yearMonth) return;

  // Sempre recarrega para refletir novos registros do mês
  _mensalData = await loadMensalData(yearMonth);

  // Garante que cada registro pertence ao mês selecionado (do dia 1 ao último dia)
  const [yNum, mNum] = yearMonth.split('-').map(Number);
  const inMonth = (h) => {
    let d = null;
    if(h.endEpoch)        d = new Date(h.endEpoch);
    else if(h.startEpoch) d = new Date(h.startEpoch);
    else if(h._dateKey){
      // _dateKey ex.: "Fri_May_01_2026"
      const parts = h._dateKey.split('_');
      const monthIdx = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(parts[1]);
      if(monthIdx >= 0) d = new Date(Number(parts[3]), monthIdx, Number(parts[2]));
    }
    if(!d || isNaN(d)) return false;
    return d.getFullYear() === yNum && (d.getMonth()+1) === mNum;
  };
  // Filtra os dias carregados restringindo ao mês
  for(const dk of Object.keys(_mensalData.days)){
    _mensalData.days[dk] = (_mensalData.days[dk]||[]).filter(inMonth);
  }

  // Flatten all records
  let allRecs = Object.values(_mensalData.days).flat();
  if(mensalSector) allRecs = allRecs.filter(h => h.sector === mensalSector);

  // Filter useful statuses
  const finished = allRecs.filter(h => h.status==='ok'||h.status==='rep'||h.status==='scrap');
  const reproved = allRecs.filter(h => h.status==='rep');
  const scrapped = allRecs.filter(h => h.status==='scrap');

  // Aprovadas = SELBs únicos globais com status ok (sem duplicar SELB)
  const approvedUniqSelbs = new Set(allRecs.filter(h=>h.status==='ok'&&h.selb).map(h=>h.selb));
  const approvedCount = approvedUniqSelbs.size;

  // Active days = days with at least one finished record
  const activeDays = Object.values(_mensalData.days)
    .filter(recs => {
      const f = mensalSector ? recs.filter(h=>h.sector===mensalSector) : recs;
      return f.some(h => h.status==='ok'||h.status==='rep'||h.status==='scrap');
    }).length;

  // KPIs
  document.getElementById('mensal-kpi').innerHTML = `
    <div class="sum-card"><div class="slbl">Dias trabalhados</div><div class="sval" style="color:var(--accent)">${activeDays}</div></div>
    <div class="sum-card"><div class="slbl">Total concluídas</div><div class="sval" style="color:var(--accent2)">${finished.length}</div></div>
    <div class="sum-card"><div class="slbl">Aprovadas</div><div class="sval" style="color:var(--accent2)">${approvedCount}</div></div>
    <div class="sum-card"><div class="slbl">Reprovadas</div><div class="sval" style="color:var(--danger)">${reproved.length}</div></div>
    <div class="sum-card"><div class="slbl">SCRAP</div><div class="sval" style="color:var(--purple)">${scrapped.length}</div></div>`;

  // Build per-day arrays sorted chronologically
  const days = getDaysInMonth(yearMonth);
  const dayLabels = days.map(dk => {
    const parts = dk.replace(/_/g,' ').split(' '); // "Wed Mar 18 2026"
    return parts[2]+'/'+String(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(parts[1])+1).padStart(2,'0');
  });
  const dayFinished = days.map(dk => {
    const recs = (_mensalData.days[dk]||[]).filter(h => mensalSector ? h.sector===mensalSector : true);
    return recs.filter(h=>h.status==='ok'||h.status==='rep'||h.status==='scrap').length;
  });
  const dayOk   = days.map(dk => (_mensalData.days[dk]||[]).filter(h=>(mensalSector?h.sector===mensalSector:true)&&h.status==='ok').length);
  const dayRep  = days.map(dk => (_mensalData.days[dk]||[]).filter(h=>(mensalSector?h.sector===mensalSector:true)&&h.status==='rep').length);
  const dayScp  = days.map(dk => (_mensalData.days[dk]||[]).filter(h=>(mensalSector?h.sector===mensalSector:true)&&h.status==='scrap').length);
  const dayRun  = days.map(dk => (_mensalData.days[dk]||[]).filter(h=>(mensalSector?h.sector===mensalSector:true)&&h.status==='running').length);

  // Charts
  const clr = { grid:'rgba(255,255,255,0.07)', text:'#7a83a0' };
  const baseOpts = {
    responsive:true,
    plugins:{ legend:{ labels:{ color:clr.text, font:{size:11}, boxWidth:12 } } },
    scales:{
      x:{ ticks:{ color:clr.text, font:{size:9}, maxRotation:45 }, grid:{ color:clr.grid } },
      y:{ ticks:{ color:clr.text, font:{size:10} }, grid:{ color:clr.grid } }
    }
  };

  if(chartMensalDaily) chartMensalDaily.destroy();
  chartMensalDaily = new Chart(document.getElementById('chart-mensal-daily'),{
    type:'bar',
    data:{ labels:dayLabels, datasets:[
      { label:'Concluídas', data:dayFinished, backgroundColor:'rgba(79,142,247,0.8)', borderRadius:3 }
    ]},
    options:{...baseOpts}
  });

  if(chartMensalStatus) chartMensalStatus.destroy();
  chartMensalStatus = new Chart(document.getElementById('chart-mensal-status'),{
    type:'bar',
    data:{ labels:dayLabels, datasets:[
      { label:'Aprovadas', data:dayOk,  backgroundColor:'rgba(61,214,140,0.8)',  borderRadius:3, stack:'s' },
      { label:'Reprovadas',data:dayRep, backgroundColor:'rgba(242,87,87,0.8)',   borderRadius:3, stack:'s' },
      { label:'SCRAP',     data:dayScp, backgroundColor:'rgba(167,139,250,0.8)', borderRadius:3, stack:'s' }
    ]},
    options:{...baseOpts, scales:{...baseOpts.scales, x:{...baseOpts.scales.x,stacked:true}, y:{...baseOpts.scales.y,stacked:true}}}
  });

  // Per-user summary — aprovadas sem duplicar SELB
  const byUser = {};
  finished.forEach(h => {
    if(!byUser[h.name]) byUser[h.name] = {
      name:h.name, sector:h.sector, daysSet:new Set(),
      total:0, ok:0, rep:0, scrap:0,
      perDay:{},        // total por dia (qualquer status)
      okSelbsGlobal: new Set(),  // SELBs únicos aprovados (global)
      okSelbsPerDay: {}          // SELBs únicos aprovados por dia
    };
    const u = byUser[h.name];
    u.total++; u.sector=h.sector;
    if(h.status==='rep')   u.rep++;
    if(h.status==='scrap') u.scrap++;
    if(h.status==='ok' && h.selb){
      if(!u.okSelbsGlobal.has(h.selb)){
        u.okSelbsGlobal.add(h.selb);
        u.ok++;
      }
      // Por dia: conta SELB único por dia
      if(!u.okSelbsPerDay[h._dateKey]) u.okSelbsPerDay[h._dateKey] = new Set();
      u.okSelbsPerDay[h._dateKey].add(h.selb);
    }
    u.daysSet.add(h._dateKey);
    u.perDay[h._dateKey] = (u.perDay[h._dateKey]||0)+1;
  });

  const userRows = Object.values(byUser).sort((a,b)=>b.total-a.total);
  const mensalBody = document.getElementById('mensal-body');
  if(!userRows.length){
    mensalBody.innerHTML=`<tr><td colspan="9" class="empty">Nenhum dado encontrado para este período.</td></tr>`;
  } else {
    const _colValMensal = (u, col) => {
      const dayCount = u.daysSet.size;
      const okPerDayCounts = Object.values(u.okSelbsPerDay||{}).map(s=>s.size);
      const melhorAprov = okPerDayCounts.length > 0 ? Math.max(...okPerDayCounts) : 0;
      const mediaAprov  = dayCount > 0 ? u.ok / dayCount : 0;
      if(col==='name')   return u.name.toLowerCase();
      if(col==='sector') return u.sector.toLowerCase();
      if(col==='dias')   return dayCount;
      if(col==='total')  return u.total;
      if(col==='aprov')  return u.ok;
      if(col==='reprov') return u.rep;
      if(col==='scrap')  return u.scrap;
      if(col==='media')  return mediaAprov;
      if(col==='melhor') return melhorAprov;
      return 0;
    };
    const sortedUsers = [...userRows].sort((a,b)=>{
      const va = _colValMensal(a, _mensalSort.col);
      const vb = _colValMensal(b, _mensalSort.col);
      if(typeof va==='string') return _mensalSort.dir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return _mensalSort.dir==='asc' ? va-vb : vb-va;
    });
    _applySortIndicators('mensal-thead', _mensalSort.col, _mensalSort.dir);
    mensalBody.innerHTML = sortedUsers.map(u => {
      const days = u.daysSet.size;
      const okPerDayCounts = Object.values(u.okSelbsPerDay||{}).map(s=>s.size);
      const avg  = days > 0 ? (u.ok / days).toFixed(1) : '—';
      const best = okPerDayCounts.length > 0 ? Math.max(...okPerDayCounts) : 0;
      return `<tr>
        <td style="font-weight:500">${u.name}</td>
        <td><span class="stag stag-${sc(u.sector)}">${u.sector}</span></td>
        <td style="font-family:var(--mono);color:var(--muted)">${days}</td>
        <td style="font-family:var(--mono);color:var(--accent2);font-weight:600">${u.total}</td>
        <td style="font-family:var(--mono);color:var(--accent2)">${u.ok}</td>
        <td style="font-family:var(--mono);color:var(--danger)">${u.rep}</td>
        <td style="font-family:var(--mono);color:var(--purple)">${u.scrap}</td>
        <td style="font-family:var(--mono);color:var(--warn)">${avg}</td>
        <td style="font-family:var(--mono);color:var(--accent)">${best}</td>
      </tr>`;
    }).join('');
  }

  // Daily breakdown
  const dailyBody = document.getElementById('mensal-daily-body');
  const activeDaysData = days.filter(dk => dayFinished[days.indexOf(dk)] > 0 || dayRun[days.indexOf(dk)] > 0);
  if(!activeDaysData.length){
    dailyBody.innerHTML=`<tr><td colspan="6" class="empty">Nenhum registro neste mês.</td></tr>`;
  } else {
    dailyBody.innerHTML = days
      .map((dk, i) => ({ dk, i }))
      .filter(({i}) => dayFinished[i]>0||dayRun[i]>0)
      .reverse() // most recent first
      .map(({dk, i}) => {
        const dateStr = dk.replace(/_/g,' ');
        const d = new Date(dateStr);
        const label = d.toLocaleDateString('pt-BR',{weekday:'short',day:'2-digit',month:'2-digit'});
        return `<tr>
          <td style="font-weight:500">${label}</td>
          <td style="font-family:var(--mono);color:var(--accent2)">${dayFinished[i]}</td>
          <td style="font-family:var(--mono);color:var(--accent2)">${dayOk[i]}</td>
          <td style="font-family:var(--mono);color:var(--danger)">${dayRep[i]}</td>
          <td style="font-family:var(--mono);color:var(--purple)">${dayScp[i]}</td>
          <td style="font-family:var(--mono);color:var(--muted)">${dayRun[i]}</td>
        </tr>`;
      }).join('');
  }
}

function setRelFilter(f,btn){
  relFilter=f;
  document.getElementById('rel-tabs').querySelectorAll('.stab').forEach(b=>b.className='stab');
  if(btn) btn.classList.add(f?'a-'+sc(f):'a-all');
  renderRelatorios();
}

function renderRelatorios(){
  const list=users.filter(u=>u.active&&(!relFilter||u.sector===relFilter));

  // Usa _relHistoryCache se disponível (filtro por data), senão usa history[] (hoje)
  const src = _relHistoryCache !== null ? _relHistoryCache : history;

  // Define se aplica deduplicação de SELB (só para períodos >= 30 dias)
  const fromVal = document.getElementById('rel-date-from')?.value || '';
  const toVal   = document.getElementById('rel-date-to')?.value   || '';
  window._relDeduplicarActive = false;
  if(_globalDatePreset === 'month' || _globalDatePreset === 'all'){
    window._relDeduplicarActive = true;
  } else if(_globalDatePreset === 'custom' && fromVal && toVal){
    const diffMs = new Date(toVal) - new Date(fromVal);
    window._relDeduplicarActive = diffMs >= 29 * 86400000; // >= 29 dias
  }

  // Funções auxiliares que respeitam a fonte de dados selecionada
  function getApproved(uid){
    const recs = src.filter(h=>h.uid===uid&&h.status==='ok'&&h.selb);
    if(window._relDeduplicarActive) return new Set(recs.map(h=>h.selb)).size;
    return recs.length;
  }
  function getReprov(uid)  { return src.filter(h=>h.uid===uid&&h.status==='rep').length; }
  function getScrap(uid)   { return src.filter(h=>h.uid===uid&&h.status==='scrap').length; }
  function getTotalSrc(uid){
    const recs = src.filter(h=>h.uid===uid&&h.status==='ok'&&h.selb);
    if(window._relDeduplicarActive) return new Set(recs.map(h=>h.selb)).size;
    return recs.length;
  }

  // Tempo ativo: soma durações líquidas (sem duplicar SELB quando deduplicar ativo)
  function getActiveSecSrc(uid){
    const vistos = new Set();
    return src.filter(h=>{
      if(h.uid!==uid||h.status!=='ok'||!h.selb) return false;
      if(window._relDeduplicarActive && vistos.has(h.selb)) return false;
      vistos.add(h.selb);
      return true;
    }).reduce((acc,h)=>acc+calcDuracaoLiquida(h),0);
  }

  // Tempo ocioso: calculado a partir dos registros da fonte (com pausas descontadas)
  function getIdleSecSrc(uid){
    const recs = src
      .filter(h => h.uid===uid && h.startEpoch && ['ok','rep','scrap'].includes(h.status))
      .sort((a,b)=>(a.startEpoch||0)-(b.startEpoch||0));
    if(!recs.length) return 0;
    function endToEpoch(r){
      if(!r.end||!r.startEpoch) return null;
      const p=r.end.split(':').map(Number);
      const d=new Date(r.startEpoch); d.setHours(p[0],p[1],p[2]||0,0);
      if(d.getTime()<r.startEpoch) d.setDate(d.getDate()+1);
      return d.getTime();
    }
    function pausasMs(s,e){
      if(s>=e) return 0;
      let t=0;
      const base=new Date(s); base.setHours(0,0,0,0); const bMs=base.getTime();
      for(const b of SCHEDULE.breaks){
        const bs=bMs+(b.start[0]*60+b.start[1])*60000;
        const be=bMs+(b.end[0]*60+b.end[1])*60000;
        t+=Math.max(0,Math.min(e,be)-Math.max(s,bs));
      }
      return t;
    }
    let idleMs=0;
    // Agrupa por dia para calcular ociosidade por dia separadamente
    const byDay={};
    recs.forEach(r=>{
      const dk=r._dateKey||new Date(r.startEpoch).toDateString().replace(/ /g,'_');
      if(!byDay[dk]) byDay[dk]=[];
      byDay[dk].push(r);
    });
    Object.values(byDay).forEach(dayRecs=>{
      dayRecs.sort((a,b)=>(a.startEpoch||0)-(b.startEpoch||0));
      for(let i=0;i<dayRecs.length;i++){
        const r=dayRecs[i];
        const rEnd=endToEpoch(r); if(!rEnd) continue;
        if(i<dayRecs.length-1){
          const next=dayRecs[i+1];
          const gap=next.startEpoch-rEnd;
          if(gap>0) idleMs+=Math.max(0,gap-pausasMs(rEnd,next.startEpoch));
        }
      }
    });
    return Math.max(0,Math.floor(idleMs/1000));
  }

  // Calcula nº de dias únicos no período para base da eficiência
  const _diasUnicos = new Set(src.map(h=>h._dateKey||'')).size || 1;
  const _baseSec = _diasUnicos * 28800; // 8h por dia

  const stats=list.map(u=>{
    const approved  = getApproved(u.id);
    const reprov    = getReprov(u.id);
    const scrap     = getScrap(u.id);
    const totalDia  = getTotalSrc(u.id);
    const activeSec = getActiveSecSrc(u.id);
    const eff       = _baseSec > 0 ? Math.min(100, Math.round((activeSec/_baseSec)*100)) : 0;
    // Dias únicos em que o usuário teve ao menos 1 registro aprovado ou aguardando peça
    const diasTrab  = new Set(
      src.filter(h => h.uid === u.id && ['ok','aguardando'].includes(h.status))
         .map(h => h._dateKey)
    ).size;
    // Aprovadas por dia (com ou sem deduplicação conforme período)
    const okPorDia = {};
    src.filter(h => h.uid===u.id && h.status==='ok' && h.selb).forEach(h => {
      if(!okPorDia[h._dateKey]) okPorDia[h._dateKey] = { set: new Set(), count: 0 };
      okPorDia[h._dateKey].set.add(h.selb);
      okPorDia[h._dateKey].count++;
    });
    const okPorDiaCounts = Object.values(okPorDia).map(d => window._relDeduplicarActive ? d.set.size : d.count);
    const media  = diasTrab > 0 ? (approved / diasTrab) : 0;
    const melhor = okPorDiaCounts.length > 0 ? Math.max(...okPorDiaCounts) : 0;
    return {u, approved, reprov, scrap, totalDia, activeSec, eff, diasTrab, media, melhor};
  });

  // KPIs
  const totMaq    = stats.reduce((a,s)=>a+s.totalDia,0);
  const totAtivo  = stats.reduce((a,s)=>a+s.activeSec,0);
  const avgEff    = calcAverage(stats, s => s.eff);
  // Total aprovadas (deduplicado ou não conforme período)
  const totAprov  = window._relDeduplicarActive
    ? new Set(src.filter(h=>h.status==='ok'&&h.selb).map(h=>h.selb)).size
    : src.filter(h=>h.status==='ok').length;
  const totReprov = stats.reduce((a,s)=>a+s.reprov,0);
  const totScrap  = stats.reduce((a,s)=>a+s.scrap,0);
  document.getElementById('rel-kpi').innerHTML=`
    <div class="sum-card"><div class="slbl">✅ Aprovadas</div><div class="sval" style="color:var(--accent2)">${totAprov}</div></div>
    <div class="sum-card"><div class="slbl">❌ Reprovadas</div><div class="sval" style="color:var(--danger)">${totReprov}</div></div>
    <div class="sum-card"><div class="slbl">🗑️ SCRAP</div><div class="sval" style="color:var(--purple)">${totScrap}</div></div>`;

  // Renderizar checkboxes de seleção de profissionais
  const checksDiv = document.getElementById('rel-prof-checks');
  if(checksDiv){
    // Preserva seleção atual
    const prevSelected = new Set(_relSelectedUids);
    checksDiv.innerHTML = stats.map(s => {
      const isChecked = prevSelected.size === 0 || prevSelected.has(s.u.id);
      const cor = s.u.sector==='MONTAGEM'?'var(--mont)':s.u.sector==='LIMPEZA'?'var(--limp)':'var(--comp)';
      return `<label style="display:flex;align-items:center;gap:6px;background:var(--bg3);
        border:1px solid var(--border);border-radius:8px;padding:5px 10px;cursor:pointer;
        font-size:12px;user-select:none;transition:border-color .15s"
        onmouseover="this.style.borderColor='${cor}'" onmouseout="this.style.borderColor='var(--border)'">
        <input type="checkbox" data-uid="${s.u.id}" ${isChecked?'checked':''} 
          onchange="relAtualizarSelecao()" style="accent-color:${cor};cursor:pointer">
        <span style="color:var(--text)">${s.u.name.split(' ')[0]}</span>
        <span style="font-size:10px;color:${cor}">${s.u.sector.slice(0,4)}</span>
      </label>`;
    }).join('');
    // Atualiza _relSelectedUids com estado atual dos checkboxes
    _relSelectedUids.clear();
    checksDiv.querySelectorAll('input[type=checkbox]').forEach(cb=>{
      if(cb.checked) _relSelectedUids.add(cb.dataset.uid);
    });
  }

  // Popular o seletor de data específico do gráfico de linhas
  const pureDateSel = document.getElementById('rel-pure-date-filter');
  if(pureDateSel){
    const currentVal = pureDateSel.value;
    const days = [...new Set(src.map(h => h._dateKey || new Date(h.ts).toDateString().replace(/ /g,'_')))].sort((a,b)=>new Date(b.replace(/_/g,' ')) - new Date(a.replace(/_/g,' ')));
    pureDateSel.innerHTML = '<option value="">Período Total</option>' + days.map(dk => {
      const d = new Date(dk.replace(/_/g,' '));
      const lbl = d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
      return `<option value="${dk}" ${dk===currentVal?'selected':''}>${lbl}</option>`;
    }).join('');
  }

  // Renderiza gráficos com seleção atual
  window._relStatsCache = stats;
  renderRelGraficos();

  // Detail table
  const tbody=document.getElementById('rel-body');
  if(!stats.length){ tbody.innerHTML=`<tr><td colspan="10" class="empty">Sem dados.</td></tr>`; return; }

  // ── Aplica ordenação ──
  const _colValRel = (s, col) => {
    if(col==='name')     return s.u.name.toLowerCase();
    if(col==='sector')   return s.u.sector.toLowerCase();
    if(col==='totalDia') return s.totalDia;
    if(col==='meta')     return Math.round((s.totalDia/8)*100);
    if(col==='approved') return s.approved;
    if(col==='reprov')   return s.reprov;
    if(col==='scrap')    return s.scrap;
    if(col==='diasTrab') return s.diasTrab;
    if(col==='activeSec')return s.activeSec;
    if(col==='eff')      return s.eff;
    if(col==='media')    return s.media;
    if(col==='melhor')   return s.melhor;
    return 0;
  };
  const sortedStats = [...stats].sort((a,b)=>{
    const va = _colValRel(a, _relSort.col);
    const vb = _colValRel(b, _relSort.col);
    if(typeof va === 'string') return _relSort.dir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
    return _relSort.dir==='asc' ? va-vb : vb-va;
  });
  _applySortIndicators('rel-thead', _relSort.col, _relSort.dir);

  tbody.innerHTML=sortedStats.map(s=>`<tr>
    <td style="font-weight:500">
      <span onclick="openRelProfDetail('${s.u.id}')" style="cursor:pointer;color:var(--accent);text-decoration:underline dotted;text-underline-offset:3px;transition:color .15s" onmouseover="this.style.color='var(--text)'" onmouseout="this.style.color='var(--accent)'">${s.u.name}</span>
    </td>
    <td><span class="stag stag-${sc(s.u.sector)}">${s.u.sector}</span></td>
    <td style="font-family:var(--mono);color:var(--muted)">${s.diasTrab}</td>
    <td style="font-family:var(--mono);color:var(--accent2);font-weight:600">${s.totalDia}</td>
    <td style="font-family:var(--mono);color:var(--accent2)">${s.approved}</td>
    <td style="font-family:var(--mono);color:var(--danger)">${s.reprov}</td>
    <td style="font-family:var(--mono);color:var(--purple)">${s.scrap}</td>
    <td style="font-family:var(--mono);color:var(--warn)">${s.diasTrab>0 ? s.media.toFixed(1) : '—'}</td>
    <td style="font-family:var(--mono);color:var(--accent)">${s.melhor}</td>
  </tr>`).join('');
}


function _getChartColor(i){
  const palette = ['#3DD68C','#A78BFA','#3B82F6','#F59E0B','#EC4899','#06B6D4','#FB923C','#6366F1','#D946EF','#14B8A6','#FACC15','#F87171','#4ADE80','#60A5FA','#F472B6'];
  return palette[i % palette.length];
}

function renderRelGraficos(){
  const stats = window._relStatsCache;
  if(!stats || !stats.length) return;

  // Filtra pelos profissionais selecionados (vazio = todos)
  const filtered = _relSelectedUids.size > 0
    ? stats.filter(s => _relSelectedUids.has(s.u.id))
    : stats;

  if(!filtered.length) return;

  // Ordena crescente por aprovadas (menor → maior) para os gráficos
  // Exclui profissionais sem nenhum registro no período dos gráficos
  const sorted = [...filtered].filter(s => s.totalDia > 0 || s.reprov > 0 || s.scrap > 0).sort((a, b) => a.totalDia - b.totalDia);

  // Resolve nomes duplicados: se dois usuários têm o mesmo primeiro nome, usa nome completo
  const firstNames = sorted.map(s => s.u.name.split(' ')[0]);
  const names = sorted.map((s, i) => {
    const fn = s.u.name.split(' ')[0];
    const isDuplicated = firstNames.filter(n => n === fn).length > 1;
    if(isDuplicated){
      const parts = s.u.name.trim().split(' ');
      return parts.length >= 2 ? parts[0] + ' ' + parts[parts.length-1] : s.u.name;
    }
    return fn;
  });
  const clr = {prod:'rgba(79,142,247,0.85)',ativo:'rgba(61,214,140,0.85)',ocioso:'rgba(245,166,35,0.7)',
               rep:'rgba(242,87,87,0.85)',scrap:'rgba(167,139,250,0.85)',grid:'rgba(255,255,255,0.07)',text:'#7a83a0'};
  const baseOpts = {responsive:true,plugins:{legend:{labels:{color:clr.text,font:{size:11},boxWidth:12}}},
    scales:{x:{ticks:{color:clr.text,font:{size:10}},grid:{color:clr.grid}},
            y:{ticks:{color:clr.text,font:{size:10}},grid:{color:clr.grid}}}};

  // Chart 1: concluídas por profissional
  if(chartProd) chartProd.destroy();
  chartProd = new Chart(document.getElementById('chart-prod'),{
    type:'bar',
    data:{labels:names,datasets:[
      {label:'Aprovadas',data:sorted.map(s=>s.totalDia),backgroundColor:clr.prod,borderRadius:5,borderSkipped:false},
      {label:'Meta (8)',data:sorted.map(()=>8),type:'line',borderColor:'rgba(255,255,255,0.25)',borderDash:[4,4],pointRadius:0,fill:false,tension:0}
    ]},
    options:{...baseOpts,plugins:{...baseOpts.plugins,tooltip:{callbacks:{
      label: ctx => ctx.dataset.label+': '+ctx.parsed.y,
      afterBody: ctx => {
        const s = sorted[ctx[0].dataIndex];
        return s ? [`Dias trabalhados: ${s.diasTrab}d`] : [];
      }
    }}}}
  });

  // Chart 2: Tendência de Produção Diária (Linha)
  if(window.chartTrend) window.chartTrend.destroy();
  
  const src = _relHistoryCache !== null ? _relHistoryCache : history;
  const trendData = {};
  src.forEach(h => {
    if(!['ok','rep','scrap'].includes(h.status)) return;
    const dk = h._dateKey || new Date(h.ts).toDateString().replace(/ /g,'_');
    if(!trendData[dk]) trendData[dk] = { ok:0, rep:0, scrap:0 };
    if(h.status==='ok') trendData[dk].ok++;
    if(h.status==='rep') trendData[dk].rep++;
    if(h.status==='scrap') trendData[dk].scrap++;
  });

  const trendSorted = Object.keys(trendData).sort((a,b) => new Date(a.replace(/_/g,' ')) - new Date(b.replace(/_/g,' ')));
  const trendLabels = trendSorted.map(dk => {
    const d = new Date(dk.replace(/_/g,' '));
    return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'});
  });

  window.chartTrend = new Chart(document.getElementById('chart-trend'),{
    type:'line',
    data:{
      labels: trendLabels,
      datasets:[
        { label:'Aprovadas',  data:trendSorted.map(dk=>trendData[dk].ok),    borderColor:clr.prod,  backgroundColor:clr.prod,  tension:0.3, pointRadius:4, fill:false },
        { label:'Reprovadas', data:trendSorted.map(dk=>trendData[dk].rep),   borderColor:clr.rep,   backgroundColor:clr.rep,   tension:0.3, pointRadius:2, fill:false },
        { label:'SCRAP',      data:trendSorted.map(dk=>trendData[dk].scrap), borderColor:clr.scrap, backgroundColor:clr.scrap, tension:0.3, pointRadius:2, fill:false }
      ]
    },
    options:{
      ...baseOpts,
      interaction:{ intersect:false, mode:'index' },
      plugins:{ ...baseOpts.plugins, tooltip:{ enabled:true } }
    }
  });

  // Chart 3: aprovados vs reprovados vs SCRAP
  if(chartStatus) chartStatus.destroy();
  chartStatus = new Chart(document.getElementById('chart-status'),{
    type:'bar',
    data:{labels:names,datasets:[
      {label:'Aprovados', data:sorted.map(s=>s.approved),backgroundColor:'rgba(61,214,140,0.8)', borderRadius:3,stack:'s'},
      {label:'Reprovados',data:sorted.map(s=>s.reprov),  backgroundColor:'rgba(242,87,87,0.8)',  borderRadius:3,stack:'s'},
      {label:'SCRAP',     data:sorted.map(s=>s.scrap),   backgroundColor:'rgba(167,139,250,0.8)',borderRadius:3,stack:'s'}
    ]},
    options:{...baseOpts,
      scales:{...baseOpts.scales,
        x:{...baseOpts.scales.x,stacked:true},
        y:{...baseOpts.scales.y,stacked:true}}}
  });

  // Chart 4: Produção Individual por Profissional (Multi-linha)
  if(window.chartTrendPure) window.chartTrendPure.destroy();
  
  // Criar um dataset para cada profissional no período
  const datasets = sorted.map((s, i) => {
    const color = _getChartColor(i);
    const dataPoints = trendSorted.map(dk => {
      const dayRecs = src.filter(h => h.uid === s.u.id && h.status === 'ok' && h.selb && (h._dateKey || new Date(h.ts).toDateString().replace(/ /g,'_')) === dk);
      const val = window._relDeduplicarActive ? new Set(dayRecs.map(h => h.selb)).size : dayRecs.length;
      return val > 0 ? val : null; // null = pular ponto no gráfico (não exibir 0)
    });

    return {
      label: s.u.name,
      data: dataPoints,
      borderColor: color,
      backgroundColor: color + '22', // 22 is ~13% opacity
      tension: 0.3,
      pointRadius: 3,
      fill: false
    };
  });

  window.chartTrendPure = new Chart(document.getElementById('chart-trend-pure'),{
    type:'line',
    data:{
      labels: trendLabels,
      datasets: datasets
    },
    options:{
      ...baseOpts,
      spanGaps: false, // null = não conectar dias sem registro
      scales:{
        ...baseOpts.scales,
        y:{ ...baseOpts.scales.y, min:0, ticks:{ stepSize:5 } }
      },
      plugins:{ 
        ...baseOpts.plugins, 
        legend:{ display:false }, // Ocultar legenda para não poluir
        tooltip:{ enabled:true, mode:'index', intersect:false } 
      }
    }
  });
}


// ════════════════════════════════════════
// EQUIPAMENTOS — SELB → Nome do equipamento
// Stored in Firebase at /equipamentos/{selbCode}
// ════════════════════════════════════════
let equipamentos = {}; // { 'SELB-001': 'Impressora HP 1020', ... }
let _equipSeries = {};  // { 'SELB-001': 'X2SR003422', ... }
let _equipSkus   = {};  // { 'SELB-001': 'SKU-001', ... }
let _equipUnitizadores = {}; // { 'SELB-001': 'GAIOLA-01', ... }
let editingEquipKey = null;

async function loadEquipamentos(){
  const [r1, r2, r3, r4] = await Promise.all([
    _supa.from('equipamentos').select('id, raw'),
    _supa.from('equipamentos_series').select('id, raw'),
    _supa.from('equipamentos_skus').select('id, raw'),
    _supa.from('equipamentos_unitizadores').select('id, raw'),
  ]);
  equipamentos = {};
  (r1.data || []).forEach(e => { equipamentos[e.id] = (e.raw && e.raw.nome) ? e.raw.nome : e.id; });
  _equipSeries = {};
  (r2.data || []).forEach(e => { _equipSeries[e.id] = e.raw; });
  _equipSkus = {};
  (r3.data || []).forEach(e => { _equipSkus[e.id] = e.raw; });
  _equipUnitizadores = {};
  (r4.data || []).forEach(e => { _equipUnitizadores[e.id] = e.raw; });
}

// Helper de normalização global para busca tolerante de SELBs
function normalizeSelbCode(code) {
  if (!code) return "";
  return code.toUpperCase().replace(/\s+/g, '').replace(/-/g, '').replace(/^SELB/, '');
}

function getEquipName(selbCode){
  if(!selbCode) return null;
  const upper = selbCode.toUpperCase().trim();
  if (equipamentos[upper]) return equipamentos[upper];
  
  // Busca tolerante via chave normalizada
  const norm = normalizeSelbCode(upper);
  if (!norm) return null;
  
  for (const k of Object.keys(equipamentos)) {
    if (normalizeSelbCode(k) === norm) {
      return equipamentos[k];
    }
  }
  return null;
}

function getEquipSerie(selbCode){
  if(!selbCode) return null;
  const upper = selbCode.toUpperCase().trim();
  if (_equipSeries[upper]) return _equipSeries[upper];
  
  // Busca tolerante via chave normalizada
  const norm = normalizeSelbCode(upper);
  if (!norm) return null;
  
  for (const k of Object.keys(_equipSeries)) {
    if (normalizeSelbCode(k) === norm) {
      return _equipSeries[k];
    }
  }
  return null;
}

function getEquipSku(selbCode){
  if(!selbCode) return null;
  const upper = selbCode.toUpperCase().trim();
  if (_equipSkus[upper]) return _equipSkus[upper];
  
  // Busca tolerante via chave normalizada
  const norm = normalizeSelbCode(upper);
  if (!norm) return null;
  
  for (const k of Object.keys(_equipSkus)) {
    if (normalizeSelbCode(k) === norm) {
      return _equipSkus[k];
    }
  }
  return null;
}

function getEquipUnitizador(selbCode){
  if(!selbCode) return null;
  const upper = selbCode.toUpperCase().trim();
  if (_equipUnitizadores[upper]) return _equipUnitizadores[upper];
  
  const norm = normalizeSelbCode(upper);
  if (!norm) return null;
  
  for (const k of Object.keys(_equipUnitizadores)) {
    if (normalizeSelbCode(k) === norm) {
      return _equipUnitizadores[k];
    }
  }
  return null;
}

// ── Import spreadsheet ────────────────────────────────────────────────────────
async function importEquipFile(input){
  const file = input.files[0];
  if(!file) return;
  const ext = file.name.split('.').pop().toLowerCase();
  showLoader('Importando planilha...');
  try {
    let rows = [];
    if(ext === 'csv'){
      rows = await parseCSV(file);
    } else {
      rows = await parseXLSX(file);
    }
    if(!rows.length){ showError('Nenhum dado encontrado na planilha.'); return; }

    const allHeaders = Object.keys(rows[0]);

    // ── Coluna SELB: procura exatamente "SELB", depois qualquer que contenha "SELB" ──
    const SELB_PRIORITY = ['SELB'];
    const NOME_PRIORITY = ['Produto', 'PRODUTO', 'produto', 'Modelo', 'MODELO', 'modelo'];

    function findCol(priorities, fallbackIncludes){
      // 1st pass: exact match (case-insensitive)
      for(const p of priorities){
        const found = allHeaders.find(h => h.trim().toLowerCase() === p.toLowerCase());
        if(found) return found;
      }
      // 2nd pass: partial match
      for(const inc of fallbackIncludes){
        const found = allHeaders.find(h => h.trim().toUpperCase().includes(inc.toUpperCase()));
        if(found) return found;
      }
      return null;
    }

    const selbColOrig = findCol(SELB_PRIORITY,  ['SELB','COD']);
    const nomeColOrig = findCol(NOME_PRIORITY,   ['PRODUTO','MODELO','EQUIP','NOME','NAME']);

    if(!selbColOrig || !nomeColOrig){
      hideLoader();
      alert(
        'Colunas não encontradas automaticamente.\n\n' +
        'Colunas detectadas na planilha:\n' + allHeaders.join(', ') + '\n\n' +
        'A planilha precisa ter:\n' +
        '  • Coluna SELB  (encontrado: ' + (selbColOrig||'NÃO ENCONTRADO') + ')\n' +
        '  • Coluna Produto / Modelo  (encontrado: ' + (nomeColOrig||'NÃO ENCONTRADO') + ')'
      );
      return;
    }

    // ── Coluna Atributos (número de série) ──
    const SERIE_PRIORITY = ['Atributos', 'ATRIBUTOS', 'atributos'];
    const serieColOrig = findCol(SERIE_PRIORITY, ['ATRIBUTO', 'SERIE', 'SERIAL', 'S/N', 'NSR']);

    // ── Coluna Código do Produto Externo ──
    const SKU_PRIORITY = [
      'Código do Produto Externo', 'Codigo do Produto Externo',
      'CÓDIGO DO PRODUTO EXTERNO', 'CODIGO DO PRODUTO EXTERNO',
      'Cód. Produto Externo', 'Cod. Produto Externo',
      'SKU', 'Sku', 'sku'
    ];
    const skuColOrig = findCol(SKU_PRIORITY, ['EXTERNO', 'COD_PRODUTO', 'CODIGO_PRODUTO', 'SKU', 'PART_NUMBER']);

    // ── Coluna Unitizador ──
    const UNITIZADOR_PRIORITY = ['Unitizador', 'UNITIZADOR', 'unitizador'];
    const unitizadorColOrig = findCol(UNITIZADOR_PRIORITY, ['UNITIZADOR', 'GAIOLA', 'PALETE', 'PALLET', 'LOCAL']);

    let count = 0;
    const batch = {};
    const seriesBatch = {};
    const skusBatch = {};
    const unitizadoresBatch = {};
    rows.forEach(row => {
      const selb  = String(row[selbColOrig]||'').trim().toUpperCase();
      const nome  = String(row[nomeColOrig]||'').trim();
      const serie = serieColOrig ? String(row[serieColOrig]||'').trim() : '';
      const sku   = skuColOrig ? String(row[skuColOrig]||'').trim() : '';
      const unitizador = unitizadorColOrig ? String(row[unitizadorColOrig]||'').trim() : '';
      if(selb && nome){
        batch[selb] = nome;
        if(serie) seriesBatch[selb] = serie;
        if(sku) skusBatch[selb] = sku;
        if(unitizador) unitizadoresBatch[selb] = unitizador;
        count++;
      }
    });

    if(!count){
      hideLoader();
      alert('Nenhuma linha válida encontrada.\nVerifique se as colunas "' + selbColOrig + '" e "' + nomeColOrig + '" têm dados.');
      return;
    }

    // Replace all (fresh import from system spreadsheet)
    await _supa.from('equipamentos').delete().neq('id', '___never___');
    const eqRows = Object.entries(batch).map(([id, nome]) => ({ id, nome: String(nome), raw: { nome: String(nome) } }));
    await _supa.from('equipamentos').upsert(eqRows);
    equipamentos = {...batch};

    // Salva séries separadamente (não apaga se não encontrou a coluna)
    if(Object.keys(seriesBatch).length > 0){
      await _supa.from('equipamentos_series').delete().neq('id', '___never___');
      const srRows = Object.entries(seriesBatch).map(([id, v]) => ({ id, raw: typeof v === 'object' ? v : { serie: v } }));
      await _supa.from('equipamentos_series').upsert(srRows);
      _equipSeries = {...seriesBatch};
    }

    // Salva skus separadamente (não apaga se não encontrou a coluna)
    if(Object.keys(skusBatch).length > 0){
      await _supa.from('equipamentos_skus').delete().neq('id', '___never___');
      const skRows = Object.entries(skusBatch).map(([id, v]) => ({ id, raw: typeof v === 'object' ? v : { sku: v } }));
      await _supa.from('equipamentos_skus').upsert(skRows);
      _equipSkus = {...skusBatch};
    }

    // Salva unitizadores separadamente
    if(Object.keys(unitizadoresBatch).length > 0){
      await _supa.from('equipamentos_unitizadores').delete().neq('id', '___never___');
      const unRows = Object.entries(unitizadoresBatch).map(([id, v]) => ({ id, raw: typeof v === 'object' ? v : { unitizador: v } }));
      await _supa.from('equipamentos_unitizadores').upsert(unRows);
      _equipUnitizadores = {...unitizadoresBatch};
    }

    hideLoader();
    input.value = '';
    renderEquipTable();
    const serieMsg = serieColOrig ? '\nColuna Série (Atributos): "' + serieColOrig + '" — ' + Object.keys(seriesBatch).length + ' séries importadas' : '\n⚠️ Coluna de série (Atributos) não encontrada';
    const skuMsg = skuColOrig ? '\nCódigo do Produto Externo: "' + skuColOrig + '" — ' + Object.keys(skusBatch).length + ' códigos importados' : '\n⚠️ Coluna Código do Produto Externo não encontrada';
    const unitMsg = unitizadorColOrig ? '\nColuna Unitizador: "' + unitizadorColOrig + '" — ' + Object.keys(unitizadoresBatch).length + ' unitizadores importados' : '\n⚠️ Coluna Unitizador não encontrada';
    alert('✅ ' + count + ' equipamentos importados!\n\nColuna SELB: "' + selbColOrig + '"\nColuna Modelo: "' + nomeColOrig + '"' + serieMsg + skuMsg + unitMsg);
    // Re-renderiza bolsões do FluxoLAB para atualizar badges ⚠️ de SELBs não reconhecidos
    if (typeof _fluxolabRenderGrid === 'function') try { _fluxolabRenderGrid(); } catch(e) {}
  } catch(e){
    showError('Erro ao importar: ' + e.message);
  }
}

async function parseCSV(file){
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => {
      const lines = e.target.result.split(/\r?\n/).filter(l => l.trim());
      if(!lines.length){ res([]); return; }
      const headers = lines[0].split(/[,;\t]/);
      const rows = lines.slice(1).map(line => {
        const vals = line.split(/[,;\t]/);
        const obj = {};
        headers.forEach((h,i) => obj[h.trim()] = (vals[i]||'').trim());
        return obj;
      });
      res(rows);
    };
    reader.onerror = rej;
    reader.readAsText(file, 'utf-8');
  });
}

async function parseXLSX(file){
  // Load SheetJS from CDN if not loaded
  if(typeof XLSX === 'undefined'){
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, {type:'array'});
        // Busca a melhor aba: prioriza a aba que contém a palavra "SELB" em seus cabeçalhos
        let bestSheetName = wb.SheetNames[0];
        for(const name of wb.SheetNames){
          const tempWs = wb.Sheets[name];
          const tempRows = XLSX.utils.sheet_to_json(tempWs, {defval:'', header:1});
          if(tempRows.length > 0 && Array.isArray(tempRows[0])){
            const headers = tempRows[0].map(h => String(h || '').trim().toUpperCase());
            if(headers.includes('SELB') || headers.some(h => h.includes('SELB'))){
              bestSheetName = name;
              break;
            }
          }
        }
        const ws = wb.Sheets[bestSheetName];
        const rows = XLSX.utils.sheet_to_json(ws, {defval:''});
        res(rows);
      } catch(err){ rej(err); }
    };
    reader.onerror = rej;
    reader.readAsArrayBuffer(file);
  });
}

// ── Render equipamentos table ─────────────────────────────────────────────────
function renderEquipTable(){
  const q = (document.getElementById('equip-search')?.value||'').toUpperCase();
  const entries = Object.entries(equipamentos)
    .filter(([k,v]) => !q || k.includes(q) || v.toUpperCase().includes(q) || (getEquipSerie(k) || '').toUpperCase().includes(q) || (getEquipSku(k) || '').toUpperCase().includes(q) || (getEquipUnitizador(k) || '').toUpperCase().includes(q))
    .sort((a,b) => a[0].localeCompare(b[0]));

  // Stats
  const total = Object.keys(equipamentos).length;
  document.getElementById('equip-stats').innerHTML = `
    <div class="sum-card" style="padding:10px 16px">
      <div class="slbl">Total cadastrado</div>
      <div class="sval" style="color:var(--accent);font-size:18px">${total}</div>
    </div>
    <div class="sum-card" style="padding:10px 16px">
      <div class="slbl">Exibindo</div>
      <div class="sval" style="color:var(--muted);font-size:18px">${entries.length}</div>
    </div>`;

  const tbody = document.getElementById('equip-body');
  if(!entries.length){
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${total===0?'Nenhum equipamento cadastrado. Importe uma planilha para começar.':'Nenhum resultado para a busca.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map(([selb, nome]) => {
    const selbEsc = selb.replace(/'/g, "\\'");
    const nomeEsc = (nome||'').replace(/'/g, "\\'");
    return `<tr>
    <td><span class="pinbadge" style="font-size:12px">${selb}</span></td>
    <td style="font-weight:500">${nome}</td>
    <td style="font-family:var(--mono);font-size:12px">${getEquipSerie(selb) || '—'}</td>
    <td style="font-family:var(--mono);font-size:12px">${getEquipSku(selb) || '—'}</td>
    <td><span class="pinbadge" style="background:rgba(167,139,250,0.1);color:var(--purple);border:1px solid rgba(167,139,250,0.3);font-size:11px">${getEquipUnitizador(selb) || '—'}</span></td>
    <td>
      <button onclick="qualGerarEtiquetaUnica('${selbEsc}')" title="Gerar etiqueta" style="background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.4);border-radius:7px;color:var(--purple);font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">🏷️ Etiqueta</button>
    </td>
    <td><div class="tbl-acts">
      <button class="tbtn" onclick="openEditEquip('${selbEsc}')">Editar</button>
      <button class="tbtn" onclick="registrarEquipamentoPerdido('${selbEsc}', '${nomeEsc}')" style="background:rgba(242,87,87,.10);border-color:rgba(242,87,87,.3);color:var(--danger)" title="Registrar como máquina perdida">🔍 Perdida</button>
      <button class="tbtn del" onclick="deleteEquip('${selbEsc}')">Remover</button>
    </div></td>
  </tr>`;
  }).join('');
}

function openNewEquip(){
  editingEquipKey = null;
  document.getElementById('meq-title').textContent = 'Novo Equipamento';
  document.getElementById('meq-selb').value = '';
  document.getElementById('meq-nome').value = '';
  document.getElementById('meq-serie').value = '';
  document.getElementById('meq-sku').value = '';
  const uEl = document.getElementById('meq-unitizador'); if(uEl) uEl.value = '';
  document.getElementById('meq-err').textContent = '';
  document.getElementById('meq-selb').removeAttribute('readonly');
  document.getElementById('modal-equip').classList.remove('hidden');
  setTimeout(() => document.getElementById('meq-selb').focus(), 100);
}
function openEditEquip(selb){
  editingEquipKey = selb;
  document.getElementById('meq-title').textContent = 'Editar Equipamento';
  document.getElementById('meq-selb').value  = selb;
  document.getElementById('meq-nome').value  = equipamentos[selb] || '';
  document.getElementById('meq-serie').value = getEquipSerie(selb) || '';
  document.getElementById('meq-sku').value   = getEquipSku(selb) || '';
  const uEl = document.getElementById('meq-unitizador'); if(uEl) uEl.value = getEquipUnitizador(selb) || '';
  document.getElementById('meq-err').textContent = '';
  document.getElementById('modal-equip').classList.remove('hidden');
  setTimeout(() => document.getElementById('meq-nome').focus(), 100);
}

async function saveEquipamento(){
  const selb       = document.getElementById('meq-selb').value.trim().toUpperCase();
  const nome       = document.getElementById('meq-nome').value.trim();
  const serie      = document.getElementById('meq-serie').value.trim();
  const sku        = document.getElementById('meq-sku').value.trim();
  const unitizador = (document.getElementById('meq-unitizador')?.value || '').trim();
  const err        = document.getElementById('meq-err');
  if(!selb){ err.textContent='Informe o código SELB.'; return; }
  if(!nome){ err.textContent='Informe o nome do equipamento.'; return; }
  // If key changed, remove old
  if(editingEquipKey && editingEquipKey !== selb){
    await _supa.from('equipamentos').delete().eq('id', editingEquipKey);
    delete equipamentos[editingEquipKey];
    await _supa.from('equipamentos_series').delete().eq('id', editingEquipKey);
    delete _equipSeries[editingEquipKey];
    await _supa.from('equipamentos_skus').delete().eq('id', editingEquipKey);
    delete _equipSkus[editingEquipKey];
    await _supa.from('equipamentos_unitizadores').delete().eq('id', editingEquipKey);
    delete _equipUnitizadores[editingEquipKey];
  }
  await _supa.from('equipamentos').upsert({ id: selb, nome, raw: { nome } }, { onConflict: 'id' });
  equipamentos[selb] = nome;

  if(serie){
    await _supa.from('equipamentos_series').upsert({ id: selb, raw: { serie } }, { onConflict: 'id' });
    _equipSeries[selb] = serie;
  } else {
    await _supa.from('equipamentos_series').delete().eq('id', selb);
    delete _equipSeries[selb];
  }

  if(sku){
    await _supa.from('equipamentos_skus').upsert({ id: selb, raw: { sku } }, { onConflict: 'id' });
    _equipSkus[selb] = sku;
  } else {
    await _supa.from('equipamentos_skus').delete().eq('id', selb);
    delete _equipSkus[selb];
  }

  if(unitizador){
    await _supa.from('equipamentos_unitizadores').upsert({ id: selb, raw: { unitizador } }, { onConflict: 'id' });
    _equipUnitizadores[selb] = unitizador;
  } else {
    await _supa.from('equipamentos_unitizadores').delete().eq('id', selb);
    delete _equipUnitizadores[selb];
  }
  
  closeModal('modal-equip');
  renderEquipTable();
}

async function deleteEquip(selb){
  if(!confirm('Remover o equipamento "'+selb+'" — '+equipamentos[selb]+'?')) return;
  await _supa.from('equipamentos').delete().eq('id', selb);
  delete equipamentos[selb];
  await _supa.from('equipamentos_series').delete().eq('id', selb);
  delete _equipSeries[selb];
  await _supa.from('equipamentos_skus').delete().eq('id', selb);
  delete _equipSkus[selb];
  await _supa.from('equipamentos_unitizadores').delete().eq('id', selb);
  delete _equipUnitizadores[selb];
  renderEquipTable();
}

async function clearEquipamentos(){
  if(!confirm('Isso vai remover TODOS os equipamentos cadastrados. Confirmar?')) return;
  await _supa.from('equipamentos').delete().neq('id', '___never___');
  await _supa.from('equipamentos_series').delete().neq('id', '___never___');
  await _supa.from('equipamentos_skus').delete().neq('id', '___never___');
  await _supa.from('equipamentos_unitizadores').delete().neq('id', '___never___');
  equipamentos = {};
  _equipSeries = {};
  _equipSkus = {};
  _equipUnitizadores = {};
  renderEquipTable();
}

// ════════════════════════════════════════
// ZERAR DIA
// ════════════════════════════════════════
// ════════════════════════════════════════
// BACKUP AUTOMÁTICO NO FIREBASE
// Salvo em /backups/{dateKey} ao fim do expediente ou antes de zerar tudo.
// Restauração manual via botão "Restaurar" na aba Admin.
// ════════════════════════════════════════
let _autoBackupDone = false; // só faz backup uma vez por dia

async function fazerBackupFirebase(dateKey, motivo){
  try {
    const histData  = await dbGet('/history/'+dateKey);
    const usersData = await dbGet('/users');
    if(!histData) return; // nada para salvar
    const backup = {
      savedAt:   new Date().toISOString(),
      dateKey,
      motivo:    motivo || 'auto',
      history:   histData,
      userCounters: Object.fromEntries(
        Object.entries(usersData||{}).map(([uid,u]) => [uid, {totalDia:u.totalDia||0, repDia:u.repDia||0}])
      )
    };
    await dbSet('/backups/'+dateKey, backup);
    // backup salvo
  } catch(e){
    console.warn('Backup automático falhou:', e.message);
  }
}

// ── Zerar opção 1: apenas SELBs em andamento ──────────────────────────────
async function zerarSelbs(){
  closeModal('modal-zerar');
  showLoader('Parando SELBs em andamento...');
  try {
    const endTime = new Date().toLocaleTimeString('pt-BR');
    // Fecha todos os registros 'running' no histórico — inclui orphans que o wstate não conhece
    const runningHistory = history.filter(x => x.status === 'running');
    for(const h of runningHistory){
      const s = wstate[h.uid] || {};
      let elapsed = s.startEpoch ? Math.max(0, Math.floor((Date.now()-s.startEpoch)/1000)) : 0;
      // Sanidade via horário de relógio
      if(h.start){
        const oStartSec = timeStrToSec(h.start);
        const oEndSec   = timeStrToSec(endTime);
        if(oStartSec !== null && oEndSec !== null){
          let oDiff = oEndSec - oStartSec;
          if(oDiff < 0) oDiff += 86400;
          if(oDiff >= 0 && oDiff < 86400 && Math.abs(elapsed - oDiff) > 60) elapsed = oDiff;
        }
      }
      h.status = 'ok';
      const _endEpoch2   = Date.now();
      const _endDateKey2 = new Date(_endEpoch2).toDateString().replace(/ /g,'_');
      await dbUpdateHistory(h._docId, h._dateKey, {end:endTime, duracao:fmt(elapsed), status:'ok', endEpoch:_endEpoch2, endDateKey:_endDateKey2});
    }
    // Reseta estado ativo de cada usuário afetado (totalDia não é mais mantido no Firebase)
    const activeUsers = users.filter(u => {
      const s = wstate[u.id];
      return s && (s.status === 'running' || s.status === 'paused');
    });
    for(const u of activeUsers){
      await dbPatch('/users/'+u.id, {_selb:null,_status:'idle',_startEpoch:null,_elapsed:null,_pausedElapsed:null,_pausedAt:null,_pauseAccum:0,_frozenElapsed:0,_activeFrom:null});
      if(timers[u.id]){ clearInterval(timers[u.id]); delete timers[u.id]; }
      const s = wstate[u.id];
      s.selb=null; s.status='idle'; s.elapsed=0; s.startEpoch=null;
      s._pausedAt=null; s._pauseAccum=0; s._frozenElapsed=0; s._activeFrom=null;
    }
    hideLoader();
    buildCards(); updateSummary();
    const total = runningHistory.length;
    alert(total ? '✅ '+total+' SELB(s) finalizados como concluído.' : 'Nenhum SELB em andamento.');
  } catch(e){ showError('Erro: '+e.message); }
}

function openZerarDia(){
  document.getElementById('modal-zerar').classList.remove('hidden');
}

async function confirmarZerarDia(){
  // Só permite zerar após o fim do expediente (17:30) ou antes do início (07:30)
  const now = nowMins();
  const workStart = toMins(7,30);
  const workEnd   = toMins(17,30);
  const dentroDoExpediente = now >= workStart && now < workEnd;
  if(dentroDoExpediente){
    alert('⚠️ Não é possível zerar o dia durante o expediente.\n\nEssa operação só está disponível após as 17:30 ou antes das 07:30.');
    closeModal('modal-zerar');
    return;
  }
  closeModal('modal-zerar');
  showLoader('Fazendo backup e zerando o dia...');
  try {
    const dateKey = new Date().toDateString().replace(/ /g,'_');

    // 0. Backup automático antes de zerar — salva snapshot completo no Firebase
    await fazerBackupFirebase(dateKey, 'zerar-dia-manual');

    // 1. Finalizar todos os SELBs em andamento — APENAS fecha os registros abertos
    //    NÃO apaga nada do /history no Firebase
    const running = users.filter(u => {
      const s = wstate[u.id];
      return s && (s.status === 'running' || s.status === 'paused');
    });
    for(const u of running){
      const s = wstate[u.id];
      const h = history.find(x => x.uid===u.id && x.status==='running');
      if(h){
        const endTime    = new Date().toLocaleTimeString('pt-BR');
        const _endEp3    = Date.now();
        const _endDk3    = new Date(_endEp3).toDateString().replace(/ /g,'_');
        const elapsed    = s.startEpoch ? Math.floor((_endEp3-s.startEpoch)/1000) : 0;
        h.status = 'ok'; h.endEpoch = _endEp3; h.endDateKey = _endDk3;
        await dbUpdateHistory(h._docId, h._dateKey, {end:endTime, duracao:fmt(elapsed), status:'ok', endEpoch:_endEp3, endDateKey:_endDk3});
      }
      // Limpa estado ativo — totalDia não é mais mantido no Firebase
      await dbPatch('/users/'+u.id, {
        _selb:null, _status:'idle', _startEpoch:null,
        _elapsed:null, _pausedElapsed:null, _pausedAt:null,
        _frozenElapsed:0, _activeFrom:null, _pauseAccum:0
      });
      if(timers[u.id]){ clearInterval(timers[u.id]); delete timers[u.id]; }
      s.selb=null; s.status='idle'; s.elapsed=0; s.startEpoch=null;
      s._pausedAt=null; s._pauseAccum=0; s._frozenElapsed=0; s._activeFrom=null;
    }

    // 2. Reseta apenas o wstate local (display) — NÃO altera /history nem totalDia no Firebase
    Object.keys(wstate).forEach(uid => {
      wstate[uid] = {
        selb:null, status:'idle', elapsed:0, meta:60,
        activeTotal:0, idleTotal:0,
        idleStart:Date.now(), loginTime:Date.now(),
        _frozenElapsed:0, _activeFrom:null, _pauseAccum:0, _pausedAt:null
      };
    });

    // 3. Grava data do reset no Firebase para evitar reset duplo na virada do dia
    await dbSet('/meta/lastResetDay', new Date().toDateString()).catch(()=>{});
    localStorage.setItem('sb_last_day', new Date().toDateString());
    _autoBackupDone = true;

    // 4. Os dados do /history PERMANECEM no Firebase intactos.
    //    O listener de tempo real já mantém history[] sincronizado — não precisa limpar.
    hideLoader();
    buildCards();
    updateSummary();
    alert('✅ Dia zerado!\n\nOs relatórios e histórico no Firebase foram preservados.\nBackup salvo em /backups/'+dateKey);
  } catch(e){
    showError('Erro ao zerar: '+e.message);
  }
}


function closeModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  if(el.style.display === 'flex' || el.style.display === 'block'){
    el.style.display = 'none';
  } else {
    el.classList.add('hidden');
  }
}

// ════════════════════════════════════════
// SCHEDULE ENGINE
// ════════════════════════════════════════
const SCHEDULE = {
  work:   { start: [7,30],  end: [17,30] },
  breaks: [
    { name:'Café da manhã',  icon:'☕', start:[9,30],  end:[9,45]  },
    { name:'Almoço',         icon:'🍽️', start:[13,0], end:[14,12] },
    { name:'Café da tarde',  icon:'☕', start:[16,0], end:[16,15] },
  ]
};
let scheduleOverride=false; // admin dismissed the overlay manually

/**
 * Calcula segundos líquidos trabalhados entre startMs e endMs,
 * descontando automaticamente:
 *  - tempo fora do expediente (antes de 07:30 e após 17:30)
 *  - breaks programados (café, almoço, etc.)
 * Percorre dia a dia para suportar SELBs que cruzam a meia-noite.
 */
function toMins(h,m){ return h*60+m; }
function nowMins(){
  const n=new Date(); return n.getHours()*60+n.getMinutes();
}
function secsUntil(h,m){
  const n=new Date();
  const target=new Date(n); target.setHours(h,m,0,0);
  if(target<=n) target.setDate(target.getDate()+1);
  return Math.floor((target-n)/1000);
}

function getScheduleState(){
  const now = new Date();
  const day = now.getDay(); // 0 = domingo, 6 = sábado

  // Fim de semana → sistema fora do expediente
  if(day === 0 || day === 6) return {type:'after'};

  const mins = now.getHours()*60 + now.getMinutes();
  const ws = toMins(...SCHEDULE.work.start), we = toMins(...SCHEDULE.work.end);

  // Verifica intervalos
  for(const b of SCHEDULE.breaks){
    const bs=toMins(...b.start), be=toMins(...b.end);
    if(mins>=bs && mins<be) return {type:'break', break:b};
  }
  if(mins<ws)  return {type:'before'};
  if(mins>=we) return {type:'after'};
  return {type:'work'};
}

function fmtCountdown(sec){
  const m=Math.floor(sec/60), s=sec%60;
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}

let overlayCountdownInterval=null;

async function pauseAllRunning(){
  const now = Date.now();
  const promises = [];
  users.forEach(u=>{
    const s=getS(u.id);
    if(s.status==='running'){
      // Captura o valor atual do timer e congela (líquido)
      s._frozenElapsed  = calcElapsedRunning(u.id);
      s._activeFrom     = null;
      s.status          = 'paused';
      renderCard(u.id);
      promises.push(
        dbPatch('/users/'+u.id, {_status:'paused', _frozenElapsed: s._frozenElapsed, _activeFrom: null}).catch(()=>{})
      );
    }
  });
  await Promise.all(promises);
  updateSummary();
}

async function resumeAllPaused(){
  const now = Date.now();
  const promises = [];
  users.forEach(u=>{
    const s=getS(u.id);
    if(s.status==='paused'){
      // Descongela: marca o instante de retomada, _frozenElapsed preservado
      s._activeFrom  = now;
      s.status       = 'running';
      renderCard(u.id);
      promises.push(
        dbPatch('/users/'+u.id, {_status:'running', _activeFrom: now, _frozenElapsed: s._frozenElapsed||0}).catch(()=>{})
      );
    }
  });
  await Promise.all(promises);
  updateSummary();
}

function showScheduleOverlay(state){
  const ov=document.getElementById('schedule-overlay');
  ov.style.display='flex';
  document.getElementById('sov-admin-btn').style.display=
    (currentUser&&currentUser.isAdmin)?'block':'none';

  const day = new Date().getDay();
  const isWeekend = (day === 0 || day === 6);

  if(isWeekend){
    document.getElementById('sov-icon').textContent='📅';
    document.getElementById('sov-title').textContent='Fim de semana';
    document.getElementById('sov-sub').textContent='O sistema retoma na segunda-feira às 07:30';
    document.getElementById('sov-countdown').textContent='—';
    if(overlayCountdownInterval){ clearInterval(overlayCountdownInterval); overlayCountdownInterval=null; }
  } else if(state.type==='break'){
    document.getElementById('sov-icon').textContent=state.break.icon;
    document.getElementById('sov-title').textContent=state.break.name;
    document.getElementById('sov-sub').textContent=
      'Intervalo: '
      + String(state.break.start[0]).padStart(2,'0') + 'h' + String(state.break.start[1]).padStart(2,'0')
      + ' → retorno às '
      + String(state.break.end[0]).padStart(2,'0') + ':' + String(state.break.end[1]).padStart(2,'0');
    startOverlayCountdown(state.break.end[0], state.break.end[1]);
  } else if(state.type==='before'){
    document.getElementById('sov-icon').textContent='🌅';
    document.getElementById('sov-title').textContent='Expediente ainda não iniciado';
    document.getElementById('sov-sub').textContent='O expediente começa às 07:30';
    startOverlayCountdown(7,30);
  } else {
    document.getElementById('sov-icon').textContent='🌙';
    document.getElementById('sov-title').textContent='Expediente encerrado';
    document.getElementById('sov-sub').textContent='O expediente foi até às 17:30';
    document.getElementById('sov-countdown').textContent='—';
    if(overlayCountdownInterval){ clearInterval(overlayCountdownInterval); overlayCountdownInterval=null; }
  }
}

function startOverlayCountdown(h,m){
  if(overlayCountdownInterval) clearInterval(overlayCountdownInterval);
  function tick(){
    const secs=secsUntil(h,m);
    document.getElementById('sov-countdown').textContent=fmtCountdown(secs);
  }
  tick();
  overlayCountdownInterval=setInterval(tick,1000);
}

function hideScheduleOverlay(){
  document.getElementById('schedule-overlay').style.display='none';
  if(overlayCountdownInterval){ clearInterval(overlayCountdownInterval); overlayCountdownInterval=null; }
}

function scheduleAdminOverride(){
  scheduleOverride=true;
  hideScheduleOverlay();
  // NÃO retoma os timers — admin só quer acesso à tela para fazer alterações.
  // Os cronômetros permanecem pausados até o expediente retornar normalmente.
}

// ── Override manual persistente (admin) ──
// Permite ao admin liberar/bloquear o acesso fora do expediente a qualquer momento.
try {
  const _savedOv = localStorage.getItem('scheduleOverride');
  if(_savedOv === '1') scheduleOverride = true;
} catch(e){}

function setScheduleOverride(on){
  scheduleOverride = !!on;
  try { localStorage.setItem('scheduleOverride', on ? '1' : '0'); } catch(e){}
  const state = getScheduleState();
  if(on){
    hideScheduleOverlay();
  } else if(state.type !== 'work'){
    pauseAllRunning();
    showScheduleOverlay(state);
  }
  renderScheduleOverrideBtn();
}

function renderScheduleOverrideBtn(){
  if(!currentUser || !currentUser.isAdmin) return;
  let btn = document.getElementById('schedule-override-btn');
  const state = getScheduleState();
  const outside = (state.type !== 'work');
  if(!outside){
    if(btn) btn.style.display = 'none';
    return;
  }
  if(!btn){
    btn = document.createElement('button');
    btn.id = 'schedule-override-btn';
    btn.type = 'button';
    btn.style.cssText = 'margin-left:8px;padding:4px 10px;border-radius:6px;border:1px solid var(--bord,#444);background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font-size:12px;font-weight:600;';
    btn.onclick = function(){ setScheduleOverride(!scheduleOverride); };
    const badge = document.getElementById('schedule-badge');
    const host = (badge && badge.parentNode) ? badge.parentNode : document.body;
    if(badge && badge.parentNode){ badge.parentNode.insertBefore(btn, badge.nextSibling); }
    else { host.appendChild(btn); }
  }
  btn.style.display = 'inline-block';
  if(scheduleOverride){
    btn.textContent = '🔒 Bloquear acesso';
    btn.title = 'Sistema liberado fora do expediente. Clique para bloquear novamente.';
    btn.style.background = 'rgba(245,166,35,.15)';
    btn.style.color = 'var(--warn)';
  } else {
    btn.textContent = '🔓 Liberar acesso';
    btn.title = 'Liberar uso do sistema fora do expediente.';
    btn.style.background = 'rgba(61,214,140,.12)';
    btn.style.color = 'var(--accent2)';
  }
}

let lastSchedType=null;

function scheduleCheck(){
  if(!currentUser) return;
  const state=getScheduleState();

  // update badge in status bar
  const badge=document.getElementById('schedule-badge');
  const breakActive=SCHEDULE.breaks.find(b=>{ const now=nowMins(); return now>=toMins(...b.start)&&now<toMins(...b.end); });
  if(breakActive){
    badge.style.display='inline-block';
    badge.style.background='rgba(245,166,35,.15)';
    badge.style.color='var(--warn)';
    badge.textContent=breakActive.icon+' '+breakActive.name;
  } else if(state.type==='work'){
    badge.style.display='inline-block';
    badge.style.background='rgba(61,214,140,.12)';
    badge.style.color='var(--accent2)';
    badge.textContent='● Expediente ativo';
  } else {
    badge.style.display='none';
  }

  // Admin, Qualidade, Desmembramento e PCP nunca recebem overlay bloqueante — só veem o badge na status bar
  // Qualidade precisa reprovar fora do expediente e durante intervalos
  // Desmembramento precisa consultar registros e relatórios a qualquer hora
  // PCP precisa acessar o sistema fora do expediente para planejamento e controle
  const isQualUser   = currentUser && !currentUser.isAdmin && currentUser.sector === 'QUALIDADE';
  const isDesMemUser = currentUser && !currentUser.isAdmin && currentUser.sector === 'DESMEMBRAMENTO';
  const isPCPUser    = currentUser && !currentUser.isAdmin && currentUser.sector === 'PCP';
  if(currentUser.isAdmin || isQualUser || isDesMemUser || isPCPUser){
    // Apenas atualiza transições de estado para os usuários sem bloquear admin/qualidade/desmembramento
    if(state.type!=='work' && lastSchedType==='work' && !scheduleOverride){
      pauseAllRunning();
    }
    if(state.type==='work' && lastSchedType!=='work'){
      scheduleOverride=false;
      resumeAllPaused();
    }
    if(state.type!=='work' && !scheduleOverride && lastSchedType===null){
      pauseAllRunning();
    }
    lastSchedType=state.type;
    renderScheduleOverrideBtn();
    return;
  }

  // Usuários normais recebem overlay bloqueante
  if(state.type!=='work' && lastSchedType==='work' && !scheduleOverride){
    // ── Backup automático ao fim do expediente ──
    if(state.type==='after' && !_autoBackupDone && currentUser){
      _autoBackupDone = true;
      const dk = new Date().toDateString().replace(/ /g,'_');
      fazerBackupFirebase(dk, 'fim-expediente').catch(()=>{});
    }
    pauseAllRunning();
    showScheduleOverlay(state);
  }
  if(state.type==='work' && lastSchedType!=='work'){
    scheduleOverride=false;
    hideScheduleOverlay();
    resumeAllPaused();
  }
  if(state.type!=='work' && !scheduleOverride && lastSchedType===null){
    pauseAllRunning();
    showScheduleOverlay(state);
  }

  lastSchedType=state.type;
}

// ════ CLOCK ════
let _clockTick=0;
function liveClock(){
  _clockTick++;
  document.getElementById('live-clock').textContent=new Date().toLocaleTimeString('pt-BR');
  scheduleCheck();

  if(currentUser){
    // Atualiza timer da tela de operador se estiver ativa
    if(currentUser && !currentUser.isAdmin && document.getElementById('view-operador').classList.contains('active')){
      opUpdateTimer(currentUser.id);
      // Atualiza histórico a cada 10s
      if(_clockTick%10===0) opRenderHistory(currentUser.id);
    }
    // Re-renderiza cards a cada minuto e garante timers ativos após re-render
    if(_clockTick % 60 === 0){
      users.filter(u=>u.active && !u.hidden && u.sector === activeSector).forEach(u=>{
        renderCard(u.id);
        const s = getS(u.id);
        if(s.status === 'running' && !timers[u.id]) startTimer(u.id);
      });
    }

    // every 10s refresh idle cards only — relatórios NÃO atualizam automaticamente
    // (evita que a tela pisque enquanto o usuário lê os dados)
    if(_clockTick%10===0){
      users.filter(u=>u.active&&u.sector===activeSector).forEach(u=>{
        if(getS(u.id).status==='idle') renderCard(u.id);
      });
    }

    // Re-sync periódico removido: o listener onValue do Firebase (applyUserSnapshot)
    // já sincroniza _startEpoch, _pauseAccum e _pausedAt em tempo real sempre que
    // qualquer dado muda no banco — inclusive pausas/retomadas de outras abas/máquinas.
    // Polling manual era redundante e gerava leituras desnecessárias no Firebase.

    // ── Auditoria de bolsões às 17:15 ────────────────────────────────────────
    // Varre o FluxoLAB e remove qualquer SELB do setor DESMEMBRAMENTO que tenha
    // sido finalizado (status 'ok' ou 'scrap') no dia mas permaneceu nos bolsões.
    // Roda apenas uma vez por dia (chave no localStorage inclui a data).
    if(currentUser && currentUser.isAdmin && _clockTick % 30 === 0){
      (function _auditoriaBolsoesDesmem(){
        const now  = new Date();
        const hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
        if(hhmm < '17:15') return; // ainda não chegou o horário
        const dateStr = now.toISOString().slice(0,10); // YYYY-MM-DD
        const lsKey   = 'audit_desmem_' + dateStr;
        if(localStorage.getItem(lsKey)) return; // já rodou hoje
        localStorage.setItem(lsKey, '1');

        // Coleta todos os SELBs do DESMEMBRAMENTO finalizados hoje (ok ou scrap)
        const finalizadosHoje = new Set(
          history
            .filter(h =>
              (h.sector === 'DESMEMBRAMENTO' || h._direto === true) &&
              (h.status === 'ok' || h.status === 'scrap') &&
              h.startEpoch && h.startEpoch >= new Date(dateStr + 'T00:00:00').getTime()
            )
            .map(h => String(h.selb || '').trim().toUpperCase())
            .filter(Boolean)
        );

        if(!finalizadosHoje.size) return;

        // Confere quais desses SELBs ainda estão em algum bolsão do FluxoLAB
        const selbsNoBolsao = [];
        Object.entries(_fluxolabData || {}).forEach(([bolsao, items]) => {
          if(!items) return;
          Object.values(items).forEach(v => {
            const code = String(v && v.selb ? v.selb : '').trim().toUpperCase();
            if(code && finalizadosHoje.has(code)) selbsNoBolsao.push({ code, bolsao });
          });
        });

        if(!selbsNoBolsao.length){
          console.info('[Auditoria 17:15] Bolsões OK — nenhum SELB do Desmembramento encontrado solto.');
          return;
        }

        // Remove cada SELB encontrado e registra no log do FluxoLAB
        const uniqueSelbsFound = [...new Set(selbsNoBolsao.map(x => x.code))];
        console.warn('[Auditoria 17:15] SELBs do Desmembramento encontrados nos bolsões — removendo:', uniqueSelbsFound);

        Promise.allSettled(
          uniqueSelbsFound.map(code =>
            fluxolabRemoveSelbGlobal(code)
              .then(() => {
                const bolsaoEncontrado = selbsNoBolsao.find(x => x.code === code)?.bolsao || '?';
                const equipNome = (typeof getEquipName === 'function' ? getEquipName(code) : '') || '';
                _fluxolabLogEntry(code, bolsaoEncontrado, '— (auditoria 17h15)', equipNome);
                console.info('[Auditoria 17:15] Removido:', code, 'do bolsão', bolsaoEncontrado);
              })
              .catch(e => console.warn('[Auditoria 17:15] Erro ao remover', code, e))
          )
        ).then(results => {
          const removidos  = results.filter(r => r.status === 'fulfilled').length;
          const erros      = results.filter(r => r.status === 'rejected').length;
          const msg = `✅ Auditoria 17:15 concluída: ${removidos} SELB(s) removido(s) dos bolsões` + (erros ? ` · ${erros} erro(s)` : '') + '.';
          console.info('[Auditoria 17:15]', msg);
          // Notifica admin via banner suave (reutiliza _labPopup se disponível)
          if(typeof window._labPopup === 'function'){
            window._labPopup('Auditoria de Bolsões', msg, removidos > 0 ? 'aviso' : 'ok');
          }
        });
      })();
    }
    // ── Fim Auditoria ─────────────────────────────────────────────────────────

  } // end if(currentUser)

  setTimeout(liveClock,1000);
}

// ════ MODAL DETALHE PROFISSIONAL (Relatório) ════
let _rpUid = null;
let _rpFilter = '';

function openRelProfDetail(uid){
  _rpUid   = uid;
  _rpFilter = '';
  const u  = users.find(x=>x.id===uid);
  if(!u) return;

  document.getElementById('rp-name').textContent = u.name;

  const src = _relHistoryCache !== null ? _relHistoryCache : history;
  const recs = src.filter(h=>h.uid===uid && ['ok','rep','scrap','cancelado'].includes(h.status))
                  .sort((a,b)=>(a.startEpoch||0)-(b.startEpoch||0));

  const ok    = recs.filter(r=>r.status==='ok').length;
  const rep   = recs.filter(r=>r.status==='rep').length;
  const scrap = recs.filter(r=>r.status==='scrap').length;
  const canc  = recs.filter(r=>r.status==='cancelado').length;
  const activeSec = recs.filter(r=>r.status==='ok').reduce((a,h)=>a+calcDuracaoLiquida(h),0);

  const sector = u.sector;
  const cor = sector==='MONTAGEM'?'var(--mont)':sector==='LIMPEZA'?'var(--limp)':sector==='ELETRÔNICA'?'var(--elet)':'var(--comp)';
  document.getElementById('rp-sub').innerHTML =
    `<span style="font-size:11px;color:${cor}">${sector}</span>` +
    (u.code ? `<span style="font-size:11px;color:var(--muted)"> · ${u.code}</span>` : '');

  document.getElementById('rp-kpi').innerHTML = `
    <div class="sum-card"><div class="slbl">Total SELBs</div><div class="sval" style="font-size:18px;color:var(--accent)">${recs.length}</div></div>
    <div class="sum-card"><div class="slbl">Aprovados</div><div class="sval" style="font-size:18px;color:var(--accent2)">${ok}</div></div>
    <div class="sum-card"><div class="slbl">Reprovados</div><div class="sval" style="font-size:18px;color:var(--danger)">${rep}</div></div>
    <div class="sum-card"><div class="slbl">SCRAP</div><div class="sval" style="font-size:18px;color:var(--purple)">${scrap}</div></div>`;

  // reset filter buttons
  document.querySelectorAll('#modal-rel-prof .stab').forEach(b=>b.className='stab');
  document.getElementById('rpf-all').className='stab a-all';

  renderRpBody(recs);
  document.getElementById('modal-rel-prof').classList.remove('hidden');
}

function setRpFilter(status, btn){
  _rpFilter = status;
  document.querySelectorAll('#modal-rel-prof .stab').forEach(b=>b.className='stab');
  if(btn) btn.className = 'stab a-all';

  const uid = _rpUid;
  const src  = _relHistoryCache !== null ? _relHistoryCache : history;
  const recs = src.filter(h=>h.uid===uid && ['ok','rep','scrap','cancelado'].includes(h.status))
                  .sort((a,b)=>(a.startEpoch||0)-(b.startEpoch||0));
  const filtered = status ? recs.filter(r=>r.status===status) : recs;
  renderRpBody(filtered);
}

function renderRpBody(recs){
  const tbody = document.getElementById('rp-body');
  if(!recs.length){
    tbody.innerHTML=`<tr><td colspan="7" class="empty">Nenhum SELB encontrado.</td></tr>`;
    return;
  }
  const statusLabel = {
    ok:'<span class="badge bok">Aprovado</span>', 
    rep:'<span class="badge brep">Reprovado</span>', 
    scrap:'<span class="badge bscr">SCRAP</span>', 
    aguardando:'<span class="badge bpec">Aguard. Peça</span>',
    cancelado:'<span class="badge" style="background:rgba(122,131,160,.15);color:var(--muted)">Cancelado</span>'
  };
  tbody.innerHTML = recs.map((r,i)=>{
    const equip = getEquipName(r.selb);
    const dur   = r.duracao || '—';
    const st    = statusLabel[r.status] || r.status;
    return `<tr>
      <td style="color:var(--muted);font-family:var(--mono);font-size:11px">${i+1}</td>
      <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${r.selb||'—'}</td>
      <td style="font-size:12px;color:var(--text)">${equip||'<span style="color:var(--muted)">—</span>'}</td>
      <td style="font-family:var(--mono);font-size:12px">${r.start||'—'}</td>
      <td style="font-family:var(--mono);font-size:12px">${r.end||'—'}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--accent2)">${dur}</td>
      <td>${st}</td>
    </tr>`;
  }).join('');
}
// ════ fim modal detalhe profissional ════


/* ══════════════════════════════════════════════════════════
   FACILITADOR DE PEDIDO — lógica completa (prefixo ped-)
   ══════════════════════════════════════════════════════════ */
(function(){
  /* Estado */
  let pedHeader = [];
  let pedTable  = [];
  const pedMapSelbInfo = new Map();
  const pedidosPorModelo = new Map();

  /* Utils */
  const $p = id => document.getElementById(id);
  function pedNorm(v){ return String(v ?? '').trim(); }
  function pedUpper(v){ return pedNorm(v).toUpperCase(); }
  function pedExtractSELB(raw){
    const s = String(raw ?? '').toUpperCase();
    const m = s.match(/[A-Z0-9]{4}/);
    return m ? m[0] : '';
  }
  function pedParseBipados(text){
    const arr = (text||'').toUpperCase().match(/[A-Z0-9]{4}/g) || [];
    const seen = new Set(), out = [];
    for(const c of arr){ if(!seen.has(c)){ seen.add(c); out.push(c); } }
    return out;
  }
  function pedOptionEl(text, value){ const o = document.createElement('option'); o.textContent = text; o.value = value; return o; }

  // Índices detectados automaticamente ao carregar a planilha
  let _pedDet = { selb:-1, serie:-1, sku:-1, modelo:-1, unit:-1 };

  function pedHydrateColumnSelectors(){
    const ids = ['ped-colSelb','ped-colSerie','ped-colSku','ped-colModelo','ped-colUnit'];
    ids.forEach(id => { $p(id).innerHTML = ''; });
    pedHeader.forEach((name, idx) => {
      const label = `${name||'(sem nome)'} (col ${idx+1})`;
      ids.forEach(id => {
        const o = document.createElement('option');
        o.textContent = label; o.value = String(idx);
        $p(id).appendChild(o);
      });
    });
    // Auto-detecção por nome de coluna (prioridade: nome exato primeiro, depois fallback genérico)
    const find = re => pedHeader.findIndex(h => re.test(String(h).trim()));
    // SELB -> coluna "SELB"
    _pedDet.selb   = find(/^selb$/i);
    if(_pedDet.selb < 0) _pedDet.selb = find(/selb/i);
    // SÉRIE -> coluna "Atributos" (ou série/serial como fallback)
    _pedDet.serie  = find(/^atributos?$/i);
    if(_pedDet.serie < 0) _pedDet.serie = find(/s[ée]rie|serie|serial|s\/n|nsr/i);
    // SKU -> coluna "Código do produto" (ou sku/código como fallback)
    _pedDet.sku    = find(/^c[oó]digo\s+do\s+produto$/i);
    if(_pedDet.sku < 0) _pedDet.sku = find(/sku|c[oó]digo|part.?num/i);
    // MODELO -> coluna "Produto" (ou modelo/produto como fallback)
    _pedDet.modelo = find(/^produto$/i);
    if(_pedDet.modelo < 0) _pedDet.modelo = find(/modelo|model|produto|product|descri|resultado/i);
    // UNITILIZADOR -> coluna "Unidade" (ou unitil/utiliz como fallback)
    _pedDet.unit   = find(/^unidade$/i);
    if(_pedDet.unit < 0) _pedDet.unit = find(/unitil|utiliz|unidade/i);
    // Aplicar via .value (mais confiável que selectedIndex)
    if(_pedDet.selb   >= 0) $p('ped-colSelb').value   = String(_pedDet.selb);
    if(_pedDet.serie  >= 0) $p('ped-colSerie').value  = String(_pedDet.serie);
    if(_pedDet.sku    >= 0) $p('ped-colSku').value    = String(_pedDet.sku);
    if(_pedDet.modelo >= 0) $p('ped-colModelo').value = String(_pedDet.modelo);
    if(_pedDet.unit   >= 0) $p('ped-colUnit').value   = String(_pedDet.unit);
    ids.forEach(id => { $p(id).disabled = false; });
  }

  function pedBuildMap(){
    pedMapSelbInfo.clear();
    // Lê do select; cai no índice detectado se valor inválido
    const ri = (id, fb) => { const v = parseInt($p(id).value); return (!isNaN(v) && v >= 0) ? v : fb; };
    const iSelb  = ri('ped-colSelb',   _pedDet.selb);
    const iSerie = ri('ped-colSerie',  _pedDet.serie);
    const iSku   = ri('ped-colSku',    _pedDet.sku);
    const iMod   = ri('ped-colModelo', _pedDet.modelo);
    const iUnit  = ri('ped-colUnit',   _pedDet.unit);
    let linhas = 0;
    for(let r=1; r<pedTable.length; r++){
      const row = pedTable[r]; if(!row) continue;
      const selb = pedExtractSELB(row[iSelb]); if(!selb) continue;
      linhas++;
      pedMapSelbInfo.set(selb, {
        serie: pedUpper(row[iSerie]),
        sku:   pedUpper(row[iSku]),
        modelo:pedUpper(row[iMod]),
        unit:  pedUpper(row[iUnit])
      });
    }
    const info = $p('ped-loadInfo'); info.innerHTML = '';
    const c1 = document.createElement('div'); c1.className='ped-chip ok';
    c1.innerHTML = `Linhas válidas: <strong>${linhas}</strong>`;
    const c2 = document.createElement('div'); c2.className='ped-chip ok';
    c2.innerHTML = `SELB únicos: <strong>${pedMapSelbInfo.size}</strong>`;
    info.append(c1, c2);
    $p('ped-btnGerar').disabled = false;
    pedRenderTotals();
  }

  /* QR */
  function pedQrURL(t, size=700){ return "https://quickchart.io/qr?size="+size+"&text="+encodeURIComponent(t||""); }

  /* Fit text */
  function pedFitIn(node, maxPx, minPx){
    let size = maxPx;
    node.style.fontSize = size+"px";
    node.style.letterSpacing = "0px";
    node.style.whiteSpace = "nowrap";
    node.style.wordBreak = "keep-all";
    node.style.textAlign = "center";
    const parent = node.parentElement;
    const fits = ()=> node.scrollWidth <= parent.clientWidth-2 && node.scrollHeight <= parent.clientHeight-2;
    while(size>minPx && !fits()){ size-=0.5; node.style.fontSize=size+"px"; }
    if(!fits()){ node.style.whiteSpace="normal"; node.style.wordBreak="break-word";
      while(size>minPx && !fits()){ size-=0.5; node.style.fontSize=size+"px"; } }
    let track=0;
    while(!fits() && track>-1.0){ track-=0.05; node.style.letterSpacing=track+"px"; }
  }

  function pedEl(tag, cls){ const n=document.createElement(tag); if(cls) n.className=cls; return n; }

  function pedMakeLabel({selb, serie, sku, modelo, unit, pedido, auditado}){
    selb=pedUpper(selb); serie=pedUpper(serie); sku=pedUpper(sku); modelo=pedUpper(modelo); unit=pedUpper(unit);

    const wrap = pedEl('div','ped-label-wrap');
    const root = pedEl('div','ped-etiqueta');

    if(auditado){
      const bar = pedEl('div','ped-auditado-bar');
      bar.textContent = 'AUDITADO';
      root.appendChild(bar);
      root.style.paddingTop = '0.75cm';
    }
    if(pedido){ root.appendChild(pedEl('div','ped-pedido-bar')); }

    // Row 1
    const row1 = pedEl('div','ped-etiq-row');
    const bSelb = pedEl('div','ped-etiq-elem');
    bSelb.style.position = 'relative';
    bSelb.style.justifyContent = 'flex-start';
    bSelb.style.alignItems = 'center';

    const sTit  = pedEl('h1','ped-etiq-titulo'); sTit.textContent='SELB';
    const sVal  = pedEl('p','ped-etiq-valor');   sVal.textContent=selb||'????';
    
    const sQR   = pedEl('img','ped-etiq-qr');    
    sQR.alt='QR SELB'; 
    sQR.src=pedQrURL(selb);
    sQR.style.position = 'absolute';
    sQR.style.right = '0';
    sQR.style.top = '50%';
    sQR.style.transform = 'translateY(-50%)';
    sQR.style.width = '2.4cm';
    sQR.style.height = '2.4cm';
    sQR.style.minWidth = '2.4cm';
    sQR.style.minHeight = '2.4cm';
    sQR.style.display = 'block';

    const bSelbInner = pedEl('div'); 
    bSelbInner.style.cssText='display:flex;flex-direction:column;align-items:center;justify-content:center;width:calc(100% - 2.6cm);margin-right:2.6cm;box-sizing:border-box;gap:0.1cm;';
    bSelbInner.append(sTit, sVal); 
    
    bSelb.append(bSelbInner, sQR);
    
    const bMod  = pedEl('div','ped-etiq-elem');
    const mTxt  = pedEl('h1','ped-etiq-modelo'); mTxt.textContent=modelo||'MODELO'; bMod.append(mTxt);
    row1.append(bMod, bSelb);

    // Row 2
    const row2 = pedEl('div','ped-etiq-row ped-etiq-row2');
    const serQRW = pedEl('div','ped-etiq-elem'); const serQR = pedEl('img','ped-etiq-qr'); serQR.alt='QR SÉRIE'; serQR.src=pedQrURL(serie); serQRW.append(serQR);
    const serVW  = pedEl('div','ped-etiq-elem'); const serV  = pedEl('h1','ped-etiq-valor'); serV.textContent=serie||'SÉRIE'; serVW.append(serV);
    const serTW  = pedEl('div','ped-etiq-elem'); const serT  = pedEl('h1','ped-etiq-titulo'); serT.textContent='SÉRIE'; serTW.append(serT);
    row2.append(serQRW, serVW, serTW);

    // Row 3
    const row3 = pedEl('div','ped-etiq-row');
    const skuTW = pedEl('div','ped-etiq-elem1'); const skuT = pedEl('p','ped-etiq-titulo'); skuT.textContent='SKU'; skuTW.append(skuT);
    const skuVW = pedEl('div','ped-etiq-elem1'); const skuV = pedEl('h1','ped-etiq-valor');  skuV.textContent=sku||'------'; skuVW.append(skuV);
    const skuQW = pedEl('div','ped-etiq-elem1'); const skuQ = pedEl('img','ped-etiq-qr'); skuQ.alt='QR SKU'; skuQ.src=pedQrURL(sku); skuQW.append(skuQ);
    row3.append(skuTW, skuVW, skuQW);

    root.append(row1, row2, row3);

    setTimeout(()=>{
      pedFitIn(mTxt, 40, 22);
      pedFitIn(serV, 50, 22);
      pedFitIn(skuV, 50, 22);
      pedFitIn(sVal, 50, 22);
    }, 50);

    // Unit pill (só tela)
    const pill = pedEl('div','ped-unit-pill no-print');
    const uTitle = pedEl('div','ped-unit-title'); uTitle.textContent='UNITILIZADOR'; pill.appendChild(uTitle);
    if(unit){ const uQR = pedEl('img','ped-unit-qr'); uQR.alt='QR UNIT'; uQR.src=pedQrURL(unit,500); pill.appendChild(uQR); }
    else { const miss = pedEl('div'); miss.textContent='— sem unit —'; miss.style.cssText='font-size:11px;opacity:.8'; pill.appendChild(miss); }
    wrap.append(root, pill);
    return wrap;
  }

  /* Totais por modelo */
  function pedRenderTotals(){
    const target = $p('ped-totaisPorModelo');
    if(!target) return;
    const bip = pedParseBipados($p('ped-lista').value);
    const counts = new Map();
    for(const code of bip){
      const info = pedMapSelbInfo.get(code);
      if(!info) continue;
      const m = info.modelo||'(SEM MODELO)';
      counts.set(m, (counts.get(m)||0)+1);
    }
    target.innerHTML = '';
    const entries = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
    if(!entries.length){ target.innerHTML='<p style="color:var(--text3);font-size:12px">Nenhum modelo contabilizado ainda.</p>'; return; }

    const tbl = document.createElement('table'); tbl.className='ped-tot-table';
    const thead = document.createElement('thead');
    const thr = document.createElement('tr');
    ['Modelo','Quantidade','Pedidos'].forEach((txt,i)=>{ const th=document.createElement('th'); th.textContent=txt; if(i>0) th.style.textAlign='right'; thr.append(th); });
    thead.append(thr); tbl.append(thead);
    const tbody = document.createElement('tbody');
    let totMaq=0, totPed=0;
    for(const [modelo,q] of entries){
      totMaq+=q;
      const tr=document.createElement('tr');
      const tdM=document.createElement('td'); tdM.textContent=modelo; tdM.title=modelo;
      const tdQ=document.createElement('td'); tdQ.textContent=String(q); tdQ.style.textAlign='right';
      const tdP=document.createElement('td'); tdP.style.textAlign='right';
      const inp=document.createElement('input'); inp.type='number'; inp.min=0; inp.max=q; inp.value=String(pedidosPorModelo.get(modelo)||0);
      inp.style.cssText='width:52px;padding:5px;border-radius:7px;border:1px solid var(--border2);font-size:12px;text-align:center';
      inp.addEventListener('input',()=>{ let v=parseInt(inp.value)||0; if(v<0)v=0; if(v>q)v=q; inp.value=String(v); pedidosPorModelo.set(modelo,v); pedUpdateChips(counts); });
      totPed+=Math.min(pedidosPorModelo.get(modelo)||0, q);
      tdP.append(inp); tr.append(tdM,tdQ,tdP); tbody.append(tr);
    }
    tbl.append(tbody); target.append(tbl);

    const chipsWrap = document.createElement('div'); chipsWrap.className='ped-chips'; chipsWrap.style.marginTop='10px';
    const cMaq=document.createElement('div'); cMaq.className='ped-chip'; cMaq.innerHTML=`Total máquinas: <strong>${totMaq}</strong>`;
    const cPed=document.createElement('div'); cPed.className='ped-chip ok'; cPed.innerHTML=`Total pedidos: <strong>${totPed}</strong>`;
    chipsWrap.append(cMaq,cPed); target.append(chipsWrap);
  }

  function pedUpdateChips(countsMap){
    const bip=pedParseBipados($p('ped-lista').value);
    const counts=countsMap||(()=>{ const c=new Map(); for(const code of bip){ const info=pedMapSelbInfo.get(code); if(!info) continue; const m=info.modelo||'(SEM MODELO)'; c.set(m,(c.get(m)||0)+1); } return c; })();
    let totMaq=0,totPed=0;
    for(const [m,q] of counts.entries()){ totMaq+=q; totPed+=Math.min(pedidosPorModelo.get(m)||0,q); }
    const target=$p('ped-totaisPorModelo'); if(!target) return;
    const chips=target.querySelectorAll('.ped-chips .ped-chip');
    if(chips.length>=2){ chips[0].innerHTML=`Total máquinas: <strong>${totMaq}</strong>`; chips[1].innerHTML=`Total pedidos: <strong>${totPed}</strong>`; }
  }

  /* Handlers */
  $p('ped-file').addEventListener('change', async ev=>{
    const f=ev.target.files?.[0]; if(!f) return;
    const ab=await f.arrayBuffer();
    const wb=XLSX.read(ab,{type:'array'});
    const ws=wb.Sheets[wb.SheetNames[0]];
    const arr=XLSX.utils.sheet_to_json(ws,{header:1,raw:true});
    if(!arr.length){ alert('Planilha vazia.'); return; }
    pedHeader=(arr[0]||[]).map(v=>String(v??'').trim());
    pedTable=arr;
    pedHydrateColumnSelectors();
    pedBuildMap();
  });

  ['ped-colSelb','ped-colSerie','ped-colSku','ped-colModelo','ped-colUnit'].forEach(id=>{
    $p(id).addEventListener('change', pedBuildMap);
  });

  $p('ped-lista').addEventListener('input', ()=>{
    const bip=pedParseBipados($p('ped-lista').value);
    $p('ped-qtdBipado').textContent=bip.length;
    const match=bip.filter(x=>pedMapSelbInfo.has(x));
    $p('ped-qtdMatch').textContent=match.length;
    const noM=bip.length-match.length;
    $p('ped-qtdNoMatch').textContent=noM;
    $p('ped-chipNoMatch').style.display=noM>0?'':'none';
    pedRenderTotals();
  });

  $p('ped-btnLimpar').addEventListener('click',()=>{
    $p('ped-lista').value='';
    ['ped-qtdBipado','ped-qtdMatch','ped-qtdNoMatch'].forEach(id=>$p(id).textContent='0');
    $p('ped-chipNoMatch').style.display='none';
    $p('ped-gallery').innerHTML='';
    $p('ped-faltantes').innerHTML='';
    $p('ped-resumo').innerHTML='';
    pedidosPorModelo.clear();
    $p('ped-totaisPorModelo').innerHTML='<p style="color:var(--text3);font-size:12px">Cole os SELBs no passo 2 para ver os totais por modelo aqui.</p>';
  });

  $p('ped-btnGerar').addEventListener('click', ()=>{
    const bip=pedParseBipados($p('ped-lista').value);
    const labels=[]; const noMatch=[];
    const isAuditado = $p('ped-chkAuditado').checked;
    for(const code of bip){
      const info=pedMapSelbInfo.get(code);
      if(!info){ noMatch.push(code); continue; }
      labels.push({selb:code,...info});
    }
    const resumo=$p('ped-resumo'); resumo.innerHTML='';
    const mkChip=(txt,cls='')=>{ const d=document.createElement('div'); d.className='ped-chip '+(cls||''); d.innerHTML=txt; return d; };
    resumo.append(mkChip(`SELBs na lista: <strong>${bip.length}</strong>`));
    resumo.append(mkChip(`Etiquetas geradas: <strong>${labels.length}</strong>`));
    if(noMatch.length) resumo.append(mkChip(`Não encontrados: <strong>${noMatch.length}</strong>`,'warn'));

    const gal=$p('ped-gallery'); gal.innerHTML='';
    const assigned=new Map();
    for(const data of labels){
      const m=data.modelo||'(SEM MODELO)';
      const need=Number(pedidosPorModelo.get(m)||0);
      const already=assigned.get(m)||0;
      const mark=already<need;
      if(mark) assigned.set(m,already+1);
      gal.appendChild(pedMakeLabel({...data,pedido:mark,auditado:isAuditado}));
    }

    const fDiv=$p('ped-faltantes');
    if(noMatch.length){
      fDiv.innerHTML=`<div class="ped-card" style="margin-top:12px"><h3>Não encontrados na planilha</h3><div class="ped-card-body"><ul style="margin:0;padding-left:18px;font-size:12px">${noMatch.sort().map(c=>`<li>${c}</li>`).join('')}</ul></div></div>`;
    } else { fDiv.innerHTML=''; }

    pedRenderTotals();
    gal.scrollIntoView({behavior:'smooth',block:'start'});
  });
})();


// ════════════════════════════════════════════
// MÁQUINAS A
// Armazenado em /maquinas_a/{id} no Firebase
// Campos: selb, equipamento, setor, observacao, registradoPor, registradoEm, status ('ativa'|'removida')
// ════════════════════════════════════════════
let _maquinasA = {}; // cache local { id: {...} }

// ── Sub-tab intercalável ──────────────────────────────────────────────────
function setMaquinasASubTab(tab, btn){
  document.getElementById('subview-maquinas-a').style.display = tab === 'maquinas-a' ? '' : 'none';
  document.getElementById('subview-pecas-a').style.display    = tab === 'pecas'      ? '' : 'none';

  // Estilo dos botões
  const active   = 'background:var(--accent);color:#fff;border:none;';
  const inactive = 'background:var(--bg2);color:var(--muted);border:1px solid var(--border);';
  document.getElementById('subtab-maquinas-a').style.cssText = (tab === 'maquinas-a' ? active : inactive) +
    'border-radius:100px;font-family:var(--font);font-size:13px;font-weight:600;padding:8px 22px;cursor:pointer;transition:all .2s';
  document.getElementById('subtab-pecas-a').style.cssText = (tab === 'pecas' ? active : inactive) +
    'border-radius:100px;font-family:var(--font);font-size:13px;font-weight:600;padding:8px 22px;cursor:pointer;transition:all .2s';

  if(tab === 'pecas') renderPecasSubView();
  else renderMaquinasAView();
}

// ── Pecas sub-view: últimos 7 dias com filtro "Até" ──────────────────────
async function renderPecasSubView(){
  const tbody = document.getElementById('pecas-a-body');
  const q = (document.getElementById('pecas-a-search')?.value || '').toUpperCase();
  if(!tbody) return;

  _renderSolicitacoesPanel('pecas-a-solicitacoes-panel', q);
  tbody.innerHTML = `<tr><td colspan="10" class="empty">Carregando...</td></tr>`;

  // ── Define intervalo: últimos 7 dias até a data selecionada (padrão: hoje) ──
  const ateInput = document.getElementById('pecas-a-ate');
  const ateDate = ateInput?.value ? new Date(ateInput.value + 'T23:59:59') : new Date();

  // Inicializa o campo "Até" com hoje se ainda estiver vazio
  if(ateInput && !ateInput.value){
    ateInput.value = ateDate.toISOString().slice(0,10);
  }

  // Gera os dateKeys dos últimos 7 dias a partir da data "Até"
  const dks = [];
  for(let i = 0; i < 7; i++){
    const d = new Date(ateDate); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
    dks.push(d.toDateString().replace(/ /g,'_'));
  }

  // Busca no Firebase os dias que ainda não estão no cache
  for(const dk of dks){
    if(history.some(h => h._dateKey === dk && h.status === 'aguardando')) continue;
    try {
      const data = await dbGet('/history/' + dk);
      if(data){
        const recs = Object.entries(data).map(([k,v])=>({...v,_docId:k,_dateKey:dk})).filter(r=>r.status==='aguardando');
        recs.forEach(r => { if(!history.find(h=>h._docId===r._docId)) history.push(r); });
      }
    } catch(e){}
  }

  const dkSet = new Set(dks);
  let allAguardando = history.filter(h => h.status === 'aguardando' && dkSet.has(h._dateKey));
  const filtered = allAguardando.filter(h => !q || h.selb.includes(q) || h.name.toUpperCase().includes(q));

  if(!filtered.length){
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Nenhum SELB aguardando peça.</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(h => {
    const solKey = 'selb_solicitado_' + h.selb;
    let jaSolicitado = false;
    try { jaSolicitado = localStorage.getItem(solKey) === '1'; } catch(e){}
    const chkStyle = jaSolicitado
      ? 'background:var(--accent2);border-color:var(--accent2);'
      : 'background:transparent;border:2px solid rgba(61,214,140,.4);';
    const solsDoSelb = Object.entries(_solicitacoesPecas || {})
      .filter(([,p]) => (p.selb||'').toUpperCase() === (h.selb||'').toUpperCase());
    const pecasCellHtml = solsDoSelb.length
      ? solsDoSelb.map(([,p]) => {
          const qtd = p.quantidade > 1 ? `<span style="background:rgba(245,166,35,.2);color:var(--warn);border-radius:4px;font-size:10px;font-weight:800;padding:0 5px;margin-left:3px">x${p.quantidade}</span>` : '';
          return `<div style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:2px"><span>🔩</span><span style="color:var(--text)">${p.peca||'—'}</span>${qtd}</div>`;
        }).join('')
      : '<span style="color:var(--muted);font-size:11px">—</span>';
    return `
    <tr style="${jaSolicitado ? 'opacity:0.5;' : ''}">
      <td style="text-align:center;width:44px">
        <label title="${jaSolicitado ? 'Solicitado!' : 'Marcar como solicitado'}" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;user-select:none">
          <input type="checkbox" ${jaSolicitado ? 'checked' : ''}
            onchange="toggleSelbSolicitado('${h.selb}', this)"
            style="width:18px;height:18px;border-radius:5px;${chkStyle}appearance:none;-webkit-appearance:none;cursor:pointer;transition:all .15s">
          <span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.02em">${jaSolicitado ? 'FEITO' : 'PEDIDO?'}</span>
        </label>
      </td>
      <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${h.selb}</td>
      <td style="font-size:12px;color:var(--muted)">${h.equipamento || '—'}</td>
      <td>${h.name}</td>
      <td>${h.sector}</td>
      <td style="font-family:var(--mono);font-size:12px">${h._dateKey.replace(/_/g,'/')} - ${h.start}</td>
      <td style="font-family:var(--mono);font-size:12px">${h.duracao || '—'}</td>
      <td style="font-size:11px;color:var(--muted);max-width:160px">${h.comentario || h.motivo || '—'}</td>
      <td>${pecasCellHtml}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="btn bp" style="font-size:11px;padding:6px 12px"
            onclick="liberarPeca('${h._docId}','${h._dateKey}')">✅ Aprovar / Liberar</button>
          ${(currentUser && currentUser.isAdmin) ? `
          <button style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:8px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap"
            onclick="admMoverParaMaquinaA('${h._docId}','${h._dateKey}','${h.selb}','${(h.equipamento||'').replace(/'/g,"\'")}','${(h.sector||'').replace(/'/g,"\'")}')">🅰️ → Máquinas A</button>
          ` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Listener Firebase para /maquinas_a ───────────────────────────────────
function startMaquinasAListener(){
  if(!_db) return;
  _db.ref('/maquinas_a').on('value', snap => {
    _maquinasA = snap.val() || {};
    if(document.getElementById('view-maquinas-a')?.classList.contains('active')){
      const subMaAtivo = document.getElementById('subview-maquinas-a').style.display !== 'none';
      if(subMaAtivo) renderMaquinasAView();
    }
  });
}

// ── Abre modal para registrar Máquina A (somente admin) ──────────────────
function abrirModalAdicionarMaquinaA(){
  if(!currentUser || !currentUser.isAdmin){ alert('Apenas admins podem registrar Máquinas A.'); return; }
  document.getElementById('ma-selb').value  = '';
  document.getElementById('ma-equip').value = '';
  document.getElementById('ma-setor').value = '';
  document.getElementById('ma-obs').value   = '';
  document.getElementById('ma-err').textContent = '';
  const _prev = document.getElementById('ma-equip-preview');
  const _nf   = document.getElementById('ma-equip-notfound');
  if (_prev) _prev.style.display = 'none';
  if (_nf)   _nf.style.display   = 'none';
  document.getElementById('modal-add-maquina-a').classList.remove('hidden');
  setTimeout(() => document.getElementById('ma-selb').focus(), 100);
}

// ── Salva Máquina A no Firebase ─────────────────────────────────────────
// ── Auto-preenche modelo ao bipar/digitar SELB no modal de Máquina A ────────
function maquinaAAutoPreencherEquip(selb) {
  const previewEl   = document.getElementById('ma-equip-preview');
  const previewName = document.getElementById('ma-equip-preview-name');
  const notFound    = document.getElementById('ma-equip-notfound');
  const equipInput  = document.getElementById('ma-equip');

  // Esconde ambos se campo vazio
  if (!selb || selb.length < 2) {
    if (previewEl)  previewEl.style.display  = 'none';
    if (notFound)   notFound.style.display   = 'none';
    return;
  }

  const modelo = (typeof getEquipName === 'function') ? getEquipName(selb) : null;

  if (modelo) {
    if (equipInput) equipInput.value = modelo;
    if (previewName) previewName.textContent = modelo;
    if (previewEl)  previewEl.style.display  = 'flex';
    if (notFound)   notFound.style.display   = 'none';
  } else {
    // Limpa campo e mostra aviso apenas se SELB tiver tamanho razoável
    if (selb.length >= 4) {
      if (equipInput && equipInput.value) equipInput.value = '';
      if (previewEl)  previewEl.style.display  = 'none';
      if (notFound)   notFound.style.display   = 'block';
    } else {
      if (previewEl)  previewEl.style.display  = 'none';
      if (notFound)   notFound.style.display   = 'none';
    }
  }
}

async function salvarMaquinaA(){
  const btn = document.querySelector('#modal-add-maquina-a .btn.bp');
  const txtOriginal = btn ? btn.textContent : '';
  
  const setBtn = (dis, txt) => {
    if(!btn) return;
    btn.disabled = dis;
    if(txt !== undefined) btn.textContent = txt;
  };

  if(btn && btn.disabled) return;
  setBtn(true, 'Salvando...');
  const resetTimer = setTimeout(() => setBtn(false, txtOriginal), 5000);

  const selb  = document.getElementById('ma-selb').value.trim().toUpperCase();
  const equip = document.getElementById('ma-equip').value.trim();
  const setor = document.getElementById('ma-setor').value;
  const obs   = document.getElementById('ma-obs').value.trim();
  const errEl = document.getElementById('ma-err');

  if(!selb){ errEl.textContent = 'Informe o SELB / código da máquina.'; return; }
  errEl.textContent = '';

  // Anti-duplicata: verifica se já existe como ativa em Máquinas A
  const existente = Object.values(_maquinasA).find(m => m.selb === selb && m.status === 'ativa');
  if(existente){ errEl.textContent = 'Este SELB já está registrado como Máquina A.'; return; }

  // Anti-duplicata: verifica se já existe em Aguardando Peças
  const emPecas = history.find(h => h.selb === selb && h.status === 'aguardando');
  if(emPecas){
    errEl.textContent = 'Este SELB já está na aba "Aguardando Peças". Remova-o de lá antes de registrar como Máquina A.';
    return;
  }

  const id = 'ma_' + Date.now();
  const registro = {
    selb,
    equipamento: equip || '—',
    setor: setor || '—',
    observacao: obs || '',
    registradoPor: currentUser.name || 'Admin',
    registradoEm: new Date().toISOString(),
    status: 'ativa'
  };

  try {
    await dbSet('/maquinas_a/' + id, registro);
    _maquinasA[id] = registro;

    // Remove o SELB de todos os bolsões do FluxoLAB
    if (typeof fluxolabRemoveSelbGlobal === 'function') {
      fluxolabRemoveSelbGlobal(selb).catch(e => console.warn('[MáquinasA] Erro ao remover do FluxoLAB:', e));
    }

    // Limpa os campos de preview antes de fechar
    const prev = document.getElementById('ma-equip-preview');
    const nf   = document.getElementById('ma-equip-notfound');
    if (prev) prev.style.display = 'none';
    if (nf)   nf.style.display   = 'none';

    closeModal('modal-add-maquina-a');
    renderMaquinasAView();
  } catch(e){
    errEl.textContent = 'Erro ao salvar: ' + e.message;
  }
  clearTimeout(resetTimer);
  setBtn(false, txtOriginal);
}

// ── Renderiza a lista de Máquinas A ─────────────────────────────────────
function renderMaquinasAView(){
  const tbody  = document.getElementById('maquinas-a-body');
  const kpiEl  = document.getElementById('maquinas-a-kpi');
  const isAdmin = currentUser && currentUser.isAdmin;

  const btnAdd = document.getElementById('btn-add-maquina-a');
  if(btnAdd) btnAdd.style.display = isAdmin ? '' : 'none';

  const q = (document.getElementById('maquinas-a-search')?.value || '').toUpperCase().trim();

  const todas = Object.entries(_maquinasA)
    .filter(([, m]) => m.status === 'ativa')
    .map(([id, m]) => ({ id, ...m }));

  const filtradas = q
    ? todas.filter(m => m.selb.includes(q) || (m.equipamento || '').toUpperCase().includes(q))
    : todas;

  // KPIs
  if(kpiEl){
    const totalAtivas = todas.length;
    const setores = [...new Set(todas.map(m => m.setor).filter(s => s && s !== '—'))];
    const maisRecente = todas.sort((a,b) => new Date(b.registradoEm) - new Date(a.registradoEm))[0];

    kpiEl.innerHTML = `
      <div class="sum-card" style="border-color:rgba(79,142,247,.2)">
        <div class="slbl">Total Máquinas A</div>
        <div class="sval" style="color:var(--accent)">${totalAtivas}</div>
      </div>
      <div class="sum-card" style="border-color:rgba(245,166,35,.2)">
        <div class="slbl">Setores</div>
        <div class="sval" style="color:var(--warn)">${setores.length || 0}</div>
      </div>
      <div class="sum-card" style="border-color:rgba(61,214,140,.2)">
        <div class="slbl">Último registro</div>
        <div class="sval" style="font-size:12px;color:var(--accent2)">${maisRecente ? new Date(maisRecente.registradoEm).toLocaleDateString('pt-BR') : '—'}</div>
      </div>`;
  }

  if(!filtradas.length){
    tbody.innerHTML = `<tr><td colspan="7" class="empty">${
      q ? 'Nenhuma Máquina A encontrada para a busca.' : '✅ Nenhuma Máquina A registrada.'
    }</td></tr>`;
    return;
  }

  tbody.innerHTML = filtradas.map(m => {
    const dt = new Date(m.registradoEm);
    const dataStr = dt.toLocaleDateString('pt-BR') + ' ' + dt.toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'});

    const acoesHtml = isAdmin
      ? `<div style="display:flex;gap:5px;flex-wrap:wrap">
           <button onclick="admEditarMaquinaA('${m.id}')"
             style="background:rgba(79,142,247,.1);border:1px solid rgba(79,142,247,.3);border-radius:8px;color:var(--accent);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap">
             ✏️ Editar
           </button>
           <button onclick="admMoverParaPecas('${m.id}','${m.selb}')"
             style="background:rgba(245,166,35,.1);border:1px solid rgba(245,166,35,.3);border-radius:8px;color:var(--warn);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap">
             🛠️ → Aguardando Peças
           </button>
           <button onclick="admRemoverMaquinaA('${m.id}','${m.selb}')"
             style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.3);border-radius:8px;color:var(--danger);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap">
             🗑️ Remover
           </button>
         </div>`
      : `<span style="font-size:11px;color:var(--muted)">Somente Admin</span>`;

    return `<tr>
      <td style="font-family:var(--mono);font-weight:700;color:var(--accent)">${m.selb}</td>
      <td style="font-size:12px;color:var(--muted)">${m.equipamento || '—'}</td>
      <td><span class="stag stag-${sc(m.setor)}">${m.setor || '—'}</span></td>
      <td style="font-family:var(--mono);font-size:11px;color:var(--muted)">${dataStr}</td>
      <td style="font-size:12px">${m.registradoPor || '—'}</td>
      <td style="font-size:11px;color:var(--muted);max-width:200px;white-space:normal">${m.observacao || '—'}</td>
      <td>${acoesHtml}</td>
    </tr>`;
  }).join('');
}

// ── Admin remove (exclui permanentemente) o SELB da lista Máquinas A ─────
async function admRemoverMaquinaA(id, selb){
  if(!currentUser || !currentUser.isAdmin){ return; }
  if(!confirm('Remover o SELB "' + selb + '" da lista de Máquinas A?\n\nEsta ação é permanente.')) return;
  try {
    await dbDelete('/maquinas_a/' + id);
    delete _maquinasA[id];
    renderMaquinasAView();
  } catch(e){ alert('Erro ao remover: ' + e.message); }
}

// ── Admin edita um SELB em Máquinas A ────────────────────────────────────
function admEditarMaquinaA(id){
  if(!currentUser || !currentUser.isAdmin){ return; }
  const m = _maquinasA[id];
  if(!m){ alert('Registro não encontrado.'); return; }

  document.getElementById('ma-edit-id').value    = id;
  document.getElementById('ma-edit-selb').value  = m.selb;
  document.getElementById('ma-edit-equip').value = m.equipamento || '';
  document.getElementById('ma-edit-setor').value = m.setor || '';
  document.getElementById('ma-edit-obs').value   = m.observacao || '';
  document.getElementById('ma-edit-err').textContent = '';
  document.getElementById('modal-edit-maquina-a').classList.remove('hidden');
}

async function salvarEdicaoMaquinaA(){
  const id    = document.getElementById('ma-edit-id').value;
  const equip = document.getElementById('ma-edit-equip').value.trim();
  const setor = document.getElementById('ma-edit-setor').value;
  const obs   = document.getElementById('ma-edit-obs').value.trim();
  const errEl = document.getElementById('ma-edit-err');
  errEl.textContent = '';

  try {
    const patch = { equipamento: equip || '—', setor: setor || '—', observacao: obs || '' };
    await dbPatch('/maquinas_a/' + id, patch);
    Object.assign(_maquinasA[id], patch);
    closeModal('modal-edit-maquina-a');
    renderMaquinasAView();
  } catch(e){ errEl.textContent = 'Erro ao salvar: ' + e.message; }
}

// ── Admin move SELB de Máquinas A → Aguardando Peças ─────────────────────
async function admMoverParaPecas(id, selb){
  if(!currentUser || !currentUser.isAdmin){ return; }
  // Verifica se já existe em Aguardando Peças
  const emPecas = history.find(h => h.selb === selb && h.status === 'aguardando');
  if(emPecas){
    alert('Este SELB já está em "Aguardando Peças".');
    return;
  }
  if(!confirm('Mover o SELB "' + selb + '" de Máquinas A para Aguardando Peças?\n\nEle será removido de Máquinas A.')) return;

  const m = _maquinasA[id];
  try {
    // Cria registro em history como 'aguardando'
    const now = new Date();
    const dk  = now.toDateString().replace(/ /g, '_');
    const rec = {
      selb,
      uid:          'admin',
      name:         'Admin (movido)',
      pin:          '—',
      sector:       m.setor || '—',
      start:        now.toLocaleTimeString('pt-BR'),
      end:          null,
      duracao:      null,
      status:       'aguardando',
      motivo:       'Movido de Máquinas A pelo Admin',
      comentario:   m.observacao || '',
      equipamento:  m.equipamento || '—',
      startEpoch:   Date.now()
    };
    await dbPush('/history/' + dk, rec);
    // Remove de Máquinas A
    await dbDelete('/maquinas_a/' + id);
    delete _maquinasA[id];
    history.unshift({...rec, _docId: 'mv_'+Date.now(), _dateKey: dk});
    renderMaquinasAView();
    renderPecasView();
    renderPecasSubView();
    updateSummary();
    registrarLogPecas(selb, m.equipamento, 'Movido de Máquinas A para Aguardando Peças');
    if (typeof fluxolabFinalizarSelb === 'function') {
      await fluxolabFinalizarSelb(selb, m.setor || '—', 'aguardando');
    }
    alert('SELB movido para Aguardando Peças com sucesso!');
  } catch(e){ alert('Erro ao mover: ' + e.message); }
}

// ── Admin move SELB de Aguardando Peças → Máquinas A ─────────────────────
async function admMoverParaMaquinaA(docId, dateKey, selb, equip, setor){
  if(!currentUser || !currentUser.isAdmin){ return; }
  // Verifica se já existe em Máquinas A
  const emMA = Object.values(_maquinasA).find(m => m.selb === selb && m.status === 'ativa');
  if(emMA){
    alert('Este SELB já está em "Máquinas A".');
    return;
  }
  if(!confirm('Mover o SELB "' + selb + '" de Aguardando Peças para Máquinas A?\n\nEle sairá da lista de aguardando peças.')) return;

  try {
    // Marca o registro de aguardando como 'ok' (resolvido / movido)
    await dbUpdateHistory(docId, dateKey, { status: 'ok', motivo: 'Movido para Máquinas A pelo Admin' });
    const hLocal = history.find(x => x._docId === docId);
    if(hLocal){ hLocal.status = 'ok'; hLocal.motivo = 'Movido para Máquinas A pelo Admin'; }

    // Cria entrada em Máquinas A
    const newId = 'ma_' + Date.now();
    const registro = {
      selb,
      equipamento: equip || '—',
      setor: setor || '—',
      observacao: 'Movido de Aguardando Peças pelo Admin',
      registradoPor: currentUser.name || 'Admin',
      registradoEm: new Date().toISOString(),
      status: 'ativa'
    };
    await dbSet('/maquinas_a/' + newId, registro);
    _maquinasA[newId] = registro;

    // Remove o SELB de todos os bolsões do FluxoLAB
    if (typeof fluxolabRemoveSelbGlobal === 'function') {
      fluxolabRemoveSelbGlobal(selb).catch(e => console.warn('[MáquinasA] Erro ao remover do FluxoLAB:', e));
    }

    renderMaquinasAView();
    renderPecasView();
    renderPecasSubView();
    updateSummary();
    alert('SELB movido para Máquinas A com sucesso!');
  } catch(e){ alert('Erro ao mover: ' + e.message); }
}

// ── Hook no setView para inicializar ao entrar na aba ────────────────────
const _origSetViewForMaquinasA = window.setView;
window.setView = function(v){
  if(_origSetViewForMaquinasA) _origSetViewForMaquinasA(v);
  if(v==='maquinas-a') renderMaquinasAView();
};

// ════════════════════════════════════════
// BUSCA POR MODELO ESPECÍFICO
// ════════════════════════════════════════
async function renderBuscaModeloRel(){
  const select = document.getElementById("busca-modelo-select");
  const stats  = document.getElementById("busca-modelo-stats");
  const body   = document.getElementById("busca-modelo-body");
  if(!select || !stats || !body) return;
  
  // 1. Carrega dados conforme filtro global
  await loadRelByDate();
  const historyData = _relHistoryCache !== null ? _relHistoryCache : history;
  if(!historyData || !historyData.length) {
    const body2 = document.getElementById('busca-modelo-body');
    if(body2) body2.innerHTML = '<tr><td colspan="5" class="empty">Nenhum dado no período selecionado.</td></tr>';
    return;
  }

  // 2. Popula datalist (input livre com sugestões)
  const currentVal = (select.value || '').trim().toUpperCase();
  const models = [...new Set(historyData.map(h => h.equipamento).filter(Boolean))].sort();
  const datalist = document.getElementById('busca-modelo-datalist');
  if(datalist) datalist.innerHTML = models.map(m => `<option value="${m}"></option>`).join('');

  // Aceita tanto match exato quanto digitação parcial (ao menos 3 chars)
  let model = models.find(m => m.toUpperCase() === currentVal) || '';
  if(!model && currentVal.length >= 3){
    model = models.find(m => m.toUpperCase().includes(currentVal)) || '';
  }
  const chartEl = document.getElementById("busca-modelo-chart");
  if(!model){
    stats.innerHTML = "";
    if(chartEl) chartEl.innerHTML = "";
    body.innerHTML = '<tr><td colspan="5" class="empty">Selecione um modelo para analisar</td></tr>';
    return;
  }

  // 3. Filtra e Agrupa por SELB (Deduplicação)
  // Pegamos o status mais recente de cada SELB para esse modelo no período
  const bySelb = {};
  historyData.filter(h => h.equipamento === model).forEach(h => {
    if(!h.selb) return;
    if(!bySelb[h.selb] || (h.endEpoch || 0) > (bySelb[h.selb].endEpoch || 0)){
      bySelb[h.selb] = h;
    }
  });

  const uniqueRecs = Object.values(bySelb);
  const approved = uniqueRecs.filter(r => r.status === "ok").length;
  const scrap    = uniqueRecs.filter(r => r.status === "scrap").length;
  const total    = uniqueRecs.length;

  // 4. Render KPIs
  stats.innerHTML = `
    <div class="kcard" style="border-left-color:var(--accent)">
      <div class="klbl">TOTAL ÚNICO</div>
      <div class="kval">${total}</div>
    </div>
    <div class="kcard" style="border-left-color:var(--accent2)">
      <div class="klbl">APROVADOS</div>
      <div class="kval">${approved}</div>
    </div>
    <div class="kcard" style="border-left-color:var(--danger)">
      <div class="klbl">SCRAP</div>
      <div class="kval">${scrap}</div>
    </div>
  `;

  // Render SVG Pie Chart
  if(chartEl){
    if(total === 0){
      chartEl.innerHTML = `
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:14px;padding:20px;display:flex;align-items:center;justify-content:center;height:100%;min-height:220px;color:var(--muted);font-size:12px">
          Sem dados para este período
        </div>`;
    } else {
      const approvedPct = (approved / total) * 100;
      const scrapPct = (scrap / total) * 100;
      const circ = 314.159; // 2 * Math.PI * 50
      const approvedStroke = (approvedPct / 100) * circ;
      const scrapStroke = (scrapPct / 100) * circ;
      
      const approvedOffset = 0;
      const scrapOffset = -approvedStroke;

      chartEl.innerHTML = `
        <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:14px;padding:20px;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:220px;box-sizing:border-box">
          <h4 style="font-size:11px;font-weight:700;color:var(--text);margin:0 0 16px;text-transform:uppercase;letter-spacing:0.05em">Aproveitamento do Modelo</h4>
          <div style="display:flex;align-items:center;gap:24px;width:100%;justify-content:center;flex-wrap:wrap">
            <div style="position:relative;width:100px;height:100px">
              <svg width="100" height="100" viewBox="0 0 120 120" style="transform: rotate(-90deg); width:100%; height:100%">
                <circle cx="60" cy="60" r="50" fill="transparent" stroke="rgba(255,255,255,0.05)" stroke-width="18"/>
                ${approved > 0 ? `
                <circle cx="60" cy="60" r="50" fill="transparent" 
                  stroke="#4ade80" 
                  stroke-width="18" 
                  stroke-dasharray="${approvedStroke} ${circ}" 
                  stroke-dashoffset="${approvedOffset}"
                  style="transition: stroke-dasharray 0.5s ease" />` : ''}
                ${scrap > 0 ? `
                <circle cx="60" cy="60" r="50" fill="transparent" 
                  stroke="var(--danger)" 
                  stroke-width="18" 
                  stroke-dasharray="${scrapStroke} ${circ}" 
                  stroke-dashoffset="${scrapOffset}"
                  style="transition: stroke-dasharray 0.5s ease" />` : ''}
              </svg>
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:var(--mono);font-size:13px;font-weight:700;color:var(--text)">
                ${approvedPct.toFixed(0)}%
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;min-width:130px">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:#4ade80"></span>
                <div style="font-size:11px;color:var(--muted)">
                  <span style="color:var(--text);font-weight:700">Aprovados</span>: ${approved} (${approvedPct.toFixed(0)}%)
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:6px">
                <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:var(--danger)"></span>
                <div style="font-size:11px;color:var(--muted)">
                  <span style="color:var(--text);font-weight:700">Scrap</span>: ${scrap} (${scrapPct.toFixed(0)}%)
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }
  }

  // 5. Render Table
  body.innerHTML = uniqueRecs.sort((a,b) => (b.endEpoch||0) - (a.endEpoch||0)).map(r => `
    <tr>
      <td style="font-family:var(--mono);font-weight:600;color:var(--accent)">${r.selb}</td>
      <td>
        <span class="status-tag ${r.status}">
          ${r.status==="ok"?"✅ Aprovado":r.status==="scrap"?"🗑️ SCRAP":r.status==="rep"?"❌ Reprovado":"❓ "+r.status}
        </span>
      </td>
      <td style="font-size:11px">${r.dateKey?.replace(/_/g," ") || "?"} ${r.end || "--:--"}</td>
      <td style="font-weight:600">${r.name || "?"}</td>
      <td style="font-size:11px;color:var(--muted)">${r.sector || "?"}</td>
    </tr>
  `).join("");
}

// Exibe um pop-up fixo para cada profissional IDLE nessas áreas.
// O alerta desaparece APENAS quando o profissional inicia um SELB
// ou quando o admin clica em "Remover Alerta".
// Sincronizado via Firebase /alerts/dismissed para todas as janelas.
// ════════════════════════════════════════════════════════════════════════
(function(){
const ALERT_SECTORS = new Set(['COMPLEXA','MONTAGEM','LIMPEZA']);

  // UIDs cujo alerta foi dispensado (admin) — timestamp do dismiss
  // O alerta só volta se o profissional iniciar E finalizar um SELB após o dismiss
  const _dismissed = new Map(); // uid → dismissTimestamp

  // Rastreia desde quando cada usuário está idle — para o delay de 2 minutos
  const _idleSince  = new Map(); // uid → timestamp em que ficou idle

  const ALERT_DELAY_MS = 2 * 60 * 1000; // 2 minutos

  let _alertTimerInterval = null;

  // ── Renderiza o painel de alertas ──────────────────────────────────────────
  function renderAlerts(){
    return; // Alertas de sem SELB em andamento desativados
    if(!currentUser) return;
    // Não exibe alertas na tela do operador (view-operador)
    if(document.getElementById('view-operador').classList.contains('active')) return;
    const panel = document.getElementById('selb-alert-panel');
    if(!panel) return;
    const isAdmin = currentUser.isAdmin;
    const now = Date.now();

    // Profissionais IDLE nos setores monitorados
    const idle = users.filter(u => {
      if(!u.active || u.hidden) return false;
      if(!ALERT_SECTORS.has(u.sector)) return false;
      const status = getS(u.id).status;

      // Se voltou a ter SELB, reseta o timer de idle
      if(status !== 'idle'){
        _idleSince.delete(u.id);
        return false;
      }

      // Registra o momento em que ficou idle (só na primeira vez)
      if(!_idleSince.has(u.id)) _idleSince.set(u.id, now);

      // Só exibe após 2 minutos idle
      if(now - _idleSince.get(u.id) < ALERT_DELAY_MS) return false;

      // Verifica dismiss do admin
      const dismissTs = _dismissed.get(u.id) || 0;
      if(dismissTs){
        const hRun = history.find(h => h.uid === u.id && h.status === 'running' && (h.startEpoch||0) > dismissTs);
        if(!hRun) return false;
        _dismissed.delete(u.id);
      }
      return true;
    });

    // Remove cards de usuários que voltaram a ter SELB em andamento
    Array.from(panel.children).forEach(card => {
      const uid = card.dataset.uid;
      if(!uid) return;
      const stillIdle = idle.find(u => u.id === uid);
      if(!stillIdle && !card.classList.contains('dismissing')){
        dismissCardAnim(card);
      }
    });

    // Adiciona cards para novos idles
    idle.forEach(u => {
      if(!panel.querySelector(`[data-uid="${u.id}"]`)){
        panel.appendChild(buildAlertCard(u, isAdmin));
      }
    });
  }

  // ── Constrói um card de alerta ─────────────────────────────────────────────
  function buildAlertCard(u, isAdmin){
    const sectorColor = u.sector==='MONTAGEM' ? 'var(--mont)'
                      : u.sector==='LIMPEZA'  ? 'var(--limp)'
                      : 'var(--comp)';
    const sectorBg    = u.sector==='MONTAGEM' ? 'rgba(79,142,247,.12)'
                      : u.sector==='LIMPEZA'  ? 'rgba(61,214,140,.12)'
                      : 'rgba(245,166,35,.12)';

    const card = document.createElement('div');
    card.className = 'selb-alert-card';
    card.dataset.uid = u.id;
    // Borda vermelha para idle (sem SELB)
    card.style.borderColor = 'rgba(242,87,87,.5)';
    card.style.borderLeftColor = 'var(--danger)';

    card.innerHTML = `
      <div class="selb-alert-icon" style="animation:none">⚠️</div>
      <div class="selb-alert-body">
        <div class="selb-alert-title" style="color:var(--danger)">
          <span class="selb-alert-dot" style="background:var(--danger);box-shadow:0 0 6px rgba(242,87,87,.7)"></span>
          Sem SELB em andamento
        </div>
        <div class="selb-alert-name">${u.name}</div>
        <div class="selb-alert-meta">
          <span class="selb-alert-sector" style="background:${sectorBg};color:${sectorColor}">${u.sector}</span>
          <span style="font-size:10px;color:var(--muted)">PIN ${u.pin}</span>
        </div>
      </div>
      ${isAdmin
        ? `<button class="selb-alert-adm-stop" onclick="admRemoverAlerta('${u.id}',this)">✕ Remover</button>`
        : ''
      }`;
    return card;
  }

  function dismissCardAnim(card){
    card.classList.add('dismissing');
    setTimeout(() => { if(card.parentNode) card.parentNode.removeChild(card); }, 260);
  }

  // ── Admin remove o alerta — persiste no Firebase ──────────────────────────
  window.admRemoverAlerta = async function(uid, btn){
    if(!currentUser || !currentUser.isAdmin) return;
    if(btn){ btn.disabled = true; btn.textContent = '…'; }
    const ts = Date.now();
    _dismissed.set(uid, ts);
    try { await dbPatch('/alerts/dismissed', { [uid]: ts }); } catch(e){}
    const card = document.querySelector(`#selb-alert-panel [data-uid="${uid}"]`);
    if(card) dismissCardAnim(card);
  };

  // ── Ouve /alerts/dismissed no Firebase (sincroniza entre janelas) ──────────
  let _alertsListener = null;
  function startAlertsListener(){
    if(_alertsListener) return;
    _alertsListener = _db.ref('/alerts/dismissed').on('value', snap => {
      if(!snap.exists()) return;
      const data = snap.val();
      Object.entries(data).forEach(([uid, ts]) => {
        // Só aplica se for mais recente que o que já temos
        if(ts > (_dismissed.get(uid) || 0)){
          _dismissed.set(uid, ts);
          const card = document.querySelector(`#selb-alert-panel [data-uid="${uid}"]`);
          if(card && !card.classList.contains('dismissing')) dismissCardAnim(card);
        }
      });
    });
  }

  // ── Hook no updateSummary para re-renderizar alertas ─────────────────────
  const _origUpdateSummary = window.updateSummary;
  window.updateSummary = function(){
    if(_origUpdateSummary) _origUpdateSummary.apply(this, arguments);
    renderAlerts();
  };

  // ── Inicia após login ─────────────────────────────────────────────────────
  const _origLoginAs = window.loginAs;
  window.loginAs = function(u){
    if(_origLoginAs) _origLoginAs.apply(this, arguments);
    startAlertsListener();
    startMaquinasPerdidasListener();
    startMaquinasAListener();
    startSolicitacoesPecasListener();
    startGarantiaListener();
    startDevolucaoListener();
    // Painel de alertas "sem SELB em andamento" desativado
    const _pnl = document.getElementById('selb-alert-panel');
    if(_pnl) _pnl.innerHTML = '';
  };

  // ── Para ao fazer logout ──────────────────────────────────────────────────
  const _origLogout = window.logout;
  window.logout = function(){
    if(_alertTimerInterval){ clearInterval(_alertTimerInterval); _alertTimerInterval = null; }
    _dismissed.clear();
    _idleSince.clear();
    _maquinasA = {};
    const panel = document.getElementById('selb-alert-panel');
    if(panel) panel.innerHTML = '';
    if(_origLogout) _origLogout.apply(this, arguments);
  };

})();

// ==========================================
// RELATÓRIO DE DUPLICADOS
// ==========================================
let _duplicadosAllRecs = null;
async function _loadDuplicadosByGlobalDate(){
  const ffromElement = document.getElementById('global-date-from');
  const ftoElement   = document.getElementById('global-date-to');
  if(!ffromElement || !ftoElement) return;
  const ffrom = ffromElement.value;
  const fto = ftoElement.value;
  if(!ffrom || !fto) return;
  const keys = dateRangeKeys(ffrom, fto);

  const userSelect = document.getElementById('duplicados-user');
  if(userSelect) userSelect.innerHTML = '<option value="">Todos os profissionais</option>';

  const loader = document.getElementById('duplicados-loading');
  if(loader) loader.style.display = 'block';

  let all = [];
  try {
    const promises = keys.map(k => dbGet('/history/'+k).then(d=>{
      if(d) Object.entries(d).forEach(([id, r])=>{ r._docId=id; r._dateKey=k; all.push(r); });
    }).catch(()=>{}));
    await Promise.all(promises);
    _duplicadosAllRecs = all.filter(r => r.status === 'ok' && r.selb && r.selb.length > 2);
  } catch(e) { console.error('Erro ao carregar duplicados:', e); }

  if(loader) loader.style.display = 'none';
}

function renderDuplicados(){
  const tbody = document.getElementById('duplicados-body');
  const userSelect = document.getElementById('duplicados-user');
  if(!tbody) return;
  
  if(!_duplicadosAllRecs || _duplicadosAllRecs.length === 0){
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">Nenhum registro encontrado no período.</td></tr>';
    return;
  }

  const grouped = {};
  for(const r of _duplicadosAllRecs){
    const key = r.uid + '||' + r.selb.toUpperCase().trim();
    if(!grouped[key]) grouped[key] = { uid: r.uid, selb: r.selb.toUpperCase().trim(), records: [] };
    grouped[key].records.push(r);
  }

  let duplicados = Object.values(grouped).filter(g => g.records.length > 1);

  if(userSelect && userSelect.options.length <= 1) {
    const uidsComDuplicidade = [...new Set(duplicados.map(d => d.uid))];
    const optionsHTML = uidsComDuplicidade.map(uid => {
      const u = users.find(x => x.id === uid);
      return `<option value="${uid}">${u ? u.name : uid}</option>`;
    }).join('');
    userSelect.innerHTML = '<option value="">Todos os profissionais</option>' + optionsHTML;
  }

  if(userSelect && userSelect.value) {
    duplicados = duplicados.filter(d => d.uid === userSelect.value);
  }

  if(duplicados.length === 0){
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--muted)">Nenhum SELB contabilizado em duplicidade para os critérios atuais.</td></tr>';
    return;
  }

  duplicados.sort((a,b) => b.records.length - a.records.length);

  tbody.innerHTML = duplicados.map(g => {
    const u = users.find(x => x.id === g.uid);
    const nome = u ? u.name : 'Desconhecido';
    const setor = u ? u.sector : '—';
    
    const det = g.records.map(r => {
      const isDate = new Date(r.endEpoch || r.startEpoch || Date.now());
      const strDate = isDate.toLocaleDateString('pt-BR');
      const dur = r.duracao || '--:--:--';
      return '<div style="font-size:11px;background:var(--bg3);padding:3px 6px;border-radius:4px;margin-bottom:2px;display:inline-block;margin-right:4px;">' + strDate + ' ⏱️ ' + dur + '</div>';
    }).join('');

    return '<tr><td><div style="font-weight:600;color:var(--accent)">' + nome + '</div></td><td>' + setor + '</td><td><div style="font-family:var(--mono);font-weight:600;color:var(--text)">' + g.selb + '</div></td><td><span style="background:var(--warn);color:#000;padding:2px 6px;border-radius:6px;font-weight:600;font-size:11px">' + g.records.length + ' vezes</span></td><td>' + det + '</td></tr>';
  }).join('');
}

// ════════════════════════════════════════
// REGISTRO DE SCRAP DIRETO (DESMEMBRAMENTO)
// ════════════════════════════════════════

function abrirModalScrapDireto(){
  // Popula o datalist com os SELBs existentes
  const datalist = document.getElementById('dscrap-selb-list');
  if(datalist){
    const selbsNoSistema = Object.keys(equipamentos).sort();
    datalist.innerHTML = selbsNoSistema.map(s => `<option value="${s}">${s} — ${equipamentos[s]}</option>`).join('');
  }

  // Oculta campo de O.S. para Desmembramento
  const osContainer = document.getElementById('dscrap-os-container');
  if(osContainer){
    osContainer.style.display = currentUser && currentUser.sector === 'DESMEMBRAMENTO' ? 'none' : 'block';
  }

  document.getElementById('dscrap-selb').value = '';
  document.getElementById('dscrap-os').value = '';
  document.getElementById('dscrap-equip').value = '';
  document.getElementById('dscrap-sector').value = currentUser && currentUser.sector === 'DESMEMBRAMENTO' ? 'DESMEMBRAMENTO' : '';
  
  // Date default to today
  document.getElementById('dscrap-data').value = new Date().toISOString().slice(0,10);
  
  document.getElementById('dscrap-motivo').value = '';
  document.getElementById('dscrap-responsavel').value = currentUser ? currentUser.name : '';
  document.getElementById('dscrap-err').textContent = '';
  document.getElementById('dscrap-equip-preview').style.display = 'none';

  document.getElementById('modal-scrap-direto').classList.remove('hidden');
  setTimeout(()=>document.getElementById('dscrap-selb').focus(), 100);
}

function dscrapPreviewEquip(selb){
  const preview = document.getElementById('dscrap-equip-preview');
  const nameEl  = document.getElementById('dscrap-equip-name');
  const equipInput = document.getElementById('dscrap-equip');
  if(selb.length < 3){
    preview.style.display = 'none';
    equipInput.value = '';
    return;
  }
  const nome = getEquipName(selb);
  if(nome){
    nameEl.textContent = nome;
    preview.style.display = 'flex';
    equipInput.value = nome;
  } else {
    preview.style.display = 'none';
  }
}

async function confirmarScrapDireto(){
  const btn = document.querySelector('#modal-scrap-direto button[onclick="confirmarScrapDireto()"]');
  const txtOriginal = btn ? btn.innerHTML : '';
  
  const setBtn = (dis, txt) => {
    if(!btn) return;
    btn.disabled = dis;
    if(txt !== undefined) btn.innerHTML = txt;
  };

  if(window._submittingSelb) return;
  window._submittingSelb = true;

  if(btn && btn.disabled) {
    window._submittingSelb = false;
    return;
  }
  setBtn(true, '🗑️ Validando...');

  const selb = document.getElementById('dscrap-selb').value.trim();
  const osNum = document.getElementById('dscrap-os').value.trim();
  const equip = document.getElementById('dscrap-equip').value.trim();
  const sector = document.getElementById('dscrap-sector').value;
  const data = document.getElementById('dscrap-data').value;
  const motivo = document.getElementById('dscrap-motivo').value.trim();
  const responsavel = document.getElementById('dscrap-responsavel').value.trim();
  const err = document.getElementById('dscrap-err');

  if(!selb){ err.textContent = 'Informe o SELB.'; window._submittingSelb = false; setBtn(false, txtOriginal); return; }
  if(!sector){ err.textContent = 'Selecione o setor.'; window._submittingSelb = false; setBtn(false, txtOriginal); return; }
  if(!data){ err.textContent = 'Informe a data do descarte.'; window._submittingSelb = false; setBtn(false, txtOriginal); return; }
  if(!motivo){ err.textContent = 'Descreva o motivo do descarte.'; window._submittingSelb = false; setBtn(false, txtOriginal); return; }

  // ── Anti-Fraude / Duplicidade Realtime ──
  const now = Date.now();
  const duplicate = history.find(h => h.selb === selb && h.status === 'scrap' && (now - (h.ts || 0)) < 15000);
  if(duplicate){
    err.textContent = 'Este SELB já foi descartado recentemente.';
    window._submittingSelb = false; setBtn(false, txtOriginal);
    return;
  }

  err.textContent = '';
  
  try {
    const [y,m,d] = data.split('-');
    const dt = new Date(y, m-1, d, 12, 0, 0);
    const ts = dt.getTime();
    const dateKey = dt.toDateString().replace(/ /g,'_');
    
    const uid = currentUser ? currentUser.id : 'direto';
    
    const rec = {
      uid: uid,
      name: responsavel || (currentUser ? currentUser.name : 'Registro Direto'),
      pin: (currentUser && currentUser.pin) ? currentUser.pin : '—',
      sector: sector,
      local: (currentUser && currentUser.local) ? currentUser.local : '',
      selb: selb,
      equipamento: equip,
      osNum: osNum,
      motivo: motivo,
      start: '00:00:00',
      end: '00:00:00',
      duracao: '00:00:00',
      startEpoch: ts,
      endEpoch: ts,
      endDateKey: dateKey,
      status: 'scrap',
      ts: ts,
      _direto: true
    };

    const key = firebase.database().ref('/history/'+dateKey).push().key;
    await dbUpdateHistory(key, dateKey, rec);

    // ── FluxoLAB: remove SELB de todos os bolsões ao registrar SCRAP ──
    // SCRAP encerra o ciclo de vida — SELB sai do sistema completamente
    if(selb){
      fluxolabFinalizarSelb(selb, sector, 'scrap').catch(e =>
        console.warn('[FluxoLAB] Erro ao remover SCRAP dos bolsões:', e)
      );
    }

    if(window._currentRelSubTab === 'scrap') {
      loadScrapByDate().then(()=>renderScrapRel());
    }
  } catch(e) {
    err.textContent = 'Erro: ' + e.message;
    console.error('Erro no descarte direto:', e);
  } finally {
    window._submittingSelb = false;
    const btn = document.querySelector('#modal-scrap-direto button[onclick="confirmarScrapDireto()"]');
    if(btn) { btn.disabled = false; btn.innerHTML = '🗑️ Descartar e Finalizar'; }
  }
}

// ════════════════════════════════════════════════════════════════════
// QUALIDADE — Registros de inspeção (antigo Gaiola LAB)
// Firebase path: /qualidade_registros/{id}
// ════════════════════════════════════════════════════════════════════

let _qualRegistros = {};  // cache local

// ── Carrega registros do Firebase e monta o listener em tempo real ──
function _initQualListener(){
  if(!_db) return;
  _db.ref('/qualidade_registros').on('value', snap => {
    _qualRegistros = snap.val() || {};
    _fluxolabScheduleSyncLiberados();
    const view = document.getElementById('view-gaiola-lab');
    if(view && view.classList.contains('active')) renderQualRegistros();
  });
  // Listener para LIBERADAS (inseridos manualmente)
  window._qualLiberadas = window._qualLiberadas || {};
  _db.ref('/qualidade_liberadas').on('value', snap => {
    window._qualLiberadas = snap.val() || {};
    _fluxolabScheduleSyncLiberados();
    const view = document.getElementById('view-gaiola-lab');
    if(view && view.classList.contains('active')) renderQualRegistros();
    // Atualiza painel de listagem se estiver aberto
    const libPanel = document.getElementById('qual-lib-panel-overlay');
    if(libPanel && libPanel.style.display !== 'none' && typeof _qualRenderLiberadasList === 'function') _qualRenderLiberadasList();
  });
}

// Chama o listener quando o app inicializar (após bootApp)
const _origBootApp = window.bootApp;
window.bootApp = function(){
  if(_origBootApp) _origBootApp.apply(this, arguments);
  setTimeout(_initQualListener, 1500);
};

// ── Preenche equipamento automaticamente ao digitar o SELB ──
function qualAutoFillSelb(){
  const selb = (document.getElementById('qual-reg-selb')?.value || '').toUpperCase().trim();
  const equipEl = document.getElementById('qual-reg-equip');
  const serieEl = document.getElementById('qual-reg-serie');
  const skuEl   = document.getElementById('qual-reg-sku');
  if(!equipEl) return;
  if(!selb){
    equipEl.value = ''; equipEl.style.color = 'var(--muted)';
    if(serieEl){ serieEl.value = ''; serieEl.style.color = 'var(--muted)'; }
    if(skuEl){ skuEl.value = ''; skuEl.style.color = 'var(--muted)'; }
    return;
  }
  // 1º tenta no dicionário de equipamentos (mais preciso)
  const dictNome  = getEquipName(selb);
  const dictSerie = getEquipSerie(selb);
  const dictSku   = getEquipSku(selb);
  let match = null;
  if(dictNome){
    equipEl.value = dictNome;
    equipEl.style.color = 'var(--text)';
  } else {
    // Fallback: busca no histórico
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    match = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(match && match.equipamento){
      equipEl.value = match.equipamento;
      equipEl.style.color = 'var(--text)';
    } else {
      equipEl.value = '';
      equipEl.style.color = 'var(--muted)';
    }
  }
  let finalSerie = dictSerie;
  if(!finalSerie){
    // Caso não esteja no dict, busca também no histórico
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    const histMatch = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(histMatch && histMatch.serie){
      finalSerie = histMatch.serie;
    }
  }
  if(serieEl){
    if(finalSerie){
      serieEl.value = finalSerie;
      serieEl.style.color = 'var(--text)';
    } else {
      serieEl.value = '';
      serieEl.style.color = 'var(--muted)';
    }
  }
  
  let finalSku = dictSku;
  if(!finalSku){
    // Caso não esteja no dict, busca no histórico
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    const histMatch = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(histMatch && histMatch.sku){
      finalSku = histMatch.sku;
    }
  }
  if(skuEl){
    if(finalSku){
      skuEl.value = finalSku;
      skuEl.style.color = 'var(--text)';
    } else {
      skuEl.value = '';
      skuEl.style.color = 'var(--muted)';
    }
  }
}

// ── Salva um novo registro de qualidade ──
async function salvarQualRegistro(){
  const selb     = (document.getElementById('qual-reg-selb')?.value || '').toUpperCase().trim();
  const contador_pb = (document.getElementById('qual-reg-contador-pb')?.value || '').trim();
  const contador_color = (document.getElementById('qual-reg-contador-color')?.value || '').trim();
  const equip    = (document.getElementById('qual-reg-equip')?.value || '').trim();
  const serie    = (document.getElementById('qual-reg-serie')?.value || '').trim();
  const sku      = (document.getElementById('qual-reg-sku')?.value || '').trim();
  const obs      = (document.getElementById('qual-reg-obs')?.value || '').trim();
  const errEl    = document.getElementById('qual-reg-err');

  // Validação
  if(!selb){
    errEl.textContent = '⚠️ Informe o SELB.';
    errEl.style.display = 'block';
    document.getElementById('qual-reg-selb').focus();
    return;
  }
  if(!getEquipName(selb)){
    errEl.textContent = '⚠️ SELB "' + selb + '" não encontrado no sistema. Importe a planilha de equipamentos primeiro.';
    errEl.style.display = 'block';
    document.getElementById('qual-reg-selb').focus();
    return;
  }
  if(contador_pb === '' || isNaN(Number(contador_pb)) || Number(contador_pb) < 0){
    errEl.textContent = '⚠️ Informe um contador PB válido (número ≥ 0).';
    errEl.style.display = 'block';
    document.getElementById('qual-reg-contador-pb').focus();
    return;
  }
  if(contador_color !== '' && (isNaN(Number(contador_color)) || Number(contador_color) < 0)){
    errEl.textContent = '⚠️ Informe um contador Color válido (número ≥ 0).';
    errEl.style.display = 'block';
    document.getElementById('qual-reg-contador-color').focus();
    return;
  }
  const now = new Date();
  const todayStr = now.toLocaleDateString('pt-BR');
  
  // Valida duplicidade do SELB no mesmo dia (exceto AUDITORIA, que pode repetir)
  const isAuditoria = obs.toUpperCase() === 'AUDITORIA';
  const isDuplicate = !isAuditoria && Object.values(_qualRegistros || {}).some(r =>
    (r.selb || '').toUpperCase().trim() === selb && r.data === todayStr
  );

  if(isDuplicate){
    errEl.textContent = `⚠️ O SELB "${selb}" já foi registrado hoje (${todayStr}).`;
    errEl.style.display = 'block';
    document.getElementById('qual-reg-selb').focus();
    return;
  }

  errEl.style.display = 'none';
  const registro = {
    selb,
    equipamento : equip || '—',
    serie       : serie || '',
    sku         : sku || '',
    contador_pb : Number(contador_pb),
    contador    : Number(contador_pb), // retrocompatibilidade
    contador_color : contador_color !== '' ? Number(contador_color) : null,
    obs         : obs || '',
    responsavel : currentUser ? currentUser.name : 'Desconhecido',
    uid         : currentUser ? currentUser.id : '',
    ts          : now.getTime(),
    data        : now.toLocaleDateString('pt-BR'),
    hora        : now.toLocaleTimeString('pt-BR'),
    dateKey     : now.toDateString().replace(/ /g,'_'),
  };

  try {
    const btn = document.querySelector('#view-gaiola-lab .bp');
    if(btn){ btn.disabled = true; btn.textContent = 'Salvando...'; }
    await dbPush('/qualidade_registros', registro);

    // FluxoLAB: ao incluir registro na Qualidade, move o SELB de QUALIDADE → LIBERADAS.
    // O SELB sai de LIBERADAS definitivamente quando a etiqueta for marcada como concluída.
    if(selb){
      fluxolabFinalizarSelb(selb, 'QUALIDADE', 'ok').catch(e => console.warn('[FluxoLAB] Erro ao mover SELB para LIBERADAS:', e));
    }

    // Limpa form
    document.getElementById('qual-reg-selb').value     = '';
    document.getElementById('qual-reg-equip').value    = '';
    const serEl = document.getElementById('qual-reg-serie');
    if(serEl){ serEl.value = ''; serEl.style.color = 'var(--muted)'; }
    const skuEl = document.getElementById('qual-reg-sku');
    if(skuEl){ skuEl.value = ''; skuEl.style.color = 'var(--muted)'; }
    document.getElementById('qual-reg-contador-pb').value = '';
    document.getElementById('qual-reg-contador-color').value = '';
    document.getElementById('qual-reg-obs').value      = '';
    if(btn){ btn.disabled = false; btn.textContent = '💾 Salvar'; }
  } catch(e){
    errEl.textContent = 'Erro ao salvar: ' + e.message;
    errEl.style.display = 'block';
    const btn = document.querySelector('#view-gaiola-lab .bp');
    if(btn){ btn.disabled = false; btn.textContent = '💾 Salvar'; }
  }
}

// ── Remove registro ──
async function excluirQualRegistro(id){
  if(!currentUser || !currentUser.isAdmin){ alert('Apenas administradores podem remover registros.'); return; }
  if(!confirm('Excluir este registro de qualidade?')) return;
  try {
    await _db.ref('/qualidade_registros/' + id).remove();
  } catch(e){ alert('Erro ao excluir: ' + e.message); }
}

// ── Marca/desmarca registro como "chamado aberto" ──
async function toggleChamadoAberto(id, novoValor){
  try {
    if(!(currentUser && currentUser.isAdmin)){
      alert('Apenas administradores podem alterar registros.');
      return;
    }
    const abrir = !!novoValor;
    const msg = abrir
      ? 'Deseja realmente ABRIR chamado para este registro?'
      : 'Deseja realmente FECHAR o chamado deste registro?';
    if(!confirm(msg)) return;
    await _db.ref('/qualidade_registros/' + id).update({
      chamado_aberto: abrir,
      chamado_aberto_ts: novoValor ? Date.now() : null,
      chamado_aberto_by: novoValor && currentUser ? currentUser.name : null,
    });
  } catch(e){ alert('Erro ao atualizar chamado: ' + e.message); }
}

// ── Alterna o filtro "Aberto Chamado" (ignora data, mostra todos com chamado aberto) ──
window.toggleFilterChamado = function(){
  window._qualFilterChamado = !window._qualFilterChamado;
  renderQualRegistros();
};
window.toggleFilterConcluidos = function(){
  window._qualFilterConcluidos = !window._qualFilterConcluidos;
  if(window._qualFilterConcluidos){ window._qualFilterPendentes=false; window._qualFilterChamado=false; }
  renderQualRegistros();
};
window.toggleFilterPendentes = function(){
  window._qualFilterPendentes = !window._qualFilterPendentes;
  if(window._qualFilterPendentes){ window._qualFilterConcluidos=false; window._qualFilterChamado=false; }
  renderQualRegistros();
};

// ── Marca/desmarca manualmente etiqueta como impressa, com confirmação ──
window.toggleEtiquetaImpressaManual = async function(regId, checked, el){
  try {
    const allowed = currentUser && (currentUser.isAdmin || currentUser.sector === 'DESMEMBRAMENTO');
    if(!allowed){
      alert('Apenas administradores ou o setor Desmembramento podem alterar este status.');
      if(el) el.checked = !checked;
      return;
    }
    const msg = checked
      ? 'Marcar este SELB como CONCLUÍDO (etiqueta impressa)?'
      : 'Reverter este SELB para PENDENTE (etiqueta não impressa)?';
    if(!confirm(msg)){
      if(el) el.checked = !checked;
      return;
    }
    await _db.ref('/qualidade_registros/' + regId).update(
      checked
        ? { etiqueta_impressa: true, etiqueta_impressa_ts: Date.now(), etiqueta_impressa_by: currentUser.name || null }
        : { etiqueta_impressa: false, etiqueta_impressa_ts: null, etiqueta_revertida_ts: Date.now(), etiqueta_revertida_by: currentUser.name || null }
    );

    // ── FluxoLAB: SELB sai de LIBERADAS apenas quando etiqueta é marcada como concluída ──
    if(checked){
      // Busca o registro para obter o SELB
      const reg = Object.values(_qualRegistros || {}).find(r => r._id === regId || r._key === regId)
               || await _db.ref('/qualidade_registros/' + regId).once('value').then(s => s.val()).catch(() => null);
      const selbToRelease = reg ? (reg.selb || '') : '';
      if(selbToRelease){
        fluxolabRemoveSelbGlobal(selbToRelease).then(() => {
          _fluxolabLogEntry(selbToRelease, 'LIBERADAS', '—', reg.equipamento || '');
        }).catch(e => console.warn('[FluxoLAB] Erro ao liberar SELB de LIBERADAS:', e));
      }
    }
  } catch(e){
    alert('Erro ao atualizar: ' + e.message);
    if(el) el.checked = !checked;
  }
};
window.toggleChamadoAberto = toggleChamadoAberto;

// ── Reverte etiqueta marcada como impressa (admin) ──
async function reverterEtiquetaImpressa(id){
  try {
    if(!(currentUser && currentUser.isAdmin)){
      alert('Apenas administradores podem reverter a etiqueta.');
      return;
    }
    if(!confirm('Reverter o status de etiqueta IMPRESSA deste registro?\n\nEle voltará a aparecer como pendente de impressão.')) return;
    await _db.ref('/qualidade_registros/' + id).update({
      etiqueta_impressa: false,
      etiqueta_impressa_ts: null,
      etiqueta_revertida_ts: Date.now(),
      etiqueta_revertida_by: currentUser ? currentUser.name : null,
    });

    // ── FluxoLAB: ao reverter, devolve SELB para bolsão LIBERADAS ──
    const reg = Object.values(_qualRegistros || {}).find(r => r._id === id || r._key === id)
             || await _db.ref('/qualidade_registros/' + id).once('value').then(s => s.val()).catch(() => null);
    const selbToReturn = reg ? (reg.selb || '') : '';
    if(selbToReturn){
      const selfKey = selbToReturn.replace(/[^a-zA-Z0-9_-]/g, '_');
      const equipNome = reg.equipamento || (typeof getEquipName === 'function' ? getEquipName(selbToReturn) : '') || '';
      await dbSet('/fluxolab/LIBERADAS/' + selfKey, {
        selb:        selbToReturn,
        uid:         currentUser ? currentUser.id : '',
        userName:    currentUser ? currentUser.name : '',
        sector:      'QUALIDADE',
        equipamento: equipNome,
        ts:          Date.now(),
        origem:      'QUALIDADE',
        resultado:   'ok',
      }).catch(e => console.warn('[FluxoLAB] Erro ao devolver SELB para LIBERADAS:', e));
      _fluxolabLogEntry(selbToReturn, '—', 'LIBERADAS', equipNome);
    }
  } catch(e){ alert('Erro ao reverter etiqueta: ' + e.message); }
}
window.reverterEtiquetaImpressa = reverterEtiquetaImpressa;

window.copiarSelbsQualidade = function() {
  const trs = document.querySelectorAll('#qual-reg-body tr[data-selb]');
  if(!trs.length) {
    alert('Nenhum SELB para copiar na tabela atual.');
    return;
  }
  const selbs = [];
  trs.forEach(tr => {
    const s = tr.getAttribute('data-selb');
    if(s && s !== 'undefined' && s !== '—') selbs.push(s);
  });
  if(!selbs.length) {
    alert('Nenhum SELB válido encontrado.');
    return;
  }
  const texto = selbs.join('\n');
  navigator.clipboard.writeText(texto).then(() => {
    alert(selbs.length + ' SELBs copiados com sucesso!');
  }).catch(e => {
    alert('Erro ao copiar: ' + e);
  });
};

// ── Renderiza tabela de registros ──
function renderQualRegistros(){
  const tbody = document.getElementById('qual-reg-body');
  if(!tbody) return;

  // Inicializa o filtro de data com o dia de hoje se estiver vazio
  const dateFilter = document.getElementById('qual-reg-date-filter');
  if(dateFilter && !dateFilter.value){
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    dateFilter.value = `${yyyy}-${mm}-${dd}`;
  }

  const q = (document.getElementById('qual-reg-search')?.value || '').toUpperCase().trim();

  // Converte data do filtro para o formato DD/MM/YYYY
  let targetDateStr = '';
  if(dateFilter && dateFilter.value){
    const [yyyy, mm, dd] = dateFilter.value.split('-');
    targetDateStr = `${dd}/${mm}/${yyyy}`;
  }

  // Estatísticas — serão calculadas APÓS filtrar as entries (ver abaixo após montar entries)
  // Placeholders para uso posterior
  let totalConcluidas = 0, totalDia = 0, totalChamados = 0, totalPendentesCalc = 0;

  // Atualiza elementos de estatísticas
  const statsLiberados = document.getElementById('qual-stats-liberados');
  if(statsLiberados) statsLiberados.textContent = totalDia;
  // Injeta (uma única vez) o card "Aberto Chamado" ao lado do card Liberados
  let statsChamado = document.getElementById('qual-stats-chamado');
  if(!statsChamado && statsLiberados){
    const liberadosCard = statsLiberados.closest('.sum-card') || statsLiberados.parentElement;
    if(liberadosCard && liberadosCard.parentElement){
      const card = document.createElement('div');
      card.className = liberadosCard.className || 'sum-card';
      card.id = 'qual-card-chamado';
      card.setAttribute('style', (liberadosCard.getAttribute('style')||'') + ';border-color:rgba(245,166,35,.35);cursor:pointer;transition:all .15s');
      card.title = 'Clique para filtrar apenas chamados abertos';
      card.onclick = function(){ window.toggleFilterChamado(); };
      card.innerHTML = `
        <div class="slbl" style="color:#f5a623;letter-spacing:.08em;font-size:11px;font-weight:700">ABERTO CHAMADO</div>
        <div class="sval" id="qual-stats-chamado" style="color:#f5a623;font-size:28px;font-weight:800">0</div>`;
      liberadosCard.insertAdjacentElement('afterend', card);
      statsChamado = document.getElementById('qual-stats-chamado');
    }
  }
  if(statsChamado) statsChamado.textContent = totalChamados;

  // Cards "SELBs Concluídos" e "Pendentes"
  const cardChamadoRef = document.getElementById('qual-card-chamado');
  let statsConcl = document.getElementById('qual-stats-concluidos');
  if(!statsConcl && cardChamadoRef){
    const card = document.createElement('div');
    card.className = cardChamadoRef.className || 'sum-card';
    card.id = 'qual-card-concluidos';
    card.setAttribute('style', (cardChamadoRef.getAttribute('style')||'').replace(/border-color:[^;]+;?/,'') + ';border-color:rgba(74,222,128,.35);cursor:pointer;transition:all .15s');
    card.title = 'Clique para filtrar apenas SELBs concluídos (etiqueta impressa)';
    card.onclick = function(){ if(typeof window.toggleFilterConcluidos==='function') window.toggleFilterConcluidos(); };
    card.innerHTML = `
      <div class="slbl" style="color:#4ade80;letter-spacing:.08em;font-size:11px;font-weight:700">SELBs CONCLUÍDOS</div>
      <div class="sval" id="qual-stats-concluidos" style="color:#4ade80;font-size:28px;font-weight:800">0</div>`;
    cardChamadoRef.insertAdjacentElement('afterend', card);
    statsConcl = document.getElementById('qual-stats-concluidos');
  }
  const cardConclRef = document.getElementById('qual-card-concluidos');
  let statsPend = document.getElementById('qual-stats-pendentes');
  if(!statsPend && cardConclRef){
    const card = document.createElement('div');
    card.className = cardConclRef.className || 'sum-card';
    card.id = 'qual-card-pendentes';
    card.setAttribute('style', (cardConclRef.getAttribute('style')||'').replace(/border-color:[^;]+;?/,'') + ';border-color:rgba(167,139,250,.35);cursor:pointer;transition:all .15s');
    card.title = 'Clique para filtrar apenas pendentes (etiqueta não impressa)';
    card.onclick = function(){ if(typeof window.toggleFilterPendentes==='function') window.toggleFilterPendentes(); };
    card.innerHTML = `
      <div class="slbl" style="color:#a78bfa;letter-spacing:.08em;font-size:11px;font-weight:700">PENDENTES</div>
      <div class="sval" id="qual-stats-pendentes" style="color:#a78bfa;font-size:28px;font-weight:800">0</div>`;
    cardConclRef.insertAdjacentElement('afterend', card);
    statsPend = document.getElementById('qual-stats-pendentes');
  }
  if(statsConcl) statsConcl.textContent = totalConcluidas;
  if(statsPend)  statsPend.textContent  = totalPendentesCalc;

  // ── Card CHECKLIST — somatório do facilitador de impressão (incrementa ao imprimir) ──
  const cardPendRef = document.getElementById('qual-card-pendentes');
  let statsChk = document.getElementById('qual-stats-checklist');
  if(!statsChk && cardPendRef){
    const card = document.createElement('div');
    card.className = cardPendRef.className || 'sum-card';
    card.id = 'qual-card-checklist';
    card.setAttribute('style', (cardPendRef.getAttribute('style')||'').replace(/border-color:[^;]+;?/,'') + ';border-color:rgba(34,211,238,.35)');
    card.title = 'Total de etiquetas enviadas para impressão no facilitador hoje';
    card.innerHTML = '<div class="slbl" style="color:#22d3ee;letter-spacing:.08em;font-size:11px;font-weight:700">CHECKLIST</div>'
      + '<div class="sval" id="qual-stats-checklist" style="color:#22d3ee;font-size:28px;font-weight:800">0</div>';
    cardPendRef.insertAdjacentElement('afterend', card);
    statsChk = document.getElementById('qual-stats-checklist');
  }
  // Carrega o valor do dia do Firebase
  qualLoadChecklistCount();

  // ── Card LIBERADAS — SELBs inseridos manualmente como liberados ──
  const cardChkRef = document.getElementById('qual-card-checklist');
  let statsLib = document.getElementById('qual-stats-liberadas');
  if(!statsLib && cardChkRef){
    const card = document.createElement('div');
    card.className = cardChkRef.className || 'sum-card';
    card.id = 'qual-card-liberadas';
    card.setAttribute('style', (cardChkRef.getAttribute('style')||'').replace(/border-color:[^;]+;?/,'') + ';border-color:rgba(236,72,153,.4);cursor:pointer;transition:all .15s');
    card.title = 'Clique para inserir SELBs liberados manualmente';
    card.onclick = function(){ window.qualOpenLiberadasPanel && window.qualOpenLiberadasPanel(); };
    card.innerHTML = '<div class="slbl" style="color:#ec4899;letter-spacing:.08em;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:space-between;gap:6px">LIBERADAS<span style="font-size:14px">＋</span></div>'
      + '<div class="sval" id="qual-stats-liberadas" style="color:#ec4899;font-size:28px;font-weight:800">0</div>';
    cardChkRef.insertAdjacentElement('afterend', card);
    statsLib = document.getElementById('qual-stats-liberadas');
  }
  // Conta liberadas do dia
  if(statsLib){
    const libs = Object.values(window._qualLiberadas || {});
    const libsDia = targetDateStr ? libs.filter(r => r.data === targetDateStr) : libs;
    statsLib.textContent = libsDia.length;
  }

  const cardConcl = document.getElementById('qual-card-concluidos');
  if(cardConcl){
    if(window._qualFilterConcluidos){
      cardConcl.style.boxShadow = '0 0 0 2px rgba(74,222,128,0.65), 0 6px 20px rgba(74,222,128,0.25)';
      cardConcl.style.background = 'linear-gradient(135deg, rgba(74,222,128,0.18), rgba(74,222,128,0.06))';
    } else { cardConcl.style.boxShadow=''; cardConcl.style.background=''; }
  }
  const cardPend = document.getElementById('qual-card-pendentes');
  if(cardPend){
    if(window._qualFilterPendentes){
      cardPend.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.65), 0 6px 20px rgba(167,139,250,0.25)';
      cardPend.style.background = 'linear-gradient(135deg, rgba(167,139,250,0.18), rgba(167,139,250,0.06))';
    } else { cardPend.style.boxShadow=''; cardPend.style.background=''; }
  }

  // Destaque visual quando o filtro de chamados está ativo
  const cardChamado = document.getElementById('qual-card-chamado');
  if(cardChamado){
    if(window._qualFilterChamado){
      cardChamado.style.boxShadow = '0 0 0 2px rgba(245,166,35,0.65), 0 6px 20px rgba(245,166,35,0.25)';
      cardChamado.style.background = 'linear-gradient(135deg, rgba(245,166,35,0.18), rgba(245,166,35,0.06))';
    } else {
      cardChamado.style.boxShadow = '';
      cardChamado.style.background = '';
    }
  }

  // Conjunto base filtrado por data (e busca) — sem filtro de status —
  // usado para calcular os totais dos cards sempre referente ao filtro ativo
  const allValues = Object.values(_qualRegistros);
  const baseFiltered = allValues.filter(r => {
    if(targetDateStr && r.data !== targetDateStr) return false;
    if(q && !(r.selb||'').toUpperCase().includes(q) && !(r.equipamento||'').toUpperCase().includes(q)) return false;
    return true;
  });
  totalDia        = baseFiltered.length;
  totalConcluidas = baseFiltered.filter(r => r.etiqueta_impressa).length;
  totalChamados   = baseFiltered.filter(r => r.chamado_aberto).length;
  // Pendentes: todas as datas (não filtra por data)
  totalPendentesCalc = allValues.filter(r => {
    if(q && !(r.selb||'').toUpperCase().includes(q) && !(r.equipamento||'').toUpperCase().includes(q)) return false;
    return !r.etiqueta_impressa;
  }).length;

  if(statsLiberados) statsLiberados.textContent = totalDia;
  if(statsChamado)   statsChamado.textContent   = totalChamados;
  if(statsConcl)     statsConcl.textContent     = totalConcluidas;
  if(statsPend)      statsPend.textContent      = totalPendentesCalc;

  const entries = Object.entries(_qualRegistros)
    .map(([id, r]) => ({...r, _id: id}))
    .filter(r => {
      if(window._qualFilterChamado){
        if(!r.chamado_aberto) return false;
      } else if(window._qualFilterConcluidos){
        if(!r.etiqueta_impressa) return false;
      } else if(window._qualFilterPendentes){
        if(r.etiqueta_impressa) return false;
      } else if(!q && targetDateStr && r.data !== targetDateStr) return false;
      if(q && !(r.selb||'').toUpperCase().includes(q) && !(r.equipamento||'').toUpperCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));  // mais recentes primeiro

  if(!entries.length){
    tbody.innerHTML = `<tr><td colspan="8" class="empty">Nenhum registro de qualidade encontrado para os filtros selecionados.</td></tr>`;
    return;
  }

  tbody.innerHTML = entries.map(r => {
    const isAdmin = !!(currentUser && currentUser.isAdmin);
    const canPrintLabel = isAdmin || !!(currentUser && (currentUser.sector === 'DESMEMBRAMENTO' || currentUser.sector === 'PCP'));
    const canDelete = isAdmin;
    const chamado = !!r.chamado_aberto;
    return `
    <tr data-selb="${r.selb || ''}" style="${chamado ? 'border-left:3px solid #f5a623;background:linear-gradient(90deg,rgba(245,166,35,0.18) 0%,rgba(245,166,35,0.04) 100%);box-shadow:inset 0 0 0 1px rgba(245,166,35,0.25)' : (r.etiqueta_impressa ? 'border-left:3px solid #4ade80;background:linear-gradient(90deg,rgba(74,222,128,0.22) 0%,rgba(74,222,128,0.08) 100%);box-shadow:inset 0 0 0 1px rgba(74,222,128,0.25)' : 'border-left:3px solid rgba(74,222,128,0.55);background:linear-gradient(90deg,rgba(74,222,128,0.04) 0%,transparent 60%)')}">
      <td style="font-family:var(--mono);font-size:12px;white-space:nowrap">${r.data || '—'}<br><span style="color:var(--muted);font-size:10px">${r.hora || ''}</span></td>
      <td style="font-family:var(--mono);font-weight:700;color:var(--accent);white-space:nowrap">${r.selb || '—'}${r.selb ? `<button onclick="(function(btn,val){navigator.clipboard.writeText(val).then(function(){var o=btn.textContent;btn.textContent='✓';btn.style.color='var(--accent2)';setTimeout(function(){btn.textContent=o;btn.style.color='';},1500)}).catch(function(){});})(this,'${r.selb}')" title="Copiar SELB" style="margin-left:6px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:var(--muted);font-size:10px;font-weight:600;padding:1px 5px;cursor:pointer;transition:all .15s">⧉</button>` : ''}</td>
      <td style="font-size:12px;color:var(--muted);max-width:240px">
        ${r.equipamento || '—'}
        ${(r.serie || getEquipSerie(r.selb)) ? `<br><span style="font-family:var(--mono);font-size:10px;color:var(--accent);opacity:.85;letter-spacing:.03em">S/N: ${r.serie || getEquipSerie(r.selb)}</span>` : ''}
        ${getEquipSku(r.selb) ? `<br><span style="font-family:var(--mono);font-size:10px;color:var(--accent2);opacity:.85;letter-spacing:.03em">SKU: ${getEquipSku(r.selb)}</span>` : ''}
      </td>
      <td style="font-size:12px">${r.responsavel || '—'}</td>
      <td style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text);text-align:right;white-space:nowrap;line-height:1.4">
        PB: ${Number(r.contador_pb ?? r.contador ?? 0).toLocaleString('pt-BR')}
        <button onclick="(function(btn,val){navigator.clipboard.writeText(val).then(function(){var o=btn.textContent;btn.textContent='✓';btn.style.color='var(--accent2)';setTimeout(function(){btn.textContent=o;btn.style.color='';},1500)}).catch(function(){});})(this,'${r.contador_pb ?? r.contador ?? 0}')"
          title="Copiar contador PB"
          style="margin-left:4px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:var(--muted);font-size:10px;font-weight:600;padding:1px 5px;cursor:pointer;transition:all .15s">⧉</button>
        ${(r.contador_color != null && r.contador_color !== '') ? `
          <br>
          <span style="color:var(--accent2);font-size:11px">COR: ${Number(r.contador_color).toLocaleString('pt-BR')}</span>
          <button onclick="(function(btn,val){navigator.clipboard.writeText(val).then(function(){var o=btn.textContent;btn.textContent='✓';btn.style.color='var(--accent2)';setTimeout(function(){btn.textContent=o;btn.style.color='';},1500)}).catch(function(){});})(this,'${r.contador_color}')"
            title="Copiar contador Color"
            style="margin-left:4px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.15);border-radius:5px;color:var(--muted);font-size:10px;font-weight:600;padding:1px 5px;cursor:pointer;transition:all .15s">⧉</button>
        ` : ''}
      </td>
      <td style="font-size:12px;color:var(--muted);max-width:220px">${r.obs || '—'}</td>
      <td style="text-align:center">
        <div style="display:flex;flex-direction:column;align-items:center;gap:6px">
          <span style="display:inline-flex;align-items:center;gap:5px;background:rgba(74,222,128,0.12);border:1px solid rgba(74,222,128,0.40);border-radius:20px;padding:4px 10px;font-size:11px;font-weight:700;color:#4ade80;white-space:nowrap;letter-spacing:.02em">
            ✅ Máquina Liberada
          </span>
          ${canPrintLabel ? `<label title="Marcar etiqueta como impressa (concluído)" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;font-weight:600;color:${r.etiqueta_impressa ? '#4ade80' : 'var(--muted)'};user-select:none">
            <input type="checkbox" ${r.etiqueta_impressa ? 'checked' : ''} onchange="toggleEtiquetaImpressaManual('${r._id}', this.checked, this)" style="width:14px;height:14px;cursor:pointer;accent-color:#4ade80">
            Concluída
          </label>` : `<span style="font-size:11px;font-weight:600;color:${r.etiqueta_impressa ? '#4ade80' : 'var(--muted)'}">${r.etiqueta_impressa ? '✓ Concluída' : 'Pendente'}</span>`}
        </div>
      </td>

      <td>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${canPrintLabel ? `<button onclick="qualGerarEtiquetaUnica('${(r.selb||'').replace(/'/g,"\\'")}','${r._id}')"
            title="Gerar etiqueta deste SELB"
            style="background:${r.etiqueta_impressa ? 'rgba(74,222,128,0.18)' : 'rgba(167,139,250,0.12)'};border:1px solid ${r.etiqueta_impressa ? 'rgba(74,222,128,0.5)' : 'rgba(167,139,250,0.4)'};border-radius:7px;color:${r.etiqueta_impressa ? '#4ade80' : 'var(--purple)'};font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">${r.etiqueta_impressa ? '✓ Impressa' : '🏷️ Etiqueta'}</button>` : (r.etiqueta_impressa ? `<span style="background:rgba(74,222,128,0.18);border:1px solid rgba(74,222,128,0.5);border-radius:7px;color:#4ade80;font-size:11px;font-weight:700;padding:4px 10px">✓ Impressa</span>` : '')}
          ${isAdmin && r.etiqueta_impressa ? `<button onclick="reverterEtiquetaImpressa('${r._id}')"
            title="Reverter — etiqueta impressa por engano"
            style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.4);border-radius:7px;color:var(--danger);font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">↺ Reverter</button>` : ''}
          ${(isAdmin || (currentUser && currentUser.sector === 'PCP')) ? `<button onclick="toggleChamadoAberto('${r._id}', ${chamado ? 'false' : 'true'})"
            title="${chamado ? 'Marcar chamado como fechado' : 'Marcar como chamado aberto'}"
            style="background:${chamado ? 'rgba(245,166,35,0.18)' : 'rgba(255,255,255,0.05)'};border:1px solid ${chamado ? 'rgba(245,166,35,0.55)' : 'rgba(255,255,255,0.18)'};border-radius:7px;color:${chamado ? '#f5a623' : 'var(--muted)'};font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">${chamado ? '📞 Chamado aberto' : '📞 Abrir chamado'}</button>` : (chamado ? `<span style="background:rgba(245,166,35,0.18);border:1px solid rgba(245,166,35,0.55);border-radius:7px;color:#f5a623;font-size:11px;font-weight:700;padding:4px 10px">📞 Chamado aberto</span>` : '')}
          ${canDelete ? `<button onclick="qualExcluirRegistro('${r._id}','${(r.selb||'').replace(/'/g,"\\'")}','${(r.equipamento||'').replace(/'/g,"\\'")}')"
            title="Excluir este registro"
            style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.35);border-radius:7px;color:var(--danger);font-size:11px;font-weight:700;padding:4px 10px;cursor:pointer">🗑️ Excluir</button>` : ''}

        </div>
      </td>
    </tr>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════
// QUALIDADE — EXCLUSÃO DE REGISTRO
// ════════════════════════════════════════════════════════════════════
window.qualExcluirRegistro = function(id, selb, equipamento){
  if(!id) return;
  const desc = selb ? `SELB ${selb}${equipamento ? ' — ' + equipamento : ''}` : 'este registro';

  // Overlay de confirmação
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(10,12,20,.85);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg2);border:1px solid rgba(239,68,68,.4);border-radius:18px;padding:26px 28px;min-width:300px;max-width:400px;width:90%;display:flex;flex-direction:column;gap:16px;box-shadow:0 16px 48px rgba(0,0,0,.6)';
  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <span style="font-size:22px">🗑️</span>
      <div style="font-size:15px;font-weight:700;color:var(--text)">Excluir Registro de Qualidade</div>
    </div>
    <div style="font-size:13px;color:var(--muted);line-height:1.6;background:var(--bg3);border-radius:10px;padding:12px 14px">
      Tem certeza que deseja excluir o registro de<br>
      <strong style="color:var(--danger)">${selb || '?'}</strong>${equipamento ? ` — <span style="color:var(--text)">${equipamento}</span>` : ''}?<br>
      <span style="font-size:11px;color:rgba(239,68,68,.7);margin-top:4px;display:block">Esta ação não pode ser desfeita.</span>
    </div>
    <div style="display:flex;gap:10px">
      <button id="_qdel-cancel" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);background:var(--bg3);color:var(--muted);font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
      <button id="_qdel-ok" style="flex:1;padding:10px;border-radius:10px;border:none;background:#ef4444;color:#fff;font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer">🗑️ Excluir</button>
    </div>
  `;

  ov.appendChild(box);
  document.body.appendChild(ov);
  setTimeout(() => box.querySelector('#_qdel-cancel').focus(), 60);

  box.querySelector('#_qdel-cancel').onclick = () => ov.remove();
  ov.onclick = e => { if(e.target === ov) ov.remove(); };

  box.querySelector('#_qdel-ok').onclick = async () => {
    const btn = box.querySelector('#_qdel-ok');
    btn.disabled = true;
    btn.textContent = 'Excluindo...';
    try {
      await _db.ref('/qualidade_registros/' + id).remove();
      ov.remove();
    } catch(e) {
      btn.disabled = false;
      btn.textContent = '🗑️ Excluir';
      alert('Erro ao excluir: ' + (e.message || e));
    }
  };

  ov.addEventListener('keydown', e => {
    if(e.key === 'Escape') { e.preventDefault(); ov.remove(); }
    if(e.key === 'Enter')  { e.preventDefault(); box.querySelector('#_qdel-ok').click(); }
  });
};

// ════════════════════════════════════════════════════════════════════
// QUALIDADE — LÓGICA DE IMPRESSÃO DE ETIQUETAS
// ════════════════════════════════════════════════════════════════════

function qualParseBipados(text){
  const arr = (text||'').toUpperCase().match(/[A-Z0-9]{4}/g) || [];
  const seen = new Set(), out = [];
  for(const c of arr){ if(!seen.has(c)){ seen.add(c); out.push(c); } }
  return out;
}

function qualQrURL(t, size=700){
  return "https://quickchart.io/qr?size="+size+"&text="+encodeURIComponent(t||"");
}

function qualFitIn(node, maxPx, minPx){
  let size = maxPx;
  node.style.fontSize = size+"px";
  node.style.letterSpacing = "0px";
  node.style.whiteSpace = "nowrap";
  node.style.wordBreak = "keep-all";
  node.style.textAlign = "center";
  const parent = node.parentElement;
  if(!parent) return;
  const fits = ()=> node.scrollWidth <= parent.clientWidth-2 && node.scrollHeight <= parent.clientHeight-2;
  while(size>minPx && !fits()){ size-=0.5; node.style.fontSize=size+"px"; }
  if(!fits()){ node.style.whiteSpace="normal"; node.style.wordBreak="break-word";
    while(size>minPx && !fits()){ size-=0.5; node.style.fontSize=size+"px"; } }
  let track=0;
  while(!fits() && track>-1.0){ track-=0.05; node.style.letterSpacing=track+"px"; }
}

function qualEl(tag, cls){ const n=document.createElement(tag); if(cls) n.className=cls; return n; }
function qualUpper(v){ return String(v||'').toUpperCase().trim(); }

function qualMakeLabel({selb, serie, sku, modelo, unit, auditado}){
  selb=qualUpper(selb); serie=qualUpper(serie); sku=qualUpper(sku); modelo=qualUpper(modelo); unit=qualUpper(unit);

  const wrap = qualEl('div','ped-label-wrap');
  const root = qualEl('div','ped-etiqueta');

  if(auditado){
    const bar = qualEl('div','ped-auditado-bar');
    bar.textContent = 'AUDITADO';
    root.appendChild(bar);
    root.style.paddingTop = '0.75cm';
  }

  // ── Row 1 — Modelo (esq) | SELB grande + código cinza + QR (dir) ──
  // Padrão visual: [MODELO]  [SELB  VO93  ▣]
  const row1 = qualEl('div','ped-etiq-row');

  // Célula esquerda: nome do modelo
  const bMod = qualEl('div','ped-etiq-elem');
  bMod.style.flex = '1';
  const mTxt = qualEl('h1','ped-etiq-modelo'); mTxt.textContent=modelo||'MODELO'; bMod.append(mTxt);

  // Célula direita: "SELB" (título grande preto) + código (cinza menor) + QR
  const bSelb = qualEl('div','ped-etiq-elem');
  bSelb.style.flex = '1.4';
  bSelb.style.overflow = 'visible';
  const bSelbInner = qualEl('div');
  bSelbInner.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:0.3cm;width:100%';
  const sTit = qualEl('h1','ped-etiq-valor'); sTit.textContent='SELB';           // "SELB" grande preto
  sTit.style.cssText='font-size:2.3rem;font-weight:900;color:#000;white-space:nowrap;margin:0;line-height:1;flex-shrink:0';
  const sVal = qualEl('p','ped-etiq-titulo'); sVal.textContent=selb||'????';      // código cinza menor
  sVal.style.cssText='font-size:1.6rem;font-weight:900;color:#888;white-space:nowrap;margin:0;line-height:1;flex-shrink:0';
  const sQR  = qualEl('img','ped-etiq-qr');  sQR.alt='QR SELB'; sQR.src=qualQrURL(selb);
  bSelbInner.append(sTit, sVal, sQR);
  bSelb.append(bSelbInner);

  row1.append(bMod, bSelb);

  // ── Row 2 — QR Série | Valor | "SÉRIE" ──
  const row2 = qualEl('div','ped-etiq-row ped-etiq-row2');
  const serQRW = qualEl('div','ped-etiq-elem'); const serQR = qualEl('img','ped-etiq-qr'); serQR.alt='QR SÉRIE'; serQR.src=qualQrURL(serie); serQRW.append(serQR);
  const serVW  = qualEl('div','ped-etiq-elem'); const serV  = qualEl('h1','ped-etiq-valor'); serV.textContent=serie||'—'; serVW.append(serV);
  const serTW  = qualEl('div','ped-etiq-elem'); const serT  = qualEl('h1','ped-etiq-titulo'); serT.textContent='SÉRIE'; serTW.append(serT);
  row2.append(serQRW, serVW, serTW);

  // ── Row 3 — "SKU" (título cinza) | Valor | QR ──
  const row3 = qualEl('div','ped-etiq-row');
  const skuTW = qualEl('div','ped-etiq-elem1'); const skuT = qualEl('p','ped-etiq-titulo'); skuT.textContent='SKU'; skuTW.append(skuT);
  const skuVW = qualEl('div','ped-etiq-elem1'); const skuV = qualEl('h1','ped-etiq-valor');  skuV.textContent=sku||'—'; skuVW.append(skuV);
  const skuQW = qualEl('div','ped-etiq-elem1'); const skuQ = qualEl('img','ped-etiq-qr'); skuQ.alt='QR SKU'; skuQ.src=qualQrURL(sku); skuQW.append(skuQ);
  row3.append(skuTW, skuVW, skuQW);

  root.append(row1, row2, row3);

  setTimeout(()=>{
    qualFitIn(mTxt, 40, 22);
    qualFitIn(serV, 50, 22);
    qualFitIn(skuV, 50, 22);
  }, 50);

  // ── Unit pill — sempre no-print ──
  const pill = qualEl('div','ped-unit-pill no-print');
  const uTitle = qualEl('div','ped-unit-title'); uTitle.textContent='UNITILIZADOR'; pill.appendChild(uTitle);
  if(unit){
    const uQR = qualEl('img','ped-unit-qr'); uQR.alt='QR UNIT'; uQR.src=qualQrURL(unit,500); pill.appendChild(uQR);
  } else {
    const miss = qualEl('div'); miss.textContent='— sem unit —'; miss.style.cssText='font-size:11px;opacity:.8'; pill.appendChild(miss);
  }
  wrap.append(root, pill);
  return wrap;
}

function qualOnPrintTextAreaInput(){
  const ta = document.getElementById('qual-print-textarea');
  if(!ta) return;
  const bip = qualParseBipados(ta.value);

  let foundCount = 0;
  let missingCount = 0;
  for(const selb of bip){
    if(getEquipName(selb)) foundCount++;
    else missingCount++;
  }

  const elTotal = document.getElementById('qual-print-badge-total');
  const elFound = document.getElementById('qual-print-badge-found');
  const elMissWrap = document.getElementById('qual-print-badge-missing');
  const elMissCount = document.getElementById('qual-print-badge-missing-count');
  if(elTotal) elTotal.textContent = bip.length;
  if(elFound) elFound.textContent = foundCount;
  if(elMissWrap) elMissWrap.style.display = missingCount > 0 ? '' : 'none';
  if(elMissCount) elMissCount.textContent = missingCount;

  // Habilita botão gerar se tiver algo
  const btnGerar = document.getElementById('qual-btn-gerar');
  if(btnGerar) btnGerar.disabled = bip.length === 0;

  qualRenderTotaisModelo();
}

function qualRenderTotaisModelo(){
  const target = document.getElementById('qual-totais-por-modelo');
  if(!target) return;
  const ta = document.getElementById('qual-print-textarea');
  const bip = qualParseBipados(ta ? ta.value : '');
  const counts = new Map();
  for(const code of bip){
    const m = getEquipName(code) || null;
    if(!m) continue;
    counts.set(m, (counts.get(m)||0)+1);
  }
  target.innerHTML = '';
  const entries = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  if(!entries.length){
    target.innerHTML='<p style="color:var(--muted);font-size:12px">Cole os SELBs acima para ver os totais por modelo.</p>';
    return;
  }

  // Tabela estilizada inline
  const tbl = document.createElement('table');
  tbl.style.cssText='width:100%;border-collapse:collapse;font-size:12px';
  const thead = document.createElement('thead');
  const thr = document.createElement('tr');
  [['MODELO','left'],['QUANTIDADE','right'],['CHECKLIST','center']].forEach(([txt,align])=>{
    const th=document.createElement('th');
    th.textContent=txt;
    th.style.cssText=`text-align:${align};padding:4px 8px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid var(--border2);font-weight:600`;
    thr.append(th);
  });
  thead.append(thr); tbl.append(thead);

  // __qualChecklistAcumulado: saldo acumulado por modelo (persiste entre bipes e recargas)
  window.__qualChecklist = window.__qualChecklist || {};
  window.__qualChecklistAcumulado = window.__qualChecklistAcumulado || {};
  // Restaura do Firebase se memória estiver zerada (ex: após recarregar a página)
  if (Object.keys(window.__qualChecklistAcumulado).length === 0) {
    const _todayChk = new Date().toISOString().slice(0,10);
    _db.ref('/qual_checklist_dia/' + _todayChk + '/acumulado').once('value').then(snap => {
      const saved = snap.val();
      if (saved && typeof saved === 'object') {
        window.__qualChecklistAcumulado = saved;
        window.__qualChecklist = Object.fromEntries(Object.entries(saved).map(([k,v])=>[k,String(v)]));
        if (typeof _atualizarSomasChecklist === 'function') _atualizarSomasChecklist();
      }
    }).catch(()=>{});
  }

  // Recalcula a soma total do saldo acumulado
  function _recalcSomaAcumulada(){
    let soma = 0;
    Object.values(window.__qualChecklistAcumulado).forEach(v => {
      soma += parseInt(v||'0',10)||0;
    });
    return soma;
  }

  // Atualiza chips e card azul com o saldo acumulado
  function _atualizarSomasChecklist(){
    const soma = _recalcSomaAcumulada();
    const cChk = document.getElementById('qual-chip-checklist-total');
    if(cChk) cChk.innerHTML=`Total checklist: <strong style="color:var(--accent2)">${soma}</strong>`;
    qualSyncChecklistCardFromTotais();
  }

  // Modal de confirmação inline (reutilizável)
  function _confirmarSomaChecklist(modelo, novoValor, inp, btnConf, saldoEl){
    const saldoAtual = parseInt(window.__qualChecklistAcumulado[modelo]||'0',10)||0;
    const adicionar  = parseInt(novoValor||'0',10)||0;
    if(!adicionar){ return; }
    const novoTotal  = saldoAtual + adicionar;

    // Cria overlay de confirmação
    const overlay = document.createElement('div');
    overlay.style.cssText='position:fixed;inset:0;z-index:9999;background:rgba(10,12,20,.82);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center';

    const box = document.createElement('div');
    box.style.cssText='background:var(--bg2);border:1px solid var(--border2);border-radius:18px;padding:26px 28px;min-width:300px;max-width:380px;width:90%;display:flex;flex-direction:column;gap:16px;box-shadow:0 16px 48px rgba(0,0,0,.5)';

    box.innerHTML = `
      <div style="font-size:15px;font-weight:700;color:var(--text)">Confirmar adição ao Checklist</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">
        Modelo: <strong style="color:var(--text)">${modelo}</strong>
      </div>
      <div style="background:var(--bg3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span style="color:var(--muted)">Saldo atual</span>
          <span style="font-family:var(--mono);font-weight:700;color:var(--text)">${saldoAtual}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span style="color:var(--muted)">Adicionar</span>
          <span style="font-family:var(--mono);font-weight:700;color:var(--accent)">+ ${adicionar}</span>
        </div>
        <div style="border-top:1px solid var(--border2);margin-top:4px;padding-top:8px;display:flex;justify-content:space-between;font-size:15px">
          <span style="font-weight:700;color:var(--text)">Novo total</span>
          <span style="font-family:var(--mono);font-weight:800;color:var(--accent2);font-size:18px">${novoTotal}</span>
        </div>
      </div>
      <div style="display:flex;gap:10px">
        <button id="_chk-btn-cancel" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2);background:var(--bg3);color:var(--muted);font-family:var(--font);font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
        <button id="_chk-btn-ok" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--accent2);color:#000;font-family:var(--font);font-size:13px;font-weight:700;cursor:pointer">✓ Confirmar</button>
      </div>
    `;

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Foca no botão confirmar
    setTimeout(() => box.querySelector('#_chk-btn-ok').focus(), 60);

    // Cancelar
    box.querySelector('#_chk-btn-cancel').onclick = () => {
      overlay.remove();
      inp.focus();
    };

    // Confirmar: acumula o valor
    box.querySelector('#_chk-btn-ok').onclick = () => {
      window.__qualChecklistAcumulado[modelo] = novoTotal;
      window.__qualChecklist[modelo] = String(novoTotal);
      // Persiste no Firebase por dia
      const _todayChk = new Date().toISOString().slice(0,10);
      _db.ref('/qual_checklist_dia/' + _todayChk + '/acumulado').set(window.__qualChecklistAcumulado).catch(()=>{});
      overlay.remove();
      // Limpa o input e volta ao estado neutro (pronto para próxima entrada)
      inp.value = '';
      inp.style.borderColor = 'var(--border2)';
      btnConf.style.borderColor = 'var(--border2)';
      btnConf.style.background = 'var(--bg3)';
      btnConf.style.color = 'var(--muted)';
      // Atualiza o badge de saldo ao lado da quantidade
      if(saldoEl) saldoEl.textContent = novoTotal > 0 ? '(' + novoTotal + ')' : '';
      _atualizarSomasChecklist();
    };

    // Fechar ao clicar fora
    overlay.onclick = e => { if(e.target === overlay){ overlay.remove(); inp.focus(); } };

    // Enter confirma, Escape cancela
    overlay.addEventListener('keydown', e => {
      if(e.key === 'Enter')  { e.preventDefault(); box.querySelector('#_chk-btn-ok').click(); }
      if(e.key === 'Escape') { e.preventDefault(); overlay.remove(); inp.focus(); }
    });
  }

  const tbody = document.createElement('tbody');
  let totMaq=0;
  for(const [modelo,q] of entries){
    totMaq+=q;
    const saldoAtualModelo = parseInt(window.__qualChecklistAcumulado[modelo]||'0',10)||0;
    const tr=document.createElement('tr');
    tr.style.borderBottom='1px solid var(--border2)';
    const tdM=document.createElement('td'); tdM.textContent=modelo; tdM.title=modelo;
    tdM.style.cssText='padding:7px 8px;font-size:11px;color:var(--text);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    // Coluna QUANTIDADE com badge de saldo acumulado
    const tdQ=document.createElement('td');
    tdQ.style.cssText='padding:7px 8px;text-align:right;font-weight:700;color:var(--accent);font-size:13px';
    const saldoBadge = document.createElement('span');
    saldoBadge.style.cssText='font-size:10px;color:var(--accent2);font-weight:600;margin-left:5px';
    saldoBadge.textContent = saldoAtualModelo > 0 ? '('+saldoAtualModelo+')' : '';
    tdQ.append(document.createTextNode(String(q)), saldoBadge);

    const tdC=document.createElement('td');
    tdC.style.cssText='padding:5px 8px;text-align:center';

    // Wrapper: input + botão de confirmação
    const wrapC = document.createElement('div');
    wrapC.style.cssText='display:inline-flex;align-items:center;gap:5px';

    const inp=document.createElement('input');
    inp.type='text'; inp.inputMode='numeric'; inp.maxLength=2;
    inp.value = '';  // sempre começa vazio — o saldo é exibido no badge
    inp.placeholder = saldoAtualModelo > 0 ? '+' : '0';
    inp.dataset.modelo = modelo;
    inp.style.cssText='width:42px;height:28px;text-align:center;font-size:13px;font-weight:700;color:var(--text);background:var(--bg);border:2px solid var(--border2);border-radius:6px;outline:none;transition:border-color .2s';

    // Botão confirmar
    const btnConf = document.createElement('button');
    btnConf.textContent = '✓';
    btnConf.title = 'Confirmar e acumular';
    btnConf.style.cssText='width:28px;height:28px;border-radius:6px;border:1px solid var(--border2);background:var(--bg3);color:var(--muted);font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;line-height:1;padding:0';

    // Ao digitar: destaca o botão
    inp.addEventListener('input',()=>{
      inp.value = inp.value.replace(/\D/g,'').slice(0,2);
      const temValor = inp.value.trim() !== '';
      inp.style.borderColor = temValor ? 'var(--accent)' : 'var(--border2)';
      btnConf.style.borderColor = temValor ? 'var(--accent)' : 'var(--border2)';
      btnConf.style.background = temValor ? 'rgba(79,142,247,.15)' : 'var(--bg3)';
      btnConf.style.color = temValor ? 'var(--accent)' : 'var(--muted)';
    });

    // Ao pressionar Enter no input: abre confirmação
    inp.addEventListener('keydown', e => {
      if(e.key === 'Enter'){ e.preventDefault(); btnConf.click(); }
    });

    // Botão confirmar: abre modal de confirmação
    btnConf.addEventListener('click', () => {
      const val = inp.value.trim();
      if(!val){ inp.focus(); return; }
      _confirmarSomaChecklist(modelo, val, inp, btnConf, saldoBadge);
    });

    wrapC.append(inp, btnConf);
    tdC.append(wrapC);
    tr.append(tdM,tdQ,tdC); tbody.append(tr);
  }

  tbl.append(tbody); target.append(tbl);

  // Soma inicial: usa saldo acumulado
  let somaChecklist = 0;
  for(const [modelo] of entries){
    somaChecklist += parseInt((window.__qualChecklistAcumulado||{})[modelo]||'0',10)||0;
  }

  // Chips de totais
  const chipsWrap=document.createElement('div');
  chipsWrap.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
  const cMaq=document.createElement('div');
  cMaq.style.cssText='background:var(--bg);border:1px solid var(--border2);border-radius:20px;font-size:11px;padding:3px 10px;color:var(--text)';
  cMaq.innerHTML=`Total máquinas: <strong>${totMaq}</strong>`;
  const cChk=document.createElement('div');
  cChk.id='qual-chip-checklist-total';
  cChk.style.cssText='background:var(--bg);border:1px solid var(--border2);border-radius:20px;font-size:11px;padding:3px 10px;color:var(--text)';
  cChk.innerHTML=`Total checklist: <strong style="color:var(--accent2)">${somaChecklist}</strong>`;
  chipsWrap.append(cMaq,cChk); target.append(chipsWrap);

  // Sincroniza o card azul CHECKLIST com a soma inserida na tabela
  // (usa setTimeout para garantir que os inputs já foram inseridos no DOM)
  setTimeout(() => qualSyncChecklistCardFromTotais(), 0);
}

function qualGenerateLabels(){
  const ta = document.getElementById('qual-print-textarea');
  const gallery = document.getElementById('qual-print-gallery');
  const feedback = document.getElementById('qual-print-feedback');
  const btnPrint = document.getElementById('qual-btn-print');
  if(!ta || !gallery || !feedback || !btnPrint) return;

  const bip = qualParseBipados(ta.value);
  const isAuditado = (document.getElementById('qual-chkAuditado') || {}).checked !== false;
  gallery.innerHTML = '';
  feedback.innerHTML = '';

  if(!bip.length){
    feedback.innerHTML = `<div class="ped-chip warn"><span style="color:var(--danger)">⚠️ Nenhum SELB detectado. Digite ou cole códigos válidos.</span></div>`;
    btnPrint.disabled = true;
    return;
  }

  const labels = [];
  const missing = [];

  for(const selb of bip){
    const modelo = getEquipName(selb);
    const serie = getEquipSerie(selb);
    const sku = getEquipSku(selb);
    if(modelo){
      labels.push({
        selb,
        modelo,
        serie: serie || '—',
        sku: sku || '—',
        unit: (typeof getEquipUnitizador === 'function' ? getEquipUnitizador(selb) : '') || '',
        auditado: isAuditado
      });
    } else {
      missing.push(selb);
    }
  }

  // Gera elementos do DOM
  labels.forEach(data => {
    gallery.appendChild(qualMakeLabel(data));
  });

  // Atualiza feedback textual
  let fbHTML = `<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:10px">
    <div class="ped-chip ok">Etiquetas geradas: <strong>${labels.length}</strong></div>`;
  
  if(missing.length){
    fbHTML += `<div class="ped-chip warn">Não localizados no banco: <strong>${missing.length}</strong></div>`;
  }
  fbHTML += `</div>`;

  if(missing.length){
    fbHTML += `<div class="ped-card" style="margin-top:12px;border:1px solid rgba(245,166,35,.3);border-radius:10px;background:var(--bg3);padding:12px">
      <h4 style="margin:0 0 6px;color:var(--warn);font-size:12px">SELBs não cadastrados (sem nome no sistema):</h4>
      <div style="font-family:var(--mono);font-size:11px;color:var(--muted)">${missing.join(', ')}</div>
    </div>`;
  }

  feedback.innerHTML = fbHTML;
  btnPrint.disabled = labels.length === 0;
  if(btnPrint){
    btnPrint.style.color = labels.length > 0 ? 'var(--text)' : 'var(--muted)';
    btnPrint.style.borderColor = labels.length > 0 ? 'var(--border2)' : 'var(--border2)';
  }

  if(labels.length > 0){
    gallery.scrollIntoView({behavior:'smooth',block:'start'});
  }
}

// ── Checklist: card azul reflete APENAS a soma dos campos inseridos em Totais por Modelo ──
// O card NAO e mais incrementado automaticamente ao imprimir etiquetas.
// Somente quando o usuario digita um valor no campo CHECKLIST da tabela "Totais por Modelo"
// o card azul e atualizado.
let _qualChecklistCount = 0;

// Calcula e sincroniza o card azul CHECKLIST com o saldo ACUMULADO confirmado
function qualSyncChecklistCardFromTotais(){
  let soma = 0;
  if(window.__qualChecklistAcumulado){
    Object.values(window.__qualChecklistAcumulado).forEach(v => {
      soma += parseInt(v||'0',10)||0;
    });
  }
  _qualChecklistCount = soma;
  const el = document.getElementById('qual-stats-checklist');
  if(el) el.textContent = soma;
}

function qualLoadChecklistCount(){
  // Sincroniza o card com o saldo acumulado confirmado da sessao.
  let soma = 0;
  if(window.__qualChecklistAcumulado){
    Object.values(window.__qualChecklistAcumulado).forEach(v => {
      soma += parseInt(v||'0',10)||0;
    });
  }
  _qualChecklistCount = soma;
  const el = document.getElementById('qual-stats-checklist');
  if(el) el.textContent = soma;

  // Se o cache ainda está vazio (ex: página recarregada sem abrir o painel de checklist),
  // busca direto do Firebase e atualiza o card quando retornar.
  if(!window.__qualChecklistAcumulado || Object.keys(window.__qualChecklistAcumulado).length === 0){
    const _today = new Date().toISOString().slice(0,10);
    _db.ref('/qual_checklist_dia/' + _today + '/acumulado').once('value').then(snap => {
      const saved = snap.val();
      if(saved && typeof saved === 'object' && Object.keys(saved).length > 0){
        window.__qualChecklistAcumulado = saved;
        window.__qualChecklist = Object.fromEntries(
          Object.entries(saved).map(([k,v]) => [k, String(v)])
        );
        qualSyncChecklistCardFromTotais();
      }
    }).catch(()=>{});
  }
}

function qualIncrementChecklist(qty){
  // Mantida para compatibilidade — NAO atualiza o card azul.
  // O card so e atualizado via qualSyncChecklistCardFromTotais() (campos da tabela).
  if(!qty || qty <= 0) return;
  const today = new Date().toISOString().slice(0,10);
  _db.ref('/qual_checklist_dia/' + today + '/ultima_impressao').set(Date.now()).catch(() => {});
}

function qualPrintLabels(){
  const btnPrint = document.getElementById('qual-btn-print');
  if(btnPrint && btnPrint.disabled) return;

  const gallery = document.getElementById('qual-print-gallery');
  const qtyPrinted = gallery ? gallery.querySelectorAll('.ped-label-wrap').length : 0;

  document.body.classList.add('printing-qualidade');
  window.print();

  // Registra impressao no Firebase sem incrementar o card azul
  if(qtyPrinted > 0) qualIncrementChecklist(qtyPrinted);
}

window.addEventListener('afterprint', () => {
  document.body.classList.remove('printing-qualidade');
});

// ── Gera e imprime etiqueta de um único SELB diretamente da linha da tabela ──
function qualGerarEtiquetaUnica(selb, regId){
  const allowed = currentUser && (currentUser.isAdmin || currentUser.sector === 'DESMEMBRAMENTO');
  if(!allowed){
    alert('Apenas administradores ou o setor Desmembramento podem gerar/imprimir etiquetas.');
    return;
  }
  selb = (selb || '').toUpperCase().trim();
  if(!selb) return;

  const modelo = getEquipName(selb);
  const serie  = getEquipSerie(selb) || '—';
  const sku    = getEquipSku(selb)   || '—';
  const unit   = (typeof getEquipUnitizador === 'function' ? getEquipUnitizador(selb) : '') || '';

  if(!modelo){
    alert('⚠️ SELB "' + selb + '" não encontrado no banco de equipamentos.\nImporte a planilha na aba Equipamentos.');
    return;
  }

  // Remove overlay anterior se existir
  const existente = document.getElementById('modal-etiqueta-unica');
  if(existente) existente.remove();

  // Cria overlay
  const overlay = document.createElement('div');
  overlay.id = 'modal-etiqueta-unica';
  overlay.className = 'qual-print-area';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.75);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:24px;overflow:auto';

  // Gera etiqueta usando o mesmo template do gerador em lote
  const labelWrap = qualMakeLabel({ selb, modelo, serie, sku, unit, auditado: true });
  labelWrap.style.cssText = 'display:block';

  // Move o unitizador para o canto superior direito da página (fora da etiqueta)
  const pillEl = labelWrap.querySelector('.ped-unit-pill');
  if(pillEl){
    pillEl.style.cssText = 'position:fixed;top:24px;right:24px;background:#fff;border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;align-items:center;gap:6px;width:140px;z-index:9100;box-shadow:0 4px 18px rgba(0,0,0,.4)';
    const pillTitle = pillEl.querySelector('.ped-unit-title');
    if(pillTitle) pillTitle.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:.08em;color:#222;text-align:center';
    const pillQR = pillEl.querySelector('.ped-unit-qr');
    if(pillQR) pillQR.style.cssText = 'width:110px;height:110px;display:block';
    // Move o pill para fora do labelWrap, direto no overlay (canto da página)
    overlay.appendChild(pillEl);
  }

  // Botões de ação
  const btns = document.createElement('div');
  btns.className = 'no-print';
  btns.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;justify-content:center';
  const btnImprimir = document.createElement('button');
  btnImprimir.textContent = '🖨️ Imprimir';
  btnImprimir.style.cssText = 'background:var(--accent);border:none;border-radius:10px;color:#fff;font-family:var(--font);font-size:14px;font-weight:700;padding:10px 28px;cursor:pointer';
  btnImprimir.onclick = function(){

    const clone = labelWrap.cloneNode(true);
    const pillClone = clone.querySelector('.ped-unit-pill');
    if(pillClone) pillClone.remove();
    const headStyles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
      .map(n => n.outerHTML).join('\n');
    const labelHTML = clone.outerHTML;
    const w = window.open('', '_blank', 'width=700,height=500');
    if(!w){ alert('Permita pop-ups para imprimir.'); return; }
    w.document.write(`<!doctype html><html><head>
<meta charset="utf-8">
<title>Etiqueta ${selb}</title>
${headStyles}
<style>
  @page { size: 15cm 10cm; margin: 0mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; width: 15cm !important; height: 10cm !important; overflow: hidden !important; }
  .no-print, .ped-unit-pill { display: none !important; }
  .ped-label-wrap { display: block !important; position: relative !important; width: 15cm !important; height: 10cm !important; margin: 0 !important; padding: 0 !important; transform: none !important; overflow: hidden !important; }
  .ped-etiqueta { width: 15cm !important; height: 10cm !important; box-sizing: border-box !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
  @media print {
    html, body { width: 15cm !important; height: 10cm !important; overflow: hidden !important; }
    * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
  }
  @media screen { body { display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #eee !important; width: auto !important; height: auto !important; overflow: auto !important; } .ped-label-wrap { box-shadow: 0 4px 24px rgba(0,0,0,.18); } }
</style>
</head><body>${labelHTML}</body></html>`);
    w.document.close();
    const doPrint = () => {
      try { w.focus(); w.print(); } catch(e){}
      setTimeout(() => { try { w.close(); } catch(e){} }, 1000);
    };
    setTimeout(() => {
      const imgs = Array.from(w.document.images);
      if(imgs.length === 0){ setTimeout(doPrint, 300); return; }
      let pending = imgs.filter(i => !i.complete).length;
      if(pending === 0){ setTimeout(doPrint, 300); return; }
      imgs.forEach(img => {
        if(!img.complete){
          img.onload  = () => { pending--; if(pending <= 0) setTimeout(doPrint, 300); };
          img.onerror = () => { pending--; if(pending <= 0) setTimeout(doPrint, 300); };
        }
      });
      setTimeout(doPrint, 3000);
    }, 300);
  };
  const btnFechar = document.createElement('button');
  btnFechar.textContent = '✕ Fechar';
  btnFechar.style.cssText = 'background:var(--bg3);border:1px solid var(--border2);border-radius:10px;color:var(--text);font-family:var(--font);font-size:14px;font-weight:600;padding:10px 22px;cursor:pointer';
  btnFechar.onclick = function(){ overlay.remove(); };
  btns.append(btnImprimir, btnFechar);

  overlay.append(btns, labelWrap);
  document.body.appendChild(overlay);

  // Fecha ao clicar fora da etiqueta
  overlay.addEventListener('click', function(e){
    if(e.target === overlay) overlay.remove();
  });
}

// Expõe globalmente para uso em onclick=""
window.qualGerarEtiquetaUnica = qualGerarEtiquetaUnica;

function qualClearPrintArea(){
  const ta = document.getElementById('qual-print-textarea');
  const gallery = document.getElementById('qual-print-gallery');
  const feedback = document.getElementById('qual-print-feedback');
  const btnPrint = document.getElementById('qual-btn-print');
  const btnGerar = document.getElementById('qual-btn-gerar');
  if(ta) ta.value = '';
  if(gallery) gallery.innerHTML = '';
  if(feedback) feedback.innerHTML = '';
  if(btnPrint) btnPrint.disabled = true;
  if(btnGerar) btnGerar.disabled = true;

  const elTotal = document.getElementById('qual-print-badge-total');
  const elFound = document.getElementById('qual-print-badge-found');
  const elMissWrap = document.getElementById('qual-print-badge-missing');
  if(elTotal) elTotal.textContent = '0';
  if(elFound) elFound.textContent = '0';
  if(elMissWrap) elMissWrap.style.display = 'none';

  const totais = document.getElementById('qual-totais-por-modelo');
  if(totais) totais.innerHTML = '<p style="color:var(--text3);font-size:12px">Cole os SELBs acima para ver os totais por modelo.</p>';
}

// ════════════════════════════════════════════════════════════════════════
// 📷 SISTEMA DO LEITOR OCR (SCANNER DE CONTADOR E SÉRIE)
// ════════════════════════════════════════════════════════════════════════
let scannerStream = null;
let scannerBarcodeInterval = null;
let scannerOcrInterval = null;
let ocrRunning = false;
let barcodeLoopRunning = false;
let ocrLoopRunning = false;

// Inicializa a aba de scanner
async function scannerInit(){
  scannerResetAll();
  
  // Registra escutador de erros global para exibir no celular se algo falhar no JavaScript
  window.addEventListener('error', function(e) {
    const errEl = document.getElementById('scanner-err-msg');
    if(errEl) {
      errEl.textContent = `❌ Erro JS: ${e.message || 'Erro desconhecido'} (${(e.filename || '').split('/').pop()}:${e.lineno})`;
      errEl.style.display = 'block';
      errEl.style.background = 'rgba(239, 68, 68, 0.1)';
      errEl.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      errEl.style.color = '#ef4444';
    }
  });
  
  // Prepara select de câmeras
  const select = document.getElementById('scanner-camera-select');
  if(select) {
    select.innerHTML = '<option value="">Buscando câmera...</option>';
  }

  // Popula o datalist de SELBs com todos os SELBs cadastrados no banco
  const dl = document.getElementById('scanner-selb-list');
  if(dl){
    dl.innerHTML = '';
    const keys = Object.keys(equipamentos || {}).sort();
    keys.forEach(k => {
      const option = document.createElement('option');
      option.value = k;
      option.textContent = equipamentos[k] || '';
      dl.appendChild(option);
    });
  }
  
  // Inicia a câmera automaticamente ao abrir a aba
  await scannerStartCamera();
}

// Inicia/Para câmera
function scannerToggleCamera(){
  if(scannerStream) {
    scannerStopCamera();
  } else {
    scannerStartCamera();
  }
}

// Para a câmera e limpa o intervalo de escaneamento automático
function scannerStopCamera(){
  if(scannerBarcodeInterval){
    clearInterval(scannerBarcodeInterval);
    scannerBarcodeInterval = null;
  }
  if(scannerOcrInterval){
    clearInterval(scannerOcrInterval);
    scannerOcrInterval = null;
  }
  ocrRunning = false;
  barcodeLoopRunning = false;
  ocrLoopRunning = false;

  if(scannerStream){
    scannerStream.getTracks().forEach(track => track.stop());
    scannerStream = null;
  }
  const video = document.getElementById('scanner-video');
  if(video) video.srcObject = null;
  
  const ph = document.getElementById('scanner-video-placeholder');
  if(ph) ph.style.display = 'flex';
  
  const overlay = document.getElementById('scanner-target-overlay');
  if(overlay) overlay.style.display = 'none';

  const btnToggle = document.getElementById('btn-scanner-toggle');
  if(btnToggle) {
    btnToggle.textContent = '📷 Iniciar Câmera';
    btnToggle.className = 'btn bg';
  }

  const btnCapture = document.getElementById('btn-scanner-capture');
  if(btnCapture) btnCapture.disabled = true;
}

// Inicia a câmera e depois popula o dropdown de câmeras e inicia o loop automático
async function scannerStartCamera(){
  scannerStopCamera();
  
  const video = document.getElementById('scanner-video');
  const select = document.getElementById('scanner-camera-select');
  const ph = document.getElementById('scanner-video-placeholder');
  const overlay = document.getElementById('scanner-target-overlay');
  if(!video) return;

  const deviceId = select ? select.value : '';
  const constraints = {
    video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
  };

  try {
    scannerStream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = scannerStream;
    
    if(ph) ph.style.display = 'none';
    if(overlay) overlay.style.display = 'block';

    const btnToggle = document.getElementById('btn-scanner-toggle');
    if(btnToggle) {
      btnToggle.textContent = '🛑 Parar Câmera';
      btnToggle.className = 'btn bd'; // Botão vermelho de parada
    }

    const btnCapture = document.getElementById('btn-scanner-capture');
    if(btnCapture) btnCapture.disabled = false;

    // Popula o dropdown de câmeras se necessário (ex: na primeira execução)
    if(select && (select.innerHTML.includes('Buscando') || select.innerHTML === '')) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === 'videoinput');
      
      select.innerHTML = '';
      if(videoDevices.length === 0) {
        select.innerHTML = '<option value="">Nenhuma câmera detectada</option>';
      } else {
        videoDevices.forEach((device, index) => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `Câmera ${index + 1}`;
          
          // Marca como selecionada a câmera atualmente ativa no stream
          const currentTrack = scannerStream.getVideoTracks()[0];
          const settings = currentTrack ? currentTrack.getSettings() : null;
          if(settings && settings.deviceId === device.deviceId) {
            option.selected = true;
          }
          select.appendChild(option);
        });
      }
    }

    // Inicia loops de escaneamento automático em tempo real
    scannerBarcodeInterval = setInterval(scannerBarcodeLoop, 150); // Leitura ultra-rápida de código de barras
    scannerOcrInterval = setInterval(scannerOcrLoop, 2500);       // Leitura de texto (OCR) secundária
  } catch(e) {
    console.error("Erro ao iniciar câmera:", e);
    // Se falhou por constraints estritas com deviceId, tenta fallback genérico
    if(deviceId) {
      if(select) select.value = '';
      await scannerStartCamera();
    } else {
      if(select) select.innerHTML = '<option value="">Sem acesso à câmera</option>';
      alert('Não foi possível acessar a câmera. Certifique-se de que deu permissões de câmera no navegador.');
    }
  }
}

// Inicialização do leitor de códigos de barra ZXing para navegador
let zxingReader = null;
try {
  if (typeof ZXing !== 'undefined') {
    // Restringe busca a formatos específicos de código de barras para otimizar velocidade
    const hints = new Map();
    const formats = [
      ZXing.BarcodeFormat.CODE_128,
      ZXing.BarcodeFormat.CODE_39,
      ZXing.BarcodeFormat.ITF,
      ZXing.BarcodeFormat.EAN_13
    ];
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, formats);
    // BrowserMultiFormatReader é otimizado para câmeras e canvas no navegador
    zxingReader = new ZXing.BrowserMultiFormatReader(hints);
  }
} catch(e) {
  console.warn("Falha ao instanciar ZXing BrowserMultiFormatReader:", e);
}

// Inicialização do BarcodeDetector nativo do navegador (se disponível)
let nativeBarcodeDetector = null;
if ('BarcodeDetector' in window) {
  try {
    nativeBarcodeDetector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'itf', 'ean_13'] });
  } catch(e) {
    console.warn("BarcodeDetector nativo indisponível ou formatos não suportados:", e);
  }
}

// Valida se o texto lido/escaneado corresponde a um SELB cadastrado no banco (ignorando diferenças de formato/prefixo)
function extractAndValidateSelb(str) {
  if (!str) return null;
  
  // Limpa caracteres mantendo letras, números, espaços e hífens
  const cleanStr = str.toUpperCase().replace(/[^A-Z0-9\s-]/g, ' ').trim();
  
  // 1. Tenta correspondência direta ou por código normalizado
  const normScanned = normalizeSelbCode(cleanStr);
  if (!normScanned) return null;

  const dbKeys = Object.keys(equipamentos || {});
  
  // Primeiro tenta match exato da chave normalizada
  for (const k of dbKeys) {
    if (normalizeSelbCode(k) === normScanned) {
      return k; // Retorna a chave original exata conforme cadastrada no banco (ex: "SELB - 7SM2")
    }
  }

  // 2. Tenta correspondência quebrando a string em palavras
  const words = cleanStr.split(/\s+/);
  for (const word of words) {
    if (word.length >= 4) {
      const normWord = normalizeSelbCode(word);
      for (const k of dbKeys) {
        if (normalizeSelbCode(k) === normWord) {
          return k; // Retorna a chave original cadastrada
        }
      }
    }
  }

  // 3. Verifica se alguma chave normalizada está contida na string escaneada
  for (const k of dbKeys) {
    const normKey = normalizeSelbCode(k);
    if (normKey && normKey.length >= 4 && normScanned.includes(normKey)) {
      return k;
    }
  }

  return null;
}

// Loop Rápido (150ms): Focado exclusivamente em código de barras (processamento ultrarrápido)
async function scannerBarcodeLoop() {
  if (barcodeLoopRunning || !scannerStream) return;
  barcodeLoopRunning = true;
  
  try {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');
    
    // Mantém a proporção da imagem limitando a dimensão máxima em 640px
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    const maxDim = 640;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let detectedSelb = null;

    // 1. Tenta decodificador nativo (hardware acelerado)
    if (nativeBarcodeDetector) {
      try {
        const barcodes = await nativeBarcodeDetector.detect(video);
        if (barcodes && barcodes.length > 0) {
          for (const barcode of barcodes) {
            const validated = extractAndValidateSelb(barcode.rawValue);
            if (validated) {
              detectedSelb = validated;
              break;
            }
          }
        }
      } catch(e) {
        // Ignora erro silenciado do detector nativo
      }
    }

    // 2. Tenta ZXing MultiFormat Reader (altamente preciso)
    if (!detectedSelb && zxingReader) {
      try {
        const result = await zxingReader.decodeFromCanvas(canvas);
        if (result && result.text) {
          const validated = extractAndValidateSelb(result.text);
          if (validated) {
            detectedSelb = validated;
          }
        }
      } catch(e) {
        // O ZXing gera erro quando não há código de barras na imagem do canvas, o que é esperado
      }
    }

    // Se detectou, para a câmera e preenche imediatamente!
    if (detectedSelb) {
      scannerTriggerSuccess(detectedSelb);
    }
  } finally {
    barcodeLoopRunning = false;
  }
}

// Loop Lento (2500ms): Focado no texto escrito (OCR - pesado)
async function scannerOcrLoop() {
  if (ocrLoopRunning || ocrRunning || !scannerStream) return;
  ocrLoopRunning = true;
  ocrRunning = true;
  
  try {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    if (!video || !canvas) {
      ocrLoopRunning = false;
      ocrRunning = false;
      return;
    }

    const ctx = canvas.getContext('2d');
    
    // Mantém a proporção da imagem limitando a dimensão máxima em 640px
    let w = video.videoWidth || 640;
    let h = video.videoHeight || 480;
    const maxDim = 640;
    if (w > maxDim || h > maxDim) {
      if (w > h) {
        h = Math.round((h * maxDim) / w);
        w = maxDim;
      } else {
        w = Math.round((w * maxDim) / h);
        h = maxDim;
      }
    }
    
    canvas.width = w;
    canvas.height = h;
    
    // Filtros de imagem para o OCR
    try {
      ctx.filter = 'grayscale(100%) contrast(160%)';
    } catch(e) {}
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataURL = canvas.toDataURL('image/jpeg', 0.7);
    
    // Utiliza 'eng' para evitar downloads lentos de pacotes de tradução em redes móveis
    Tesseract.recognize(
      dataURL,
      'eng',
      { 
        logger: () => {},
        tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '
      }
    ).then(({ data: { text } }) => {
      ocrLoopRunning = false;
      ocrRunning = false;
      const validated = extractAndValidateSelb(text);
      if (validated) {
        scannerTriggerSuccess(validated);
      }
    }).catch(err => {
      ocrLoopRunning = false;
      ocrRunning = false;
      console.warn("Erro no loop secundário do OCR:", err);
    });
  } catch(e) {
    ocrLoopRunning = false;
    ocrRunning = false;
    console.warn("Erro na preparação do OCR loop:", e);
  }
}

// Executa ações de sucesso quando o SELB é reconhecido
function scannerTriggerSuccess(detectedSelb) {
  const selbField = document.getElementById('scanner-field-selb');
  if(selbField) selbField.value = detectedSelb;
  
  // Auto-preenche informações do equipamento
  scannerOnSelbInput();
  
  // Feedback sonoro (beep)
  playScannerBeep();
  
  // Para a câmera
  scannerStopCamera();
  
  const errEl = document.getElementById('scanner-err-msg');
  if(errEl) {
    errEl.textContent = `✅ SELB "${detectedSelb}" detectado com sucesso! Insira o contador manualmente abaixo.`;
    errEl.style.display = 'block';
    errEl.style.background = 'rgba(74, 222, 128, 0.1)';
    errEl.style.borderColor = 'rgba(74, 222, 128, 0.3)';
    errEl.style.color = '#4ade80';
  }

  const contadorField = document.getElementById('scanner-field-contador-pb');
  if(contadorField) {
    contadorField.value = '';
    const colorField = document.getElementById('scanner-field-contador-color');
    if(colorField) colorField.value = '';
    setTimeout(() => {
      contadorField.focus();
      // Rola a página suavemente até o campo do contador
      contadorField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
  }
}

// Captura foto do stream
// Captura foto do stream
async function scannerCapturePhoto(){
  const video = document.getElementById('scanner-video');
  const canvas = document.getElementById('scanner-canvas');
  if(!video || !canvas || !scannerStream) return;

  const ctx = canvas.getContext('2d');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  
  // Desenha o frame atual da câmera no canvas
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  
  // Para a câmera
  scannerStopCamera();
  
  // Tenta decodificar código de barras da foto capturada antes de iniciar o pesado OCR
  let detectedSelb = null;
  if (zxingReader) {
    try {
      if (typeof zxingReader.decodeFromCanvas === 'function') {
        const result = await zxingReader.decodeFromCanvas(canvas);
        if (result && result.text) {
          detectedSelb = extractAndValidateSelb(result.text);
        }
      }
    } catch(e) {}

    if (!detectedSelb) {
      try {
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const luminanceSource = new ZXing.RGBLuminanceSource(canvas.width, canvas.height, imgData.data);
        const hybridBinarizer = new ZXing.HybridBinarizer(luminanceSource);
        const binaryBitmap = new ZXing.BinaryBitmap(hybridBinarizer);
        
        let result = null;
        if (typeof zxingReader.decode === 'function') {
          result = zxingReader.decode(binaryBitmap);
        } else {
          const reader = new ZXing.MultiFormatReader();
          result = reader.decode(binaryBitmap);
        }
        if (result && result.text) {
          detectedSelb = extractAndValidateSelb(result.text);
        }
      } catch(e) {}
    }
  }

  if (detectedSelb) {
    scannerTriggerSuccess(detectedSelb);
    return;
  }
  
  // Fallback: Roda o OCR na imagem capturada
  const dataURL = canvas.toDataURL('image/jpeg');
  scannerRunOCR(dataURL);
}

// Trata arquivo de imagem selecionado manualmente
function scannerOnFileSelect(input){
  if(input.files && input.files[0]){
    const reader = new FileReader();
    reader.onload = function(e){
      scannerRunOCR(e.target.result);
    };
    reader.readAsDataURL(input.files[0]);
  }
}

// Roda o motor Tesseract.js OCR
function scannerRunOCR(imageSrc){
  const progressCard = document.getElementById('scanner-progress-card');
  const pStatus = document.getElementById('scanner-progress-status');
  const pBar = document.getElementById('scanner-progress-bar');
  const pPct = document.getElementById('scanner-progress-pct');
  const submitBtn = document.getElementById('btn-scanner-submit');

  if(progressCard) progressCard.style.display = 'flex';
  if(pStatus) pStatus.textContent = 'Inicializando OCR...';
  if(pBar) pBar.style.width = '0%';
  if(pPct) pPct.textContent = '0%';
  if(submitBtn) submitBtn.disabled = true;

  // Se Tesseract não estiver disponível
  if(typeof Tesseract === 'undefined') {
    if(pStatus) pStatus.textContent = '⚠️ Biblioteca OCR indisponível (offline ou bloqueada). Por favor, preencha manualmente.';
    if(pPct) pPct.textContent = 'Erro';
    return;
  }

  // Utilizamos o dicionário de inglês ('eng') por ser nativo da biblioteca Tesseract.js,
  // eliminando downloads de rede pesados e falhas sob conexões móveis (3G/4G/5G).
  Tesseract.recognize(
    imageSrc,
    'eng',
    {
      logger: m => {
        if(m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          if(pStatus) pStatus.textContent = 'Extraindo texto...';
          if(pBar) pBar.style.width = `${pct}%`;
          if(pPct) pPct.textContent = `${pct}%`;
        }
      }
    }
  ).then(({ data: { text } }) => {
    if(progressCard) progressCard.style.display = 'none';
    
    // Mostra texto bruto extraído
    const rawBox = document.getElementById('scanner-raw-text');
    if(rawBox) rawBox.value = text;

    // Processa o texto com Regex para encontrar SELB, Contador e Série
    scannerParseAndFill(text);
  }).catch(err => {
    console.error("Erro no OCR:", err);
    if(pStatus) pStatus.textContent = '❌ Erro ao analisar imagem. Tente novamente.';
    if(pPct) pPct.textContent = 'Falhou';
  });
}

// Analisa e preenche os campos com base no texto do OCR (Foco exclusivo em ler o SELB físico na etiqueta)
function scannerParseAndFill(text){
  const errEl = document.getElementById('scanner-err-msg');
  if(errEl) {
    errEl.style.display = 'none';
    errEl.textContent = '';
  }

  // Tenta identificar o SELB a partir do padrão "SELB - XXXX", "SELB XXXX" ou palavras avulsas de 4 caracteres
  let detectedSelb = '';
  const textUpper = text.toUpperCase();

  // Estratégia A: Procura pelo padrão SELB - XXXX ou SELB XXXX (como nas etiquetas verdes)
  const selbLabelMatch = textUpper.match(/SELB\s*[-–]?\s*([A-Z0-9]{4})\b/);
  if(selbLabelMatch) {
    detectedSelb = selbLabelMatch[1];
  } else {
    // Estratégia B: procura palavras de 4 caracteres contidas no nosso banco de equipamentos
    const words = textUpper.replace(/[^A-Z0-9\s]/g, ' ').split(/\s+/);
    for(const word of words) {
      if(word.length === 4) {
        if(getEquipName(word)) {
          detectedSelb = word;
          break;
        }
      }
    }
  }

  const selbField = document.getElementById('scanner-field-selb');
  const contadorField = document.getElementById('scanner-field-contador-pb');

  if(detectedSelb) {
    if(selbField) {
      selbField.value = detectedSelb;
    }
    
    // Atualiza modelo, serie e sku baseados no SELB
    scannerOnSelbInput();
    
    // Emite som de bip de sucesso (feedback imediato ao operador)
    playScannerBeep();

    // Limpa o contador anterior para garantir inserção nova
    if(contadorField) {
      contadorField.value = '';
      const colorField = document.getElementById('scanner-field-contador-color');
      if(colorField) colorField.value = '';
      setTimeout(() => {
        contadorField.focus();
      }, 100);
    }

    if(errEl) {
      errEl.textContent = `✅ SELB "${detectedSelb}" identificado! Insira o contador manualmente abaixo.`;
      errEl.style.display = 'block';
      errEl.style.background = 'rgba(74, 222, 128, 0.1)';
      errEl.style.borderColor = 'rgba(74, 222, 128, 0.3)';
      errEl.style.color = '#4ade80';
    }
  } else {
    if(errEl) {
      errEl.textContent = `⚠️ Não foi possível identificar o SELB na etiqueta física. Por favor, tente novamente ou selecione manualmente na lista.`;
      errEl.style.display = 'block';
      errEl.style.background = 'rgba(245, 158, 11, 0.1)';
      errEl.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      errEl.style.color = '#f59e0b';
    }
  }
}

// Emite som de bip (Web Audio API)
function playScannerBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1000, ctx.currentTime); // 1000Hz (som clássico de bip de leitor)
    
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15); // Fade out suave
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch(e) {
    console.warn("AudioContext bloqueado ou não suportado:", e);
  }
}

// Autofill complementar a partir do banco de dados quando digita ou acha o SELB
function scannerOnSelbInput(){
  const selb = (document.getElementById('scanner-field-selb')?.value || '').toUpperCase().trim();
  const equipEl       = document.getElementById('scanner-field-equip');
  const serieEl       = document.getElementById('scanner-field-serie');
  const skuEl         = document.getElementById('scanner-field-sku');
  const unitizadorEl  = document.getElementById('scanner-field-unitizador');
  const submitBtn     = document.getElementById('btn-scanner-submit');

  if(!equipEl) return;

  if(!selb){
    equipEl.value = ''; equipEl.style.color = 'var(--muted)';
    if(serieEl){ serieEl.value = ''; serieEl.style.color = 'var(--muted)'; }
    if(skuEl){ skuEl.value = ''; skuEl.style.color = 'var(--muted)'; }
    if(unitizadorEl){ unitizadorEl.value = ''; unitizadorEl.style.color = 'var(--muted)'; }
    if(submitBtn) submitBtn.disabled = true;
    return;
  }

  // Busca nome no banco de equipamentos
  const dictNome       = getEquipName(selb);
  const dictSerie      = getEquipSerie(selb);
  const dictSku        = getEquipSku(selb);
  const dictUnitizador = getEquipUnitizador(selb);
  let match = null;

  if(dictNome){
    equipEl.value = dictNome;
    equipEl.style.color = 'var(--text)';
  } else {
    // Fallback: busca no histórico
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    match = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(match && match.equipamento){
      equipEl.value = match.equipamento;
      equipEl.style.color = 'var(--text)';
    } else {
      equipEl.value = 'Modelo não localizado no banco';
      equipEl.style.color = 'var(--warn)';
    }
  }

  let finalSerie = dictSerie;
  if(!finalSerie){
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    const histMatch = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(histMatch && histMatch.serie) finalSerie = histMatch.serie;
  }
  if(serieEl && finalSerie){
    serieEl.value = finalSerie;
    serieEl.style.color = 'var(--text)';
  }

  let finalSku = dictSku;
  if(!finalSku){
    const allRecs = [...(history || []), ...(_consultaRecords || [])];
    const histMatch = allRecs.find(h => (h.selb||'').toUpperCase() === selb);
    if(histMatch && histMatch.sku) finalSku = histMatch.sku;
  }
  if(skuEl && finalSku){
    skuEl.value = finalSku;
    skuEl.style.color = 'var(--text)';
  }

  // Preenche Unitizador
  if(unitizadorEl){
    if(dictUnitizador){
      unitizadorEl.value = dictUnitizador;
      unitizadorEl.style.color = 'var(--purple)';
    } else {
      unitizadorEl.value = '';
      unitizadorEl.style.color = 'var(--muted)';
    }
  }

  // Libera botão se tiver os campos necessários
  if(submitBtn) submitBtn.disabled = false;
}

// Salva o registro lido no banco de qualidade
async function scannerSaveRecord(){
  const selb     = (document.getElementById('scanner-field-selb')?.value || '').toUpperCase().trim();
  const contador_pb = (document.getElementById('scanner-field-contador-pb')?.value || '').trim();
  const contador_color = (document.getElementById('scanner-field-contador-color')?.value || '').trim();
  const equip    = (document.getElementById('scanner-field-equip')?.value || '').trim();
  const serie    = (document.getElementById('scanner-field-serie')?.value || '').trim();
  const sku      = (document.getElementById('scanner-field-sku')?.value || '').trim();
  const obs      = (document.getElementById('scanner-field-obs')?.value || '').trim();
  const errEl    = document.getElementById('scanner-err-msg');
  const submitBtn = document.getElementById('btn-scanner-submit');

  if(!selb){
    if(errEl) { errEl.textContent = '⚠️ Informe ou verifique o SELB.'; errEl.style.display = 'block'; }
    return;
  }
  if(!getEquipName(selb)){
    if(errEl) { errEl.textContent = '⚠️ SELB "' + selb + '" não encontrado no sistema. Verifique se a planilha de equipamentos foi importada.'; errEl.style.display = 'block'; }
    return;
  }
  if(contador_pb === '' || isNaN(Number(contador_pb)) || Number(contador_pb) < 0){
    if(errEl) { errEl.textContent = '⚠️ Informe um contador PB válido (número ≥ 0).'; errEl.style.display = 'block'; }
    return;
  }
  if(contador_color !== '' && (isNaN(Number(contador_color)) || Number(contador_color) < 0)){
    if(errEl) { errEl.textContent = '⚠️ Informe um contador Color válido (número ≥ 0).'; errEl.style.display = 'block'; }
    return;
  }

  const now = new Date();
  const todayStr = now.toLocaleDateString('pt-BR');
  
  // Valida duplicidade (exceto AUDITORIA, que pode repetir)
  const isAuditoria = (obs || '').toUpperCase() === 'AUDITORIA';
  const isDuplicate = !isAuditoria && Object.values(_qualRegistros || {}).some(r =>
    (r.selb || '').toUpperCase().trim() === selb && r.data === todayStr
  );

  if(isDuplicate){
    if(errEl) { errEl.textContent = `⚠️ O SELB "${selb}" já foi registrado hoje (${todayStr}).`; errEl.style.display = 'block'; }
    return;
  }

  if(errEl) errEl.style.display = 'none';
  
  const registro = {
    selb,
    equipamento : equip || '—',
    serie       : serie || '',
    sku         : sku || '',
    contador_pb : Number(contador_pb),
    contador    : Number(contador_pb), // retrocompatibilidade
    contador_color : contador_color !== '' ? Number(contador_color) : null,
    obs         : obs || 'Lido via câmera OCR',
    responsavel : currentUser ? currentUser.name : 'Desconhecido',
    uid         : currentUser ? currentUser.id : '',
    ts          : now.getTime(),
    data        : todayStr,
    hora        : now.toLocaleTimeString('pt-BR'),
    dateKey     : now.toDateString().replace(/ /g,'_'),
  };

  try {
    if(submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Registrando...'; }
    await dbPush('/qualidade_registros', registro);

    // FluxoLAB: registrar via scanner também move SELB de QUALIDADE → LIBERADAS
    if(selb){
      fluxolabFinalizarSelb(selb, 'QUALIDADE', 'ok').catch(e => console.warn('[FluxoLAB] Erro ao mover SELB para LIBERADAS (scanner):', e));
    }

    alert(`🎉 Registro salvo com sucesso!\nSELB: ${selb}\nContador: ${contador}`);
    scannerResetAll();
  } catch(e) {
    if(errEl) { errEl.textContent = 'Erro ao salvar: ' + e.message; errEl.style.display = 'block'; }
    if(submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '💾 Registrar na Qualidade'; }
  }
}

// Reseta tela de scanner
function scannerResetAll(){
  scannerStopCamera();
  
  // Exibe o painel de câmera novamente
  const cameraPanel = document.getElementById('scanner-camera-panel');
  if(cameraPanel) {
    cameraPanel.style.display = 'flex';
  }
  
  document.getElementById('scanner-field-selb').value = '';
  document.getElementById('scanner-field-contador-pb').value = '';
  document.getElementById('scanner-field-contador-color').value = '';
  document.getElementById('scanner-field-equip').value = '';
  document.getElementById('scanner-field-serie').value = '';
  document.getElementById('scanner-field-sku').value = '';
  const _uEl = document.getElementById('scanner-field-unitizador');
  if(_uEl) _uEl.value = '';
  document.getElementById('scanner-field-obs').value = '';
  
  const errEl = document.getElementById('scanner-err-msg');
  if(errEl) errEl.style.display = 'none';

  const rawBox = document.getElementById('scanner-raw-text');
  if(rawBox) rawBox.value = '';

  const pCard = document.getElementById('scanner-progress-card');
  if(pCard) pCard.style.display = 'none';

  const submitBtn = document.getElementById('btn-scanner-submit');
  if(submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '💾 Registrar na Qualidade';
  }
}


// ════════════════════════════════════════════════════════════════
// PERMISSÕES DE ABAS POR SETOR
// Salvo em /config/sectorTabPerms no Realtime Database.
// Estrutura: { SETOR: { tabKey: true|false, ... }, ... }
// ════════════════════════════════════════════════════════════════
const TAB_DEFS = [
  { key:'dashboard',    id:'tab-dashboard',    label:'Dashboard' },
  { key:'consulta',     id:'tab-consulta',     label:'Consulta' },
  { key:'relatorios',   id:'tab-relatorios',   label:'Relatórios' },
  { key:'pecas',        id:'tab-pecas',        label:'Aguardando Peças' },
  { key:'solicitacoes', id:'tab-solicitacoes', label:'Solicitações do Dia' },
  { key:'maquinas-a',   id:'tab-maquinas-a',   label:'Máquinas A' },
  { key:'gaiola-lab',   id:'tab-gaiola-lab',   label:'Qualidade' },
  { key:'perdidas',     id:'tab-perdidas',     label:'Máquinas Perdidas' },
  { key:'garantia',     id:'tab-garantia',     label:'Garantia' },
  { key:'scanner',      id:'tab-scanner',      label:'Leitor OCR' },
  { key:'fluxolab',     id:'tab-fluxolab',     label:'FluxoLAB' },
];
const PERM_SECTORS_FIXOS = ['MONTAGEM','LIMPEZA','COMPLEXA','ELETRÔNICA','QUALIDADE','DESMEMBRAMENTO','VISUALIZAÇÃO'];
// PERM_SECTORS é uma função (não constante) para refletir setores criados dinamicamente
function getPERMSectors(){ try { return (_setores && _setores.length) ? _setores : PERM_SECTORS_FIXOS; } catch(e) { return PERM_SECTORS_FIXOS; } }

// Padrão = comportamento original hardcoded
function defaultPermsForSector(sector){
  const isQual    = sector==='QUALIDADE';
  const isDisplay = sector==='VISUALIZAÇÃO' || sector==='EXIBIÇÃO';
  const isDesMem  = sector==='DESMEMBRAMENTO';
  return {
    'dashboard':    !isDesMem,
    'consulta':     isQual,
    'relatorios':   isDesMem,
    'pecas':        !isDesMem && !isDisplay,
    'solicitacoes': !isDesMem && !isDisplay,
    'maquinas-a':   !isDesMem && !isDisplay,
    'gaiola-lab':   !isDisplay,
    'perdidas':     !isDesMem && !isDisplay,
    'garantia':     !isDisplay && !isDesMem,
    'scanner':      !isDisplay,
    'fluxolab':     true,
  };
}
function defaultAllPerms(){
  const o = {};
  getPERMSectors().forEach(s => o[s] = defaultPermsForSector(s));
  return o;
}

let _sectorTabPerms = defaultAllPerms();

// Valor bruto do Firebase — guardado para re-merge quando _setores carregar setores dinâmicos
let _sectorTabPermsRaw = null;

function _applySectorTabPermsRaw(){
  const val = _sectorTabPermsRaw;
  const merged = {};
  getPERMSectors().forEach(s => {
    merged[s] = Object.assign({}, defaultPermsForSector(s), (val && val[s]) || {});
  });
  _sectorTabPerms = merged;
  if(typeof currentUser !== 'undefined' && currentUser){
    applySectorTabPerms(currentUser);
  }
  renderSectorPermsUI();
}

// Carrega do Firebase em tempo real
(function loadSectorTabPerms(){
  try{
    _db.ref('/config/sectorTabPerms').on('value', snap => {
      _sectorTabPermsRaw = snap.val();
      _applySectorTabPermsRaw();
    });
  }catch(e){ console.warn('Falha ao carregar permissões de abas:', e); }
})();

function getPermsFor(sector){
  return (_sectorTabPerms && _sectorTabPerms[sector]) || defaultPermsForSector(sector);
}

function applySectorTabPerms(u){
  if(!u) return;
  // Admin enxerga tudo
  if(u.isAdmin){
    TAB_DEFS.forEach(t => {
      const el = document.getElementById(t.id);
      if(el) el.style.display = '';
    });
    return;
  }
  const perms = getPermsFor(u.sector);
  TAB_DEFS.forEach(t => {
    const el = document.getElementById(t.id);
    if(!el) return;
    el.style.display = perms[t.key] ? '' : 'none';
  });
  // Garante que tab-admin nunca aparece para não-admins
  const tabAdmin = document.getElementById('tab-admin');
  if(tabAdmin) tabAdmin.style.display = 'none';
  // tab-equip só para PCP
  const tabEquip = document.getElementById('tab-equip');
  if(tabEquip) tabEquip.style.display = (u.sector === 'PCP') ? '' : 'none';
}

// UI — matriz de checkboxes
function renderSectorPermsUI(){
  const head = document.getElementById('sector-perms-head');
  const body = document.getElementById('sector-perms-body');
  if(!head || !body) return;
  head.innerHTML = '<th style="text-align:left;min-width:140px">Setor</th>' +
    TAB_DEFS.map(t => `<th style="text-align:center;font-size:11px;font-weight:600;color:var(--muted)">${t.label}</th>`).join('');
  body.innerHTML = getPERMSectors().map(sec => {
    const p = getPermsFor(sec);
    const cells = TAB_DEFS.map(t => `
      <td style="text-align:center">
        <input type="checkbox" class="sol-check sec-perm-cb"
               data-sector="${sec}" data-tab="${t.key}"
               ${p[t.key] ? 'checked' : ''}
               style="width:16px;height:16px;cursor:pointer">
      </td>`).join('');
    return `<tr><td style="font-weight:600;font-size:12px">${sec}</td>${cells}</tr>`;
  }).join('');
}

function saveSectorTabPerms(){
  const out = {};
  getPERMSectors().forEach(s => out[s] = {});
  document.querySelectorAll('.sec-perm-cb').forEach(cb => {
    out[cb.dataset.sector][cb.dataset.tab] = cb.checked;
  });
  _db.ref('/config/sectorTabPerms').set(out)
    .then(()=> {
      if(typeof toast === 'function') toast('Permissões salvas com sucesso');
      else alert('Permissões salvas');
    })
    .catch(e => alert('Erro ao salvar: ' + e.message));
}

function resetSectorPerms(){
  if(!confirm('Restaurar as permissões padrão de todos os setores?')) return;
  _db.ref('/config/sectorTabPerms').remove()
    .then(()=> {
      if(typeof toast === 'function') toast('Permissões restauradas');
      else alert('Permissões restauradas ao padrão');
    });
}


// ════════════════════════════════════════════════════════════════
// PERMISSÕES DE SUB-ABAS DE RELATÓRIOS POR SETOR
// Salvo em /config/relSubTabPerms no Realtime Database.
// ════════════════════════════════════════════════════════════════
const REL_TAB_DEFS = [
  { key:'prod',         btnId:'reltab-prod',         label:'Produtividade' },
  { key:'pedido',       btnId:'reltab-pedido',       label:'Facilitador' },
  { key:'scrap',        btnId:'reltab-scrap',        label:'SCRAP' },
  { key:'modelo',       btnId:'reltab-modelo',       label:'Tempo Modelo' },
  { key:'usuario',      btnId:'reltab-usuario',      label:'Tempo Usuário' },
  { key:'mensal',       btnId:'reltab-mensal',       label:'Mensal' },
  { key:'reprov',       btnId:'reltab-reprov',       label:'Reprovadas' },
  { key:'defeitos',     btnId:'reltab-defeitos',     label:'Defeitos' },
  { key:'duplicados',   btnId:'reltab-duplicados',   label:'Duplicados' },
  { key:'busca-modelo', btnId:'reltab-busca-modelo', label:'Busca Modelo' },
  { key:'qual-liberados', btnId:'reltab-qual-liberados', label:'Liberados Qualidade' },
];

function defaultRelPermsForSector(_sector){
  // Padrão: todas as sub-abas liberadas para quem tem acesso a Relatórios
  const o = {};
  REL_TAB_DEFS.forEach(t => o[t.key] = true);
  return o;
}
function defaultAllRelPerms(){
  const o = {};
  getPERMSectors().forEach(s => o[s] = defaultRelPermsForSector(s));
  return o;
}

let _relSubTabPerms = defaultAllRelPerms();

// Valor bruto do Firebase para sub-abas — re-merge após _setores carregar
let _relSubTabPermsRaw = null;

function _applyRelSubTabPermsRaw(){
  const val = _relSubTabPermsRaw;
  const merged = {};
  getPERMSectors().forEach(s => {
    merged[s] = Object.assign({}, defaultRelPermsForSector(s), (val && val[s]) || {});
  });
  _relSubTabPerms = merged;
  if(typeof currentUser !== 'undefined' && currentUser){
    applyRelSubTabPerms(currentUser);
  }
  renderRelSubTabPermsUI();
}

(function loadRelSubTabPerms(){
  try{
    _db.ref('/config/relSubTabPerms').on('value', snap => {
      _relSubTabPermsRaw = snap.val();
      _applyRelSubTabPermsRaw();
    });
  }catch(e){ console.warn('Falha ao carregar permissões de sub-abas:', e); }
})();

function getRelPermsFor(sector){
  return (_relSubTabPerms && _relSubTabPerms[sector]) || defaultRelPermsForSector(sector);
}

function applyRelSubTabPerms(u){
  if(!u) return;
  if(u.isAdmin){
    REL_TAB_DEFS.forEach(t => {
      const el = document.getElementById(t.btnId);
      if(el) el.style.display = '';
    });
    return;
  }
  const perms = getRelPermsFor(u.sector);
  REL_TAB_DEFS.forEach(t => {
    const el = document.getElementById(t.btnId);
    if(!el) return;
    el.style.display = perms[t.key] ? '' : 'none';
  });
  // Se a sub-aba atual ficou bloqueada, vai para a primeira liberada
  if(window._currentRelSubTab && !perms[window._currentRelSubTab]){
    const firstAllowed = REL_TAB_DEFS.find(t => perms[t.key]);
    if(firstAllowed && typeof setRelSubTab === 'function'){
      setRelSubTab(firstAllowed.key);
    }
  }
}

function renderRelSubTabPermsUI(){
  const head = document.getElementById('rel-perms-head');
  const body = document.getElementById('rel-perms-body');
  if(!head || !body) return;
  head.innerHTML = '<th style="text-align:left;min-width:140px">Setor</th>' +
    REL_TAB_DEFS.map(t => `<th style="text-align:center;font-size:11px;font-weight:600;color:var(--muted)">${t.label}</th>`).join('');
  body.innerHTML = getPERMSectors().map(sec => {
    const p = getRelPermsFor(sec);
    const cells = REL_TAB_DEFS.map(t => `
      <td style="text-align:center">
        <input type="checkbox" class="sol-check rel-perm-cb"
               data-sector="${sec}" data-tab="${t.key}"
               ${p[t.key] ? 'checked' : ''}
               style="width:16px;height:16px;cursor:pointer">
      </td>`).join('');
    return `<tr><td style="font-weight:600;font-size:12px">${sec}</td>${cells}</tr>`;
  }).join('');
}

function saveRelSubTabPerms(){
  const out = {};
  getPERMSectors().forEach(s => out[s] = {});
  document.querySelectorAll('.rel-perm-cb').forEach(cb => {
    out[cb.dataset.sector][cb.dataset.tab] = cb.checked;
  });
  _db.ref('/config/relSubTabPerms').set(out)
    .then(()=> {
      if(typeof toast === 'function') toast('Permissões de Relatórios salvas');
      else alert('Permissões salvas');
    })
    .catch(e => alert('Erro ao salvar: ' + e.message));
}

function resetRelSubTabPerms(){
  if(!confirm('Restaurar as permissões padrão das sub-abas de Relatórios?')) return;
  _db.ref('/config/relSubTabPerms').remove()
    .then(()=> {
      if(typeof toast === 'function') toast('Permissões de Relatórios restauradas');
      else alert('Permissões restauradas ao padrão');
    });
}


// ════════════════════════════════════════════════════════════════
// GERENCIAR SETORES
// Setores ficam em Firebase: /setores (array de strings em maiúsculo)
// Setores fixos (nunca removíveis): VISUALIZAÇÃO, EXIBIÇÃO
// ════════════════════════════════════════════════════════════════

const SETORES_FIXOS = ['MONTAGEM','LIMPEZA','COMPLEXA','ELETRÔNICA','QUALIDADE','DESMEMBRAMENTO','VISUALIZAÇÃO'];
let _setores = [...SETORES_FIXOS]; // carregado do Firebase ao iniciar

// Tipo de visualização por setor: 'operador' (tela tipo Montagem) ou 'admin' (visão administrativa)
// Padrão para setores fixos: VISUALIZAÇÃO/QUALIDADE => 'admin'; demais => 'operador'
const SETORES_TIPOS_PADRAO = {
  'MONTAGEM':'operador', 'LIMPEZA':'operador', 'COMPLEXA':'operador',
  'ELETRÔNICA':'operador', 'DESMEMBRAMENTO':'operador',
  'QUALIDADE':'admin', 'VISUALIZAÇÃO':'admin', 'EXIBIÇÃO':'admin'
};
let _setoresTipos = {}; // { NOME_SETOR: 'admin' | 'operador' }

function getSectorTipo(nome){
  if(!nome) return 'operador';
  const n = String(nome).toUpperCase();
  return _setoresTipos[n] || SETORES_TIPOS_PADRAO[n] || 'operador';
}

async function loadSetores() {
  try {
    const { data: rows } = await _supa.from('setores').select('id, nome, raw');
    if (rows && rows.length > 0) {
      const nomes = rows.map(r => (r.nome || r.id).toUpperCase());
      _setores = [...new Set([...SETORES_FIXOS, ...nomes])];
    } else {
      _setores = [...SETORES_FIXOS];
    }
  } catch(e) { _setores = [...SETORES_FIXOS]; }

  try {
    const { data: tiposRows } = await _supa.from('setores_tipos').select('id, raw');
    _setoresTipos = {};
    (tiposRows || []).forEach(r => {
      if (r.raw && typeof r.raw === 'object') Object.assign(_setoresTipos, r.raw);
    });
  } catch(e) { _setoresTipos = {}; }

  _renderMuSectorOpts();
  _renderAdmTabs();
  if (typeof _applySectorTabPermsRaw === 'function') _applySectorTabPermsRaw();
  if (typeof _applyRelSubTabPermsRaw === 'function') _applyRelSubTabPermsRaw();
}

async function _saveSetoresTipos() {
  await _supa.from('setores_tipos').upsert({ id: 'tipos', raw: _setoresTipos }, { onConflict: 'id' });
}

async function _saveSetores() {
  const rows = _setores.map(nome => ({ id: nome, nome, raw: { nome } }));
  await _supa.from('setores').upsert(rows, { onConflict: 'id' });
}

// ── Popula <select id="mu-sector"> ────────────────────────────
function _renderMuSectorOpts(selectedValue) {
  const sel = document.getElementById('mu-sector');
  if (!sel) return;
  const cur = selectedValue || sel.value;
  sel.innerHTML = _setores.map(s => {
    const label = s === 'VISUALIZAÇÃO' ? 'Visualização (somente dashboard)' : _capitalize(s);
    return '<option value="' + s + '"' + (s === cur ? ' selected' : '') + '>' + label + '</option>';
  }).join('');
  if (!sel.value && _setores.length) sel.value = _setores[0];
}

// ── Reconstrói os filtros da tabela de usuários (adm-tabs) ────
function _renderAdmTabs() {
  const tabs = document.getElementById('adm-tabs');
  if (!tabs) return;
  const cur = tabs.querySelector('.stab.a-all') ? '' : (tabs.querySelector('.stab[data-active]') || {}).dataset?.sector || '';
  tabs.innerHTML =
    '<button class="stab a-all" onclick="setAdmFilter(\'\',this)">Todos</button>' +
    _setores.map(s =>
      '<button class="stab" onclick="setAdmFilter(\'' + s + '\',this)">' + _capitalize(s) + '</button>'
    ).join('');
}

function _capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ── Abre modal ───────────────────────────────────────────────
function openGerenciarSetores() {
  _renderSetoresList();
  const inp = document.getElementById('new-setor-nome');
  if (inp) inp.value = '';
  const err = document.getElementById('new-setor-err');
  if (err) err.textContent = '';
  // Injeta select de tipo de visualização ao lado do input, se ainda não existir
  if (inp && !document.getElementById('new-setor-tipo')) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap';
    wrap.innerHTML =
      '<label style="font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.04em">TIPO DE VISUALIZAÇÃO:</label>' +
      '<select id="new-setor-tipo" style="background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:7px;padding:6px 10px;font-family:var(--font);font-size:12px;font-weight:600;cursor:pointer">' +
        '<option value="operador">Tela do Operador (estilo Montagem)</option>' +
        '<option value="admin">Visão Admin (dashboard completo)</option>' +
      '</select>';
    // Tenta inserir após o input ou após o botão de adicionar
    const parent = inp.parentNode;
    if (parent) parent.appendChild(wrap);
  }
  const tipoSel = document.getElementById('new-setor-tipo');
  if (tipoSel) tipoSel.value = 'operador';
  document.getElementById('modal-setores').classList.remove('hidden');
  setTimeout(() => { if (inp) inp.focus(); }, 100);
}

// ── Renderiza lista de setores no modal ──────────────────────
function _renderSetoresList() {
  const list = document.getElementById('setores-list');
  if (!list) return;
  list.innerHTML = _setores.map(s => {
    const isFixo = SETORES_FIXOS.includes(s);
    const emUso  = users.some(u => u.sector === s);
    const canDel = !isFixo && !emUso;
    const qtd    = users.filter(u => u.sector === s).length;
    const tipo   = getSectorTipo(s);
    const tipoLabel = tipo === 'admin' ? 'Admin' : 'Operador';
    const tipoColor = tipo === 'admin'
      ? 'color:#9b8cff;border:1px solid rgba(155,140,255,.35);background:rgba(155,140,255,.08)'
      : 'color:var(--accent2);border:1px solid rgba(61,214,140,.35);background:rgba(61,214,140,.08)';
    const tipoBadge = '<button onclick="toggleSetorTipo(\'' + s + '\')" title="Clique para alternar entre Admin e Operador" style="' + tipoColor + ';border-radius:5px;padding:2px 8px;font-size:10px;font-weight:700;cursor:pointer;font-family:var(--font)">' + tipoLabel + '</button>';
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:9px">' +
      '<span style="font-family:var(--mono);font-size:12px;font-weight:700;color:var(--text);flex:1;letter-spacing:.04em">' + s + '</span>' +
      tipoBadge +
      '<span style="font-size:10px;color:var(--muted)">' + qtd + ' usuário' + (qtd !== 1 ? 's' : '') + '</span>' +
      (isFixo
        ? '<span style="font-size:10px;color:var(--muted);border:1px solid var(--border);border-radius:5px;padding:2px 7px">fixo</span>'
        : emUso
          ? '<span style="font-size:10px;color:#f5a623;border:1px solid rgba(245,166,35,.3);border-radius:5px;padding:2px 7px">em uso</span>'
          : '<button onclick="removeSetor(\'' + s + '\')" style="background:rgba(242,87,87,.12);border:1px solid rgba(242,87,87,.3);color:var(--danger);border-radius:7px;font-size:11px;font-weight:700;padding:3px 10px;cursor:pointer;font-family:var(--font)">Remover</button>'
      ) +
    '</div>';
  }).join('');
}

// ── Alternar tipo de visualização de um setor existente ──────
async function toggleSetorTipo(nome){
  const atual = getSectorTipo(nome);
  const novo  = atual === 'admin' ? 'operador' : 'admin';
  _setoresTipos[nome] = novo;
  try {
    await _saveSetoresTipos();
    _renderSetoresList();
    if (typeof toast === 'function') toast('Setor "' + nome + '" agora é: ' + (novo === 'admin' ? 'Visão Admin' : 'Tela do Operador'));
  } catch(e){
    delete _setoresTipos[nome];
    alert('Erro ao salvar tipo: ' + e.message);
  }
}

// ── Adicionar setor ──────────────────────────────────────────
async function addSetor() {
  const inp = document.getElementById('new-setor-nome');
  const err = document.getElementById('new-setor-err');
  const tipoSel = document.getElementById('new-setor-tipo');
  const nome = (inp.value || '').trim().toUpperCase();
  const tipo = (tipoSel && tipoSel.value === 'admin') ? 'admin' : 'operador';
  err.textContent = '';

  if (!nome)                         { err.textContent = 'Informe o nome do setor.'; return; }
  if (nome.length < 2)               { err.textContent = 'Nome muito curto.'; return; }
  if (nome.length > 30)              { err.textContent = 'Nome muito longo (máx 30 caracteres).'; return; }
  if (_setores.includes(nome))       { err.textContent = 'Setor "' + nome + '" já existe.'; return; }
  if (!/^[A-ZÀ-Ú0-9 _-]+$/.test(nome)) { err.textContent = 'Use apenas letras, números, espaço ou - _'; return; }

  _setores.push(nome);
  _setoresTipos[nome] = tipo;
  try {
    await _saveSetores();
    await _saveSetoresTipos();
    inp.value = '';
    if (tipoSel) tipoSel.value = 'operador';
    _renderSetoresList();
    _renderMuSectorOpts();
    _renderAdmTabs();
    renderSectorPermsUI();
    renderRelSubTabPermsUI();
    if (typeof toast === 'function') toast('Setor "' + nome + '" criado como ' + (tipo === 'admin' ? 'Visão Admin' : 'Tela do Operador') + '!');
  } catch(e) {
    _setores.pop();
    delete _setoresTipos[nome];
    err.textContent = 'Erro ao salvar: ' + e.message;
  }
}

// ── Remover setor ────────────────────────────────────────────
async function removeSetor(nome) {
  if (SETORES_FIXOS.includes(nome)) return;
  if (users.some(u => u.sector === nome)) {
    alert('Não é possível remover "' + nome + '" pois há usuários nesse setor.');
    return;
  }
  if (!confirm('Remover o setor "' + nome + '"?')) return;
  _setores = _setores.filter(s => s !== nome);
  const tipoBackup = _setoresTipos[nome];
  delete _setoresTipos[nome];
  try {
    await _saveSetores();
    await _saveSetoresTipos();
    _renderSetoresList();
    _renderMuSectorOpts();
    _renderAdmTabs();
    renderSectorPermsUI();
    renderRelSubTabPermsUI();
    if (typeof toast === 'function') toast('Setor "' + nome + '" removido.');
  } catch(e) {
    _setores.push(nome);
    if (tipoBackup) _setoresTipos[nome] = tipoBackup;
    alert('Erro ao remover: ' + e.message);
  }
}


// ════════════════════════════════════════════════════════════════
// FLUXOLAB — Rastreamento em tempo real de SELBs por bolsao
// Bolsoes: LIMPEZA, MONTAGEM, COMPLEXA, QUALIDADE, DOCA 1-4
// Estrutura Firebase: /fluxolab/<bolsao>/<selbKey> = { selb, uid, userName, sector, ts }
// Regra: cada SELB e unico no sistema sem duplicatas entre bolsoes.
// ════════════════════════════════════════════════════════════════

const FLUXOLAB_BOLSOES = [
  { key: 'LIMPEZA',       label: 'Limpeza',             icon: '🧹', color: 'var(--accent)',  bg: 'rgba(79,142,247,.08)',  border: 'rgba(79,142,247,.3)'  },
  { key: 'LINHA_LIMPEZA', label: 'Bolsão Montagem',     icon: '✨', color: '#60a5fa',        bg: 'rgba(96,165,250,.08)',  border: 'rgba(96,165,250,.35)' },
  { key: 'MONTAGEM',      label: 'Montagem',            icon: '🔧', color: 'var(--accent2)', bg: 'rgba(61,214,140,.08)',  border: 'rgba(61,214,140,.3)'  },
  { key: 'COMPLEXA',      label: 'Complexa',            icon: '⚙️', color: 'var(--purple)',  bg: 'rgba(167,139,250,.08)', border: 'rgba(167,139,250,.3)' },
  { key: 'QUALIDADE',     label: 'Bolsão Qualidade',    icon: '🔬', color: '#f5a623',        bg: 'rgba(245,166,35,.08)',  border: 'rgba(245,166,35,.3)'  },
  { key: 'LIBERADAS',     label: 'Liberados Qualidade', icon: '✅', color: '#10b981',        bg: 'rgba(16,185,129,.08)',  border: 'rgba(16,185,129,.35)' },
  { key: 'SCRAP',         label: 'Scrap',               icon: '🗑️', color: '#f25757',        bg: 'rgba(242,87,87,.08)',   border: 'rgba(242,87,87,.35)'  },
  { key: 'GAIOLA_LAB',       label: 'Gaiola LAB',          icon: '🪣', color: '#e879f9',        bg: 'rgba(232,121,249,.08)', border: 'rgba(232,121,249,.3)' },
  { key: 'GAIOLA_AG_PECAS',  label: 'Gaiola Ag. peças',    icon: '🛠️', color: '#f59e0b',        bg: 'rgba(245,158,11,.08)',  border: 'rgba(245,158,11,.3)'  },
  { key: 'DOCA_1',           label: 'Doca 1',              icon: '📦', color: '#22d3ee',        bg: 'rgba(34,211,238,.08)',  border: 'rgba(34,211,238,.3)'  },
];

// Mapeia (setor que finalizou, resultado) → bolsão de destino na finalização.
// Se retornar null, o SELB é removido do FluxoLAB (comportamento antigo).
function _fluxolabDestinoFinal(sector, res){
  if(res === 'scrap'){
    // DESMEMBRAMENTO registra scrap direto — SELB sai de todos os bolões sem entrar em nenhum
    if(sector === 'DESMEMBRAMENTO') return null;
    return 'SCRAP';
  }
  if(res === 'aguardando') return 'GAIOLA_AG_PECAS';
  if(res !== 'ok')    return null; // rep, cancelado, etc — apenas remove
  if(sector === 'LIMPEZA')   return 'LINHA_LIMPEZA';
  if(sector === 'MONTAGEM')  return 'QUALIDADE';
  if(sector === 'COMPLEXA')  return 'QUALIDADE';
  if(sector === 'QUALIDADE') return 'LIBERADAS';
  return null;
}

const FLUXOLAB_SECTOR_BOLSAO = {
  'LIMPEZA':   'LIMPEZA',
  'MONTAGEM':  'MONTAGEM',
  'COMPLEXA':  'COMPLEXA',
  'QUALIDADE': 'QUALIDADE',
};

let _fluxolabData = {};
let _fluxolabListener = null;

// Retorna o timestamp (ts) de entrada do SELB no bolsão atual do FluxoLAB.
// Usado pelo timer do dashboard para medir o tempo desde a entrada no bolsão.
function _fluxolabGetSelbEntryTs(selbCode) {
  if (!selbCode || !_fluxolabData) return null;
  const code = String(selbCode).toUpperCase().trim();
  for (const bolsao of Object.keys(_fluxolabData)) {
    const items = _fluxolabData[bolsao];
    if (!items) continue;
    for (const val of Object.values(items)) {
      if (val && String(val.selb || '').toUpperCase().trim() === code && val.ts) {
        return val.ts;
      }
    }
  }
  return null;
}

// ── Estado do painel de movimentacao MULTI-SELB ───────────────
// Cada item: { code, equip, bolsaoAtual, status }
// status: 'ok' | 'notfound' | 'duplicate'
let _fmovQueue = [];   // array de { code, equip, bolsaoAtual }

function fluxolabStartListener() {
  if (_fluxolabListener) return;
  _fluxolabListener = _db.ref('/fluxolab').on('value', snap => {
    _fluxolabData = snap.val() || {};
    _fluxolabScheduleSyncLiberados();
    const viewEl = document.getElementById('view-fluxolab');
    if (viewEl && viewEl.classList.contains('active')) {
      _fluxolabRenderGrid();
      _fluxolabUpdateTimestamp();
      // Re-renderiza aba checklists se estiver ativa para atualizar Lab/Doca
      if (_fluxolabActiveTab === 'checklists') {
        try { fluxolabRenderChecklistsImported(); } catch(e) {}
      }
    }
    // Atualiza chips se a fila estiver aberta
    if (_fmovQueue.length) _fmovRefreshChips();
  }, err => console.warn('[FluxoLAB] listener error:', err));
}

function renderFluxoLAB() {
  const adminBtn = document.getElementById('btn-fluxolab-admin-toggle');
  if (adminBtn) adminBtn.style.display = (currentUser && currentUser.isAdmin) ? '' : 'none';
  fluxolabStartListener();
  fluxolabStartChecklistsListener();
  // Inicia listener do log em background para que o badge funcione imediatamente
  // e entradas não se percam por push assíncrono antes de abrir o painel
  fluxolabStartLogListener();
  _fluxolabRenderGrid();
  _fluxolabUpdateTimestamp();
  _fmovPopulateSelbList();
  _fmovBuildDestList();
  _fluxolabScheduleSyncLiberados();
}

function fluxolabForceRefresh() {
  dbGet('/fluxolab').then(data => {
    _fluxolabData = data || {};
    _fluxolabRenderGrid();
    _fluxolabUpdateTimestamp();
  }).catch(() => {});
}

function _fluxolabUpdateTimestamp() {
  const el = document.getElementById('fluxolab-last-update');
  if (el) el.textContent = 'Atualizado as ' + new Date().toLocaleTimeString('pt-BR');
}

// ── Datalist com todos os SELBs cadastrados ───────────────────
function _fmovPopulateSelbList() {
  const dl = document.getElementById('fmov-selb-list');
  if (!dl) return;
  dl.innerHTML = '';
  if (typeof equipamentos !== 'undefined') {
    Object.entries(equipamentos).forEach(([selb, modelo]) => {
      const opt = document.createElement('option');
      opt.value = selb;
      opt.label = modelo || '';
      dl.appendChild(opt);
    });
  }
}

// ── Radio buttons de destino ──────────────────────────────────
function _fmovBuildDestList() {
  const container = document.getElementById('fmov-dest-list');
  if (!container || container.dataset.built === '1') return;
  container.dataset.built = '1';
  // Liberadas e Scrap são destinos automáticos (definidos pela finalização),
  // por isso não aparecem como opção manual de movimentação.
  const _destinosManuais = FLUXOLAB_BOLSOES.filter(b => b.key !== 'LIBERADAS' && b.key !== 'SCRAP');
  container.innerHTML = _destinosManuais.map(b =>
    '<label class="fmov-dest-item" style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:9px;border:1px solid var(--border);cursor:pointer;transition:all .12s;background:var(--bg3)"' +
    ' onmouseover="if(!this.querySelector(\'input\').checked){this.style.borderColor=\'' + b.border + '\';this.style.background=\'' + b.bg + '\'}"' +
    ' onmouseout="if(!this.querySelector(\'input\').checked){this.style.borderColor=\'var(--border)\';this.style.background=\'var(--bg3)\'}">' +
    '<input type="radio" name="fmov-dest" class="fmov-dest-radio" value="' + b.key + '"' +
      ' onchange="_fmovOnDestChange(this)" style="accent-color:' + b.color + ';width:15px;height:15px;cursor:pointer;flex-shrink:0">' +
    '<span style="font-size:16px">' + b.icon + '</span>' +
    '<span style="font-size:12px;font-weight:600;color:var(--text);flex:1">' + b.label + '</span>' +
    '</label>'
  ).join('');
}

function _fmovOnDestChange(radio) {
  document.querySelectorAll('.fmov-dest-item').forEach(item => {
    const r = item.querySelector('input');
    const b = FLUXOLAB_BOLSOES.find(x => x.key === r.value);
    if (r.checked && b) { item.style.borderColor = b.border; item.style.background = b.bg; }
    else                 { item.style.borderColor = 'var(--border)'; item.style.background = 'var(--bg3)'; }
  });
}

// ── Busca o bolsão atual de um SELB nos dados locais ─────────
function _fmovGetBolsaoAtual(code) {
  const key = code.replace(/[^a-zA-Z0-9_-]/g, '_');
  let found = '';
  Object.entries(_fluxolabData).forEach(([bolsao, items]) => {
    if (!items || found) return;
    if (items[key]) { found = bolsao; return; }
    Object.values(items).forEach(v => {
      if (v && v.selb && v.selb.trim().toUpperCase() === code) found = bolsao;
    });
  });
  return found;
}

// ── Re-renderiza todos os chips com status atualizado ─────────
function _fmovRefreshChips() {
  _fmovQueue.forEach(item => {
    item.bolsaoAtual = _fmovGetBolsaoAtual(item.code);
  });
  _fmovRenderChips();
}

// ── Renderiza chips dentro do tag-box ────────────────────────
function _fmovRenderChips() {
  const box = document.getElementById('fmov-tag-box');
  const inp = document.getElementById('fmov-selb-inp');
  if (!box || !inp) return;

  // Remove chips antigos (mantém o input)
  box.querySelectorAll('.fmov-chip').forEach(c => c.remove());

  // Recria chips antes do input
  _fmovQueue.forEach((item, idx) => {
    const bolsao = item.bolsaoAtual;
    const b = FLUXOLAB_BOLSOES.find(x => x.key === bolsao);
    const isDup = _fmovQueue.filter(x => x.code === item.code).length > 1;

    // Cor do chip
    let chipBg, chipBorder, chipColor, chipTitle;
    if (isDup) {
      chipBg = 'rgba(242,87,87,.15)'; chipBorder = 'rgba(242,87,87,.4)'; chipColor = 'var(--danger)';
      chipTitle = 'Duplicado na lista';
    } else if (item.equip && !item.isUnknown) {
      chipBg = 'rgba(61,214,140,.1)'; chipBorder = 'rgba(61,214,140,.35)'; chipColor = 'var(--accent2)';
      chipTitle = item.equip + (bolsao && b ? ' · Em: ' + b.label : ' · Novo no sistema');
    } else {
      // SELB não reconhecido — será salvo como DESCONHECIDO no bolsão
      chipBg = 'rgba(245,166,35,.1)'; chipBorder = 'rgba(245,166,35,.35)'; chipColor = '#f5a623';
      chipTitle = 'DESCONHECIDO — SELB não encontrado nos equipamentos' + (bolsao && b ? ' · Em: ' + b.label : '');
    }

    // Badge do bolsão atual (pequeno)
    const bolsaoBadge = (bolsao && b)
      ? '<span style="font-size:9px;background:' + b.bg + ';color:' + b.color + ';border:1px solid ' + b.border + ';border-radius:4px;padding:1px 5px;margin-left:3px;white-space:nowrap">' + b.icon + ' ' + b.label + '</span>'
      : '';

    const chip = document.createElement('div');
    chip.className = 'fmov-chip';
    chip.title = chipTitle;
    chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:3px 8px 3px 10px;border-radius:20px;border:1px solid ' + chipBorder + ';background:' + chipBg + ';max-width:100%;cursor:default;';
    chip.innerHTML =
      '<span style="font-family:var(--mono);font-size:12px;font-weight:700;color:' + chipColor + ';white-space:nowrap">' + item.code + '</span>' +
      bolsaoBadge +
      '<button onclick="fmovRemoveChip(' + idx + ')" style="background:none;border:none;color:' + chipColor + ';opacity:.5;cursor:pointer;font-size:13px;line-height:1;padding:0 0 0 2px" onmouseover="this.style.opacity=\'1\'" onmouseout="this.style.opacity=\'.5\'">✕</button>';
    box.insertBefore(chip, inp);
  });

  // Atualiza badge de contagem
  const badge = document.getElementById('fmov-count-badge');
  if (badge) {
    if (_fmovQueue.length > 0) {
      badge.textContent = _fmovQueue.length + ' SELB' + (_fmovQueue.length !== 1 ? 's' : '');
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  }

  // Atualiza placeholder — sem uppercase para não distorcer
  inp.placeholder = _fmovQueue.length === 0 ? 'Digite o SELB e pressione Enter…' : 'Adicionar mais…';
  inp.style.textTransform = 'uppercase';
}

// ── Remove chip por índice ────────────────────────────────────
function fmovRemoveChip(idx) {
  _fmovQueue.splice(idx, 1);
  _fmovRenderChips();
}

// ── Input: feedback em tempo real ao digitar ──────────────────
function fmovOnSelbInput() {
  const inp = document.getElementById('fmov-selb-inp');
  const fb  = document.getElementById('fmov-typing-feedback');
  if (!inp || !fb) return;
  const code = inp.value.trim().toUpperCase();
  if (!code) { fb.innerHTML = ''; fb._valid = false; return; }

  // Feedback de comprimento (máx 4 chars no input)
  if (code.length > 4) {
    inp.value = code.slice(0, 4); // trunca automaticamente
    return fmovOnSelbInput();
  }

  const charLeft = 4 - code.length;
  if (code.length < 4) {
    fb.innerHTML = '<span style="color:var(--muted);font-size:10px">' + code.length + '/4 caracteres' + (charLeft > 0 ? ' — faltam ' + charLeft : '') + '</span>';
    return;
  }

  // Exatamente 4 chars — valida
  const equip  = (typeof getEquipName === 'function') ? getEquipName(code) : '';
  const bolsao = _fmovGetBolsaoAtual(code);
  const b      = FLUXOLAB_BOLSOES.find(x => x.key === bolsao);
  const jaAdic = _fmovQueue.some(x => x.code === code);

  if (jaAdic) {
    fb.innerHTML = '<span style="color:#f5a623">⚠️ Já está na lista</span>';
    return;
  }

  if (equip) {
    // ── SELB reconhecido: adiciona automaticamente ──
    const added = fmovAddCode(code);
    inp.value = '';
    clearTimeout(fb._t);
    const loc = (bolsao && b)
      ? ' &nbsp;·&nbsp; <span style="color:' + b.color + '">' + b.icon + ' ' + b.label + '</span>'
      : '';
    fb.innerHTML = '<span style="color:var(--accent2)">✔ ' + code + ' — ' + equip + '</span>' + loc;
    fb._t = setTimeout(() => { if (fb) fb.innerHTML = ''; }, 1400);
    inp.focus();
    return;
  }

  // Não cadastrado — avisa como DESCONHECIDO, aguarda Enter
  const locBadge = (bolsao && b)
    ? ' &nbsp;<span style="color:' + b.color + ';font-size:10px">' + b.icon + ' ' + b.label + '</span>'
    : '';
  fb.innerHTML = '<span style="color:#f5a623">⚠ DESCONHECIDO</span>'
    + locBadge
    + ' &nbsp;<span style="color:var(--muted);font-size:10px">— pressione Enter para adicionar</span>';
}

// ── Keydown: Enter confirma e limpa imediatamente ─────────────
function fmovOnSelbKeydown(e) {
  const inp = document.getElementById('fmov-selb-inp');
  const fb  = document.getElementById('fmov-typing-feedback');
  if (!inp) return;
  const code = inp.value.trim().toUpperCase();

  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    if (!code) return;

    // Valida: SELB deve ter exatamente 4 caracteres
    if (code.length !== 4) {
      if (fb) {
        fb.innerHTML = '<span style="color:var(--danger)">⛔ SELB deve ter exatamente 4 caracteres (digitado: ' + code.length + ')</span>';
        clearTimeout(fb._t);
        fb._t = setTimeout(() => { if (fb) fb.innerHTML = ''; }, 2000);
      }
      inp.select();
      return;
    }

    const jaAdic = _fmovQueue.some(x => x.code === code);
    if (jaAdic) {
      if (fb) { fb.innerHTML = '⚠️ ' + code + ' já está na lista'; fb.style.color = '#f5a623'; }
      inp.select();
      return;
    }

    const added = fmovAddCode(code);

    // Limpa campo e foca para próximo imediatamente
    inp.value = '';
    if (fb) {
      clearTimeout(fb._t);
      if (added) {
        const equip = (typeof getEquipName === 'function') ? getEquipName(code) : '';
        fb.innerHTML = '<span style="color:var(--accent2)">✔ ' + code + (equip ? ' — ' + equip : '') + ' adicionado</span>';
      } else {
        fb.innerHTML = '<span style="color:#f5a623">⚠️ ' + code + ' já está na lista</span>';
      }
      fb._t = setTimeout(() => { if (fb) fb.innerHTML = ''; }, 1200);
    }
    inp.focus();
    return;
  }

  // Backspace sem texto: remove o último chip
  if (e.key === 'Backspace' && !inp.value && _fmovQueue.length > 0) {
    const removed = _fmovQueue.pop();
    _fmovRenderChips();
    if (fb) {
      clearTimeout(fb._t);
      fb.innerHTML = '<span style="color:var(--muted)">✕ ' + removed.code + ' removido</span>';
      fb._t = setTimeout(() => { if (fb) fb.innerHTML = ''; }, 1000);
    }
  }
}

// ── Paste: processa lista de SELBs colada de uma vez ─────────
function fmovOnSelbPaste(e) {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;

  // Se parece um único SELB (≤4 chars sem separadores), deixa o comportamento padrão
  const tokens = text.trim().split(/[\s,;|\n\t]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
  if (tokens.length <= 1 && tokens[0] && tokens[0].length <= 4) return;

  // Múltiplos SELBs — intercepta o paste e processa cada um
  e.preventDefault();

  const fb = document.getElementById('fmov-typing-feedback');
  const inp = document.getElementById('fmov-selb-inp');

  let adicionados = 0, duplicados = 0, invalidos = 0;

  tokens.forEach(token => {
    if (token.length !== 4) { invalidos++; return; }
    const added = fmovAddCode(token);
    if (added) adicionados++;
    else duplicados++;
  });

  if (inp) inp.value = '';

  if (fb) {
    clearTimeout(fb._t);
    const partes = [];
    if (adicionados > 0) partes.push('<span style="color:var(--accent2)">✔ ' + adicionados + ' adicionado' + (adicionados !== 1 ? 's' : '') + '</span>');
    if (duplicados  > 0) partes.push('<span style="color:#f5a623">⚠ ' + duplicados  + ' já na lista</span>');
    if (invalidos   > 0) partes.push('<span style="color:var(--danger)">⛔ ' + invalidos + ' inválido' + (invalidos !== 1 ? 's' : '') + '</span>');
    fb.innerHTML = partes.join(' &nbsp;·&nbsp; ');
    fb._t = setTimeout(() => { if (fb) fb.innerHTML = ''; }, 3000);
  }
}
function fmovAddCode(code) {
  if (!code) return false;
  // Valida: SELB deve ter exatamente 4 caracteres
  if (code.length !== 4) return false;
  const count = _fmovQueue.filter(x => x.code === code).length;
  if (count >= 1) return false; // já está, não adiciona de novo
  const _rawEquip = (typeof getEquipName === 'function') ? (getEquipName(code) || '') : '';
  // SELBs não cadastrados ficam como DESCONHECIDO (não são bloqueados, mas sinalizados)
  const equip = _rawEquip || 'DESCONHECIDO';
  const bolsaoAtual = _fmovGetBolsaoAtual(code);
  _fmovQueue.push({ code, equip, bolsaoAtual, isUnknown: !_rawEquip });
  _fmovRenderChips();
  return true;
}

// ── Executa movimentação de TODOS os SELBs da fila ───────────
async function fmovExecutar() {
  const destEl = document.querySelector('.fmov-dest-radio:checked');
  // Verifica se tem código digitado mas não adicionado
  const inp = document.getElementById('fmov-selb-inp');
  if (inp && inp.value.trim()) fmovAddCode(inp.value.trim().toUpperCase());

  if (_fmovQueue.length === 0) { alert('Adicione pelo menos um SELB.'); return; }
  if (!destEl) { alert('Selecione o bolsão de destino.'); return; }
  const destBolsao = destEl.value;

  const btn = document.getElementById('btn-fmov-mover');
  if (btn) { btn.disabled = true; btn.textContent = 'Movendo ' + _fmovQueue.length + ' SELB(s)…'; }

  const erros = [];
  const b = FLUXOLAB_BOLSOES.find(x => x.key === destBolsao);

  for (const item of _fmovQueue) {
    try {
      await fluxolabRemoveSelbGlobal(item.code);
      const selfKey = item.code.replace(/[^a-zA-Z0-9_-]/g, '_');
      await dbSet('/fluxolab/' + destBolsao + '/' + selfKey, {
        selb:        item.code,
        uid:         currentUser ? currentUser.id : '',
        userName:    currentUser ? currentUser.name : '',
        sector:      currentUser ? currentUser.sector : '',
        equipamento: item.equip || 'DESCONHECIDO',
        ts:          Date.now(),
        movidoPor:   currentUser ? currentUser.name : '',
      });
      // Log de movimentação manual
      _fluxolabLogEntry(item.code, item.bolsaoAtual || '—', destBolsao, item.equip || 'DESCONHECIDO');
    } catch (e) {
      erros.push(item.code + ': ' + e.message);
    }
  }

  if (erros.length === 0) {
    if (typeof toast === 'function') toast(_fmovQueue.length + ' SELB(s) movidos para ' + (b ? b.label : destBolsao));
  } else {
    alert('Concluído com erros:\n' + erros.join('\n'));
  }

  // Limpa tudo
  _fmovQueue = [];
  if (inp) inp.value = '';
  const fb = document.getElementById('fmov-typing-feedback');
  if (fb) fb.textContent = '';
  _fmovRenderChips();
  document.querySelectorAll('.fmov-dest-radio').forEach(r => { r.checked = false; });
  _fmovOnDestChange({});
  if (btn) { btn.disabled = false; btn.textContent = '🚀 Mover SELBs'; }
}

// Filtro de modelo em destaque (aba Bolsões)
let _fluxolabBolsaoModelFilter = '';
function fluxolabSetBolsaoModelFilter(v){
  _fluxolabBolsaoModelFilter = (v || '').trim().toUpperCase();
  _fluxolabRenderGrid();
}
function _fluxolabRenderModelFilterBar(allModels, matchCountsByBolsao, totalMatches){
  const layout = document.getElementById('fluxolab-bolsoes-layout');
  if (!layout) return;
  let bar = document.getElementById('fluxolab-bolsao-filter-bar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'fluxolab-bolsao-filter-bar';
    bar.style.cssText = 'grid-column:1/-1;background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:4px';
    layout.insertBefore(bar, layout.firstChild);
  }
  const cur = _fluxolabBolsaoModelFilter;
  const opts = allModels.slice().sort().map(m => '<option value="'+m.replace(/"/g,'&quot;')+'"></option>').join('');
  const totalBadge = cur
    ? '<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.4);color:var(--accent);font-size:12px;font-weight:700;border-radius:8px;padding:4px 10px;font-family:var(--mono)">★ '+totalMatches+' SELB'+(totalMatches!==1?'s':'')+' destacados</span>'
    : '<span style="color:var(--muted);font-size:11px">Selecione um modelo para destacar seus SELBs nos bolsões</span>';
  const clearBtn = cur
    ? '<button onclick="fluxolabSetBolsaoModelFilter(\'\')" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);color:#ef4444;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer">✕ Limpar</button>'
    : '';
  bar.innerHTML =
    '<span style="font-size:12px;font-weight:700;color:var(--text)">🎯 Destacar modelo:</span>'
    + '<input list="fluxolab-bolsao-filter-models" id="fluxolab-bolsao-filter-input" placeholder="Digite ou selecione um modelo…" value="'+cur.replace(/"/g,'&quot;')+'" '
        + 'style="flex:1;min-width:240px;background:var(--bg3);border:1px solid var(--border2);color:var(--text);border-radius:8px;padding:7px 12px;font-size:12px;font-family:var(--font)" '
        + 'onchange="fluxolabSetBolsaoModelFilter(this.value)" onkeydown="if(event.key===\'Enter\')fluxolabSetBolsaoModelFilter(this.value)">'
    + '<datalist id="fluxolab-bolsao-filter-models">'+opts+'</datalist>'
    + totalBadge + clearBtn;
}

// ─── Ordem customizada dos bolsões (persistida em localStorage) ───
const _FLUXOLAB_ORDER_KEY = 'fluxolab_bolsao_order_v1';
function _fluxolabGetBolsaoOrder(){
  try {
    const raw = localStorage.getItem(_FLUXOLAB_ORDER_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch(e){ return null; }
}
function _fluxolabSaveBolsaoOrder(order){
  try { localStorage.setItem(_FLUXOLAB_ORDER_KEY, JSON.stringify(order)); } catch(e){}
}
function fluxolabResetBolsaoOrder(){
  try { localStorage.removeItem(_FLUXOLAB_ORDER_KEY); } catch(e){}
  if (typeof _fluxolabRenderGrid === 'function') _fluxolabRenderGrid();
}
function fluxolabMoveBolsao(key, dir){
  // Inicializa ordem a partir da ordem atualmente exibida, se ainda não existe.
  let order = _fluxolabGetBolsaoOrder();
  if (!order || !order.length){
    // Reconstrói a ordem atual (mesma lógica do render: ordenada por maxDias desc)
    order = FLUXOLAB_BOLSOES.map(b => {
      const items = _fluxolabData[b.key] ? Object.entries(_fluxolabData[b.key]) : [];
      return { key: b.key, maxDias: _fluxolabMaxDias(items) };
    }).sort((a,b) => b.maxDias - a.maxDias).map(x => x.key);
  }
  // Garante que todos os bolsões conhecidos estejam na lista (anexa os faltantes ao final)
  FLUXOLAB_BOLSOES.forEach(b => { if (!order.includes(b.key)) order.push(b.key); });
  const idx = order.indexOf(key);
  if (idx < 0) return;
  const target = idx + dir;
  if (target < 0 || target >= order.length) return;
  const tmp = order[idx]; order[idx] = order[target]; order[target] = tmp;
  _fluxolabSaveBolsaoOrder(order);
  _fluxolabRenderGrid();
}
function _fluxolabEnsureOrder(){
  let order = _fluxolabGetBolsaoOrder();
  if (!order || !order.length){
    order = FLUXOLAB_BOLSOES.map(b => {
      const items = _fluxolabData[b.key] ? Object.entries(_fluxolabData[b.key]) : [];
      return { key: b.key, maxDias: _fluxolabMaxDias(items) };
    }).sort((a,b) => b.maxDias - a.maxDias).map(x => x.key);
  }
  FLUXOLAB_BOLSOES.forEach(b => { if (!order.includes(b.key)) order.push(b.key); });
  return order;
}
function fluxolabReorderBolsao(fromKey, toKey){
  if (!fromKey || !toKey || fromKey === toKey) return;
  const order = _fluxolabEnsureOrder();
  const fromIdx = order.indexOf(fromKey);
  const toIdx = order.indexOf(toKey);
  if (fromIdx < 0 || toIdx < 0) return;
  order.splice(fromIdx, 1);
  const newToIdx = order.indexOf(toKey);
  // Insere antes do alvo se vinha da direita, depois se vinha da esquerda
  const insertAt = fromIdx < toIdx ? newToIdx + 1 : newToIdx;
  order.splice(insertAt, 0, fromKey);
  _fluxolabSaveBolsaoOrder(order);
  _fluxolabRenderGrid();
}
// Estado global do drag
window._fluxolabDragKey = null;
function _fluxolabDragStart(ev, key){
  window._fluxolabDragKey = key;
  try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', key); } catch(e){}
  const card = ev.currentTarget;
  if (card && card.style) { card.style.opacity = '0.4'; }
}
function _fluxolabDragEnd(ev){
  const card = ev.currentTarget;
  if (card && card.style) { card.style.opacity = '1'; }
  document.querySelectorAll('[data-bolsao-card]').forEach(el => { el.style.outline = ''; });
  window._fluxolabDragKey = null;
}
function _fluxolabDragOver(ev, key){
  if (!window._fluxolabDragKey || window._fluxolabDragKey === key) return;
  ev.preventDefault();
  try { ev.dataTransfer.dropEffect = 'move'; } catch(e){}
  const card = ev.currentTarget;
  if (card && card.style) { card.style.outline = '2px dashed var(--accent)'; }
}
function _fluxolabDragLeave(ev){
  const card = ev.currentTarget;
  if (card && card.style) { card.style.outline = ''; }
}
function _fluxolabDrop(ev, toKey){
  ev.preventDefault();
  const fromKey = window._fluxolabDragKey;
  document.querySelectorAll('[data-bolsao-card]').forEach(el => { el.style.outline = ''; });
  window._fluxolabDragKey = null;
  if (fromKey && toKey && fromKey !== toKey) fluxolabReorderBolsao(fromKey, toKey);
}

function _fluxolabRenderGrid() {
  const grid = document.getElementById('fluxolab-grid');
  if (!grid) return;

  const checklistIdx = _fluxolabBuildChecklistIndex();

  // Coleta lista de modelos presentes em qualquer bolsão (para o datalist)
  const allModelsSet = new Set();
  // 1) Pré-calcula: modelCounts[modelo][bolsaoKey] = count
  const modelCounts = {};
  FLUXOLAB_BOLSOES.forEach(bb => {
    const its = _fluxolabData[bb.key] ? Object.entries(_fluxolabData[bb.key]) : [];
    its.forEach(([k, v]) => {
      const selbCode = v.selb || k;
      const _eqStored = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : '';
      const modelo = _eqStored
        || (typeof getEquipName === 'function' ? (getEquipName(selbCode) || '') : '')
        || 'DESCONHECIDO';
      if (modelo && modelo !== 'DESCONHECIDO') allModelsSet.add(modelo);
      if (!modelCounts[modelo]) modelCounts[modelo] = {};
      modelCounts[modelo][bb.key] = (modelCounts[modelo][bb.key] || 0) + 1;
    });
  });

  // Mapa rápido bolsaoKey -> meta (cor/bg/border/icon/label)
  const bolsaoMeta = {};
  FLUXOLAB_BOLSOES.forEach(bb => { bolsaoMeta[bb.key] = bb; });

  // Filtro de modelo ativo
  const filterModel = _fluxolabBolsaoModelFilter || '';
  const matchCountsByBolsao = {};
  let totalMatches = 0;
  const isMatch = (selbCode, v) => {
    if (!filterModel) return false;
    const _eqStored = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : '';
    const modelo = (_eqStored || (typeof getEquipName === 'function' ? (getEquipName(selbCode) || '') : '') || '').toUpperCase();
    return modelo === filterModel || (modelo && modelo.includes(filterModel));
  };

  // Ordem dos bolsões: usa ordem customizada salva pelo usuário (se houver),
  // senão ordena pelo maior tempo de permanência primeiro (decrescente).
  const customOrder = _fluxolabGetBolsaoOrder();
  const bolsaoListRaw = FLUXOLAB_BOLSOES.map(b => {
    const items = _fluxolabData[b.key] ? Object.entries(_fluxolabData[b.key]) : [];
    return { b, items, maxDias: _fluxolabMaxDias(items) };
  });
  const bolsaoList = customOrder && customOrder.length
    ? (() => {
        const byKey = Object.fromEntries(bolsaoListRaw.map(x => [x.b.key, x]));
        const ordered = customOrder.map(k => byKey[k]).filter(Boolean);
        const restantes = bolsaoListRaw.filter(x => !customOrder.includes(x.b.key));
        return ordered.concat(restantes);
      })()
    : bolsaoListRaw.slice().sort((a, b) => b.maxDias - a.maxDias);

  grid.innerHTML = bolsaoList.map(({ b, items, maxDias }) => {
    const count = items.length;

    // Conta matches deste bolsão
    let bolsaoMatch = 0;
    if (filterModel){
      items.forEach(([k, v]) => { if (isMatch(v.selb || k, v)) bolsaoMatch++; });
      matchCountsByBolsao[b.key] = bolsaoMatch;
      totalMatches += bolsaoMatch;
    }

    // Renderiza todos os SELBs em lista plana — ordena pelo maior tempo no bolsão (ts mais antigo primeiro)
    const itemsSorted = [...items].sort((a, b) => (a[1].ts || 0) - (b[1].ts || 0));
    const chips = itemsSorted.map(([k, v]) => {
      const timeAgo = v.ts ? _fluxolabTimeAgo(v.ts) : '';
      const selbCode = v.selb || k;
      const notInEquip = Object.keys(equipamentos).length > 0 && (typeof getEquipName === 'function') && !getEquipName(selbCode);
      const warnBadge = notInEquip
        ? '<span title="SELB não encontrado na planilha de equipamentos atual — pode ter sido removido" style="margin-left:3px;font-size:11px;cursor:default">⚠️</span>'
        : '';
      const adminRemoveBtn = (currentUser && currentUser.isAdmin)
        ? '<button onclick="event.stopPropagation();if(confirm(\'Remover SELB ' + selbCode + ' do bol\\u00e3o?\')) fluxolabRemoveItem(\'' + b.key + '\',\'' + k + '\')" title="Remover SELB do bol\u00e3o" style="flex-shrink:0;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#ef4444;border-radius:6px;width:22px;height:22px;cursor:pointer;font-size:16px;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;transition:all .15s;padding:0" onmouseover="this.style.background=\'rgba(239,68,68,.3)\';this.style.borderColor=\'rgba(239,68,68,.7)\'" onmouseout="this.style.background=\'rgba(239,68,68,.12)\';this.style.borderColor=\'rgba(239,68,68,.35)\'">\u00d7</button>'
        : '';
      // Modelo do SELB (equipamento)
      const _eqStored = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : '';
      const modeloSelb = _eqStored || (typeof getEquipName === 'function' ? (getEquipName(selbCode) || '') : '') || '';
      // Destaque/atenuação conforme filtro
      const matched = filterModel ? isMatch(selbCode, v) : true;
      const chipBg = matched ? (filterModel ? 'rgba(16,185,129,.14)' : 'var(--bg3)') : 'var(--bg3)';
      const chipBd = matched && filterModel ? 'rgba(16,185,129,.65)' : (notInEquip ? 'rgba(245,166,35,.5)' : 'var(--border)');
      const chipOp = filterModel && !matched ? '0.25' : '1';
      const starBadge = matched && filterModel
        ? '<span title="Modelo destacado" style="margin-left:4px;color:var(--accent);font-size:11px">★</span>'
        : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;gap:6px;background:' + chipBg + ';border:1px solid ' + chipBd + ';border-radius:8px;padding:6px 10px;transition:background .15s,opacity .15s;opacity:' + chipOp + '" onmouseover="this.style.background=\'var(--bg4)\'" onmouseout="this.style.background=\'' + chipBg + '\'">'
        + '<div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1">'
          + '<span style="font-family:var(--mono);font-size:13px;font-weight:700;color:' + b.color + ';white-space:nowrap">' + selbCode + warnBadge + starBadge + '</span>'
          + '<div style="min-width:0;flex:1">'
            + (v.userName ? '<div style="font-size:10px;color:var(--muted);white-space:normal;word-break:break-word;line-height:1.25">' + v.userName + (v.movidoPor && v.movidoPor !== v.userName ? ' · mov. por ' + v.movidoPor : '') + '</div>' : '')
            + (modeloSelb ? '<div title="Modelo do equipamento" style="font-size:10px;font-weight:600;color:' + b.color + ';white-space:normal;word-break:break-word;line-height:1.25;opacity:.9;margin-top:2px">📦 ' + modeloSelb + '</div>' : '')
            + (timeAgo ? (function(){var _d=v.ts?Math.floor((Date.now()-v.ts)/86400000):0;var _fs=_d>=9?15:_d>=6?13:_d>=3?11:9;var _fw=_d>=9?800:_d>=6?700:_d>=3?600:400;var _col=_d>=9?'var(--danger)':_d>=6?'var(--warn)':_d>=3?'var(--text)':'var(--muted)';return '<div style="font-size:'+_fs+'px;font-weight:'+_fw+';color:'+_col+'">' + timeAgo + '</div>';})() : '')
          + '</div>'
        + '</div>'
        + adminRemoveBtn
      + '</div>';
    }).join('');

    const diasBadge = (count > 0 && maxDias > 0)
      ? '<span title="Maior tempo de permanencia no bolsao" style="font-size:9px;font-weight:700;background:' + b.bg + ';color:' + b.color + ';border:1px solid ' + b.border + ';border-radius:10px;padding:2px 7px;margin-left:6px;white-space:nowrap">⏱ ' + maxDias + (maxDias === 1 ? ' dia' : ' dias') + '</span>'
      : '';
    const matchBadge = (filterModel && bolsaoMatch > 0)
      ? '<span title="SELBs do modelo destacado neste bolsão" style="font-size:10px;font-weight:800;background:rgba(16,185,129,.18);color:var(--accent);border:1px solid rgba(16,185,129,.5);border-radius:10px;padding:2px 8px;margin-left:6px;white-space:nowrap;font-family:var(--mono)">★ ' + bolsaoMatch + '</span>'
      : '';
    // Realça a borda do card se houver matches neste bolsão
    const cardBorder = (filterModel && bolsaoMatch > 0) ? 'rgba(16,185,129,.7)' : b.border;
    const cardShadow = (filterModel && bolsaoMatch > 0) ? 'box-shadow:0 0 0 1px rgba(16,185,129,.35),0 0 18px rgba(16,185,129,.15);' : '';

    return '<div data-bolsao-card data-bolsao-key="' + b.key + '" draggable="true"' +
      ' ondragstart="_fluxolabDragStart(event,\'' + b.key + '\')"' +
      ' ondragend="_fluxolabDragEnd(event)"' +
      ' ondragover="_fluxolabDragOver(event,\'' + b.key + '\')"' +
      ' ondragleave="_fluxolabDragLeave(event)"' +
      ' ondrop="_fluxolabDrop(event,\'' + b.key + '\')"' +
      ' style="background:var(--bg2);border:1px solid ' + cardBorder + ';' + cardShadow + 'border-radius:16px;overflow:hidden;display:flex;flex-direction:column;transition:outline .12s,opacity .12s;">' +
      '<div style="background:' + b.bg + ';border-bottom:1px solid ' + b.border + ';padding:14px 16px;display:flex;align-items:center;justify-content:space-between;cursor:grab" onmousedown="this.style.cursor=\'grabbing\'" onmouseup="this.style.cursor=\'grab\'" title="Arraste para reordenar">' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;flex:1">' +
          '<span style="font-size:14px;color:' + b.color + ';opacity:.6;user-select:none" title="Arraste para reordenar">⋮⋮</span>' +
          '<span style="font-size:20px">' + b.icon + '</span>' +
          '<div style="min-width:0">' +
            '<div style="font-size:13px;font-weight:800;color:' + b.color + ';letter-spacing:.04em;text-transform:uppercase;display:flex;align-items:center;flex-wrap:wrap">' + b.label + diasBadge + matchBadge + '</div>' +
            '<div style="font-size:10px;color:var(--muted)">' + (count === 0 ? 'Vazio' : count + ' SELB' + (count !== 1 ? 's' : '')) + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:4px;flex-shrink:0">' +
          '<div style="background:' + b.bg + ';border:1px solid ' + b.border + ';border-radius:20px;min-width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-family:var(--mono);font-size:14px;font-weight:800;color:' + b.color + ';padding:0 8px;">' + count + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="padding:10px;display:flex;flex-direction:column;min-height:60px;max-height:480px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:' + b.border + ' transparent">' +
        (count === 0 ? '<div style="text-align:center;color:var(--muted);font-size:12px;padding:10px 0">Nenhum SELB</div>' : chips) +
      '</div>' +
    '</div>';
  }).join('');

  // Renderiza/atualiza a barra de filtro acima do grid
  _fluxolabRenderModelFilterBar(Array.from(allModelsSet), matchCountsByBolsao, totalMatches);

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'modelos') {
    fluxolabRenderModelos();
  }
}

function _fluxolabTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'agora';
  if (diff < 3600) return Math.floor(diff / 60) + 'min atras';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h' + String(Math.floor((diff % 3600) / 60)).padStart(2,'0') + 'min atras';
  const dias = Math.floor(diff / 86400);
  const horas = Math.floor((diff % 86400) / 3600);
  return dias + (dias === 1 ? ' dia' : ' dias') + (horas ? ' ' + horas + 'h' : '') + ' atras';
}

// Retorna o maior número de dias entre os SELBs presentes em um bolsão
function _fluxolabMaxDias(items){
  let max = 0;
  items.forEach(([,v]) => {
    if(!v || !v.ts) return;
    const d = Math.floor((Date.now() - v.ts) / 86400000);
    if(d > max) max = d;
  });
  return max;
}

async function fluxolabRegistrarSelb(selbCode, uid) {
  const u = users.find(x => x.id === uid);
  if (!u) return;
  const bolsao = FLUXOLAB_SECTOR_BOLSAO[u.sector];
  if (!bolsao) return;

  try {
    // Descobre bolsão atual antes de remover (para log)
    const bolsaoAnterior = _fmovGetBolsaoAtual ? _fmovGetBolsaoAtual(selbCode) : '—';
    await fluxolabRemoveSelbGlobal(selbCode);
    const selfKey = selbCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    const equipNome = (typeof getEquipName === 'function' ? getEquipName(selbCode) : '') || '';
    await dbSet('/fluxolab/' + bolsao + '/' + selfKey, {
      selb:        selbCode,
      uid:         uid,
      userName:    u.name,
      sector:      u.sector,
      equipamento: equipNome,
      ts:          Date.now(),
    });
    // Log: entrada no bolsão ao iniciar SELB
    _fluxolabLogEntry(selbCode, bolsaoAnterior || '—', bolsao, equipNome);
  } catch (e) {
    console.warn('[FluxoLAB] Erro ao registrar SELB:', e);
  }
}

async function fluxolabRemoveSelbGlobal(selbCode) {
  try {
    const snap = await dbGet('/fluxolab');
    if (!snap) return;
    const selfKey = selbCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    const delPromises = [];
    Object.keys(snap).forEach(bolsao => {
      const items = snap[bolsao];
      if (!items) return;
      if (items[selfKey]) {
        delPromises.push(dbDelete('/fluxolab/' + bolsao + '/' + selfKey));
      }
      Object.entries(items).forEach(([k, v]) => {
        if (v && v.selb && v.selb.trim().toUpperCase() === selbCode.trim().toUpperCase() && k !== selfKey) {
          delPromises.push(dbDelete('/fluxolab/' + bolsao + '/' + k));
        }
      });
    });
    await Promise.all(delPromises);
  } catch (e) {
    console.warn('[FluxoLAB] Erro ao remover SELB global:', e);
  }
}

async function fluxolabFinalizarSelb(selbCode, sector, res){
  try{
    // Reprovado: SELB permanece no último bolsão registrado (não move nem remove)
    if(res === 'rep'){
      const bolsaoAtualRep = _fmovGetBolsaoAtual ? _fmovGetBolsaoAtual(selbCode) : '';
      const equipNomeRep = (typeof getEquipName === 'function' ? getEquipName(selbCode) : '') || '';
      _fluxolabLogEntry(selbCode, bolsaoAtualRep || sector, bolsaoAtualRep || sector, equipNomeRep);
      return;
    }

    const dest = _fluxolabDestinoFinal(sector, res);
    // Descobre bolsão atual para log
    const bolsaoAtual = _fmovGetBolsaoAtual ? _fmovGetBolsaoAtual(selbCode) : '—';

    if(!dest){
      await fluxolabRemoveSelbGlobal(selbCode);
      _fluxolabLogEntry(selbCode, bolsaoAtual || sector, '—', '');
      return;
    }
    await fluxolabRemoveSelbGlobal(selbCode);
    const selfKey  = selbCode.replace(/[^a-zA-Z0-9_-]/g, '_');
    const equipNome= (typeof getEquipName === 'function' ? getEquipName(selbCode) : '') || '';
    await dbSet('/fluxolab/' + dest + '/' + selfKey, {
      selb:        selbCode,
      uid:         currentUser ? currentUser.id : '',
      userName:    currentUser ? currentUser.name : '',
      sector:      sector || '',
      equipamento: equipNome,
      ts:          Date.now(),
      origem:      sector || '',
      resultado:   res || '',
    });
    _fluxolabLogEntry(selbCode, bolsaoAtual || sector, dest, equipNome);
  }catch(e){ console.warn('[FluxoLAB] Erro ao finalizar:', e); }
}

// Conjunto de SELBs liberados (registro de qualidade ou liberação manual).
function _fluxolabGetLiberadosSet(){
  const liberados = new Set();
  Object.values(typeof _qualRegistros !== 'undefined' ? _qualRegistros : {}).forEach(r => {
    if(r && r.selb) liberados.add(String(r.selb).toUpperCase().trim());
  });
  Object.values(window._qualLiberadas || {}).forEach(r => {
    if(r && r.selb) liberados.add(String(r.selb).toUpperCase().trim());
  });
  return liberados;
}

// Corrige SELBs liberados que ficaram presos no Bolsão Qualidade.
let _fluxolabSyncRunning = false;
let _fluxolabSyncTimer = null;

async function _fluxolabSyncLiberados(){
  if(_fluxolabSyncRunning) return;
  const liberados = _fluxolabGetLiberadosSet();
  if(!liberados.size || !_fluxolabData) return;

  const qualItems = _fluxolabData.QUALIDADE || {};
  const stuck = [];
  Object.values(qualItems).forEach(v => {
    if(!v || !v.selb) return;
    const code = String(v.selb).toUpperCase().trim();
    if(liberados.has(code)) stuck.push(code);
  });
  if(!stuck.length) return;

  _fluxolabSyncRunning = true;
  try {
    for(const code of stuck){
      await fluxolabFinalizarSelb(code, 'QUALIDADE', 'ok');
    }
    if(typeof _fluxolabRenderGrid === 'function') _fluxolabRenderGrid();
  } catch(e){
    console.warn('[FluxoLAB] Erro ao sincronizar liberados:', e);
  } finally {
    _fluxolabSyncRunning = false;
  }
}

function _fluxolabScheduleSyncLiberados(){
  clearTimeout(_fluxolabSyncTimer);
  _fluxolabSyncTimer = setTimeout(() => _fluxolabSyncLiberados(), 800);
}

async function fluxolabRemoveItem(bolsao, selfKey) {
  if (!currentUser) return;
  try {
    await dbDelete('/fluxolab/' + bolsao + '/' + selfKey);
    if(typeof toast === 'function') toast('SELB removido do bolsao ' + bolsao.replace(/_/g,' '));
  } catch (e) {
    alert('Erro ao remover: ' + e.message);
  }
}

async function fluxolabAdminRemoveSelb() {
  if (!currentUser || !currentUser.isAdmin) return;
  const inp = document.getElementById('flab-admin-remove-selb');
  const code = inp ? inp.value.trim().toUpperCase() : '';
  if (!code) { alert('Informe o codigo SELB'); return; }
  const bolsaoAtual = _fmovGetBolsaoAtual ? _fmovGetBolsaoAtual(code) : '—';
  const equipNome = (typeof getEquipName === 'function' ? getEquipName(code) : '') || '';
  await fluxolabRemoveSelbGlobal(code);
  _fluxolabLogEntry(code, bolsaoAtual || '—', '— (removido admin)', equipNome);
  if (inp) inp.value = '';
  if(typeof toast === 'function') toast('SELB ' + code + ' removido de todos os bolsoes');
}

function fluxolabToggleAdminPanel() {
  const panel = document.getElementById('fluxolab-admin-panel');
  if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
}

// ════════════════════════════════════════════════════════
// RELATÓRIO DE QUALIDADE POR USUÁRIO
// ════════════════════════════════════════════════════════

function abrirRelatorioUsuariosQual() {
  // Navega para Relatórios > Liberados Qualidade
  if (typeof setView === 'function') {
    setView('relatorios', document.getElementById('tab-relatorios'));
  }
  setTimeout(() => {
    if (typeof setRelSubTab === 'function') setRelSubTab('qual-liberados');
  }, 120);
}

// ── Carrega reprovações baseado no período do relatório Liberados Qualidade ──
async function _loadQualReprovByPeriodo() {
  const periodo = document.getElementById('qual-rel-periodo')?.value || 'hoje';
  const hoje = new Date(); hoje.setHours(0,0,0,0);
  let from, to;
  const fmt = d => d.toISOString().slice(0,10);
  if (periodo === 'hoje') {
    from = to = fmt(hoje);
  } else if (periodo === 'semana') {
    const d = new Date(hoje); d.setDate(hoje.getDate()-6);
    from = fmt(d); to = fmt(hoje);
  } else if (periodo === 'mes') {
    const d = new Date(hoje); d.setDate(hoje.getDate()-29);
    from = fmt(d); to = fmt(hoje);
  } else if (periodo === 'tudo') {
    const d = new Date(hoje); d.setFullYear(hoje.getFullYear()-2);
    from = fmt(d); to = fmt(hoje);
  } else if (periodo === 'custom') {
    from = document.getElementById('qual-rel-de')?.value || fmt(hoje);
    to   = document.getElementById('qual-rel-ate')?.value || fmt(hoje);
  } else {
    from = to = fmt(hoje);
  }

  const todayDk = hoje.toDateString().replace(/ /g,'_');
  const dateKeys = typeof dateRangeKeys === 'function' ? dateRangeKeys(from, to) : [todayDk];
  let allRecs = [];
  const BATCH = 5;
  for (let i = 0; i < dateKeys.length; i += BATCH) {
    const batch = dateKeys.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async dk => {
      if (dk === todayDk) return (history || []);
      try { const d = await dbGet('/history/' + dk); return d ? Object.entries(d).map(([k,v]) => ({...v, _docId:k, _dateKey:dk})) : []; }
      catch(e) { return []; }
    }));
    results.forEach(r => allRecs = allRecs.concat(r));
  }
  window._qualReprovRecs = allRecs.filter(h => h.status === 'rep' && h._reprovadoPor);
  return window._qualReprovRecs;
}

function _qualRelFiltrarRegistros() {
  const periodo = (document.getElementById('qual-rel-periodo')?.value) || 'hoje';
  const allValues = Object.values(_qualRegistros || {});
  const hoje = new Date();
  hoje.setHours(0,0,0,0);

  return allValues.filter(r => {
    if (!r.ts) return false;
    const rDate = new Date(r.ts);
    rDate.setHours(0,0,0,0);

    if (periodo === 'hoje') {
      return rDate.getTime() === hoje.getTime();
    } else if (periodo === 'semana') {
      const limit = new Date(hoje); limit.setDate(hoje.getDate() - 6);
      return rDate >= limit;
    } else if (periodo === 'mes') {
      return rDate.getMonth() === hoje.getMonth() && rDate.getFullYear() === hoje.getFullYear();
    } else if (periodo === 'custom') {
      const deVal = document.getElementById('qual-rel-de')?.value;
      const ateVal = document.getElementById('qual-rel-ate')?.value;
      if (!deVal || !ateVal) return true;
      const de = new Date(deVal + 'T00:00:00');
      const ate = new Date(ateVal + 'T23:59:59');
      const ts = new Date(r.ts);
      return ts >= de && ts <= ate;
    }
    return true; // 'tudo'
  });
}

function renderRelatorioUsuariosQual() {
  const registros = _qualRelFiltrarRegistros();
  const tbody = document.getElementById('qual-rel-tbody');
  const totaisEl = document.getElementById('qual-rel-totais');
  const detalheEl = document.getElementById('qual-rel-detalhe');
  if (!tbody) return;

  // Agrupa por responsável
  const isAud = r => ((r.obs || '') + '').toUpperCase().includes('AUDITORIA');
  const porUsuario = {};
  registros.forEach(r => {
    const nome = r.responsavel || r.uid || 'Desconhecido';
    if (!porUsuario[nome]) {
      porUsuario[nome] = { nome, total: 0, etiquetas: 0, chamados: 0, auditoria: 0, reprovacoes: 0, registros: [] };
    }
    porUsuario[nome].total++;
    if (r.etiqueta_impressa) porUsuario[nome].etiquetas++;
    if (r.chamado_aberto) porUsuario[nome].chamados++;
    if (isAud(r)) porUsuario[nome].auditoria++;
    porUsuario[nome].registros.push(r);
  });

  // Conta reprovações por responsável no mesmo período filtrado
  const periodo = document.getElementById('qual-rel-periodo')?.value || 'hoje';
  const hoje0 = new Date(); hoje0.setHours(0,0,0,0);
  const _tsInPeriodo = ts => {
    if (!ts) return false;
    const d = new Date(ts); d.setHours(0,0,0,0);
    if (periodo === 'hoje') return d.getTime() === hoje0.getTime();
    if (periodo === 'semana') { const lim = new Date(hoje0); lim.setDate(hoje0.getDate()-6); return d >= lim; }
    if (periodo === 'mes') return d.getMonth()===hoje0.getMonth() && d.getFullYear()===hoje0.getFullYear();
    if (periodo === 'custom') {
      const deVal = document.getElementById('qual-rel-de')?.value;
      const ateVal = document.getElementById('qual-rel-ate')?.value;
      if (!deVal || !ateVal) return true;
      const ts2 = new Date(ts);
      return ts2 >= new Date(deVal+'T00:00:00') && ts2 <= new Date(ateVal+'T23:59:59');
    }
    return true;
  };
  // Usa _qualReprovRecs (carregado do Firebase para períodos históricos) ou history como fallback
  const reprovSrc = (window._qualReprovRecs && window._qualReprovRecs.length)
    ? window._qualReprovRecs
    : (history || []).filter(h => h.status === 'rep' && h._reprovadoPor);

  reprovSrc.forEach(h => {
    const nome = h._reprovadoPor || '';
    if (!nome) return;
    // _reprovadoEm é string de hora (ex: "17:16:44"), não timestamp — usa h.ts ou _dateKey
    const tsRef = h.ts || (h._dateKey ? new Date(h._dateKey.replace(/_/g,' ')).getTime() : null);
    if (!_tsInPeriodo(tsRef)) return;
    // Garante entrada mesmo se o reprovador não tiver liberações no período
    if (!porUsuario[nome]) {
      porUsuario[nome] = { nome, total: 0, etiquetas: 0, chamados: 0, auditoria: 0, reprovacoes: 0, registros: [] };
    }
    porUsuario[nome].reprovacoes++;
  });

  const lista = Object.values(porUsuario).sort((a, b) => b.total - a.total);
  const totalGeral = registros.length;
  const totalAuditoria = registros.filter(isAud).length;

  // Totalizador
  if (totaisEl) {
    const cores = [
      ['Total de Registros', totalGeral, '#a78bfa'],
      ['Usuários Ativos', lista.length, '#4f8ef7'],
      ['Etiquetas Impressas', registros.filter(r => r.etiqueta_impressa).length, '#4ade80'],
      ['Chamados Abertos', registros.filter(r => r.chamado_aberto).length, '#f5a623'],
      ['Auditoria', totalAuditoria, '#ec4899'],
    ];
    totaisEl.innerHTML = cores.map(([label, val, cor]) => `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:10px 16px;min-width:130px;flex:1">
        <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div>
        <div style="font-size:22px;font-weight:800;color:${cor};margin-top:2px">${val}</div>
      </div>`).join('');
  }

  if (!lista.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="padding:24px;text-align:center;color:var(--muted);font-size:13px">Nenhum registro encontrado para o período selecionado.</td></tr>`;
    if (detalheEl) detalheEl.innerHTML = '';
    return;
  }

  const maxTotal = lista[0].total;
  tbody.innerHTML = lista.map((u, idx) => {
    const pct = totalGeral > 0 ? ((u.total / totalGeral) * 100).toFixed(1) : '0.0';
    const barW = maxTotal > 0 ? Math.round((u.total / maxTotal) * 100) : 0;
    const rankColor = idx === 0 ? '#fbbf24' : idx === 1 ? '#94a3b8' : idx === 2 ? '#cd7f32' : '#a78bfa';
    const audCell = u.auditoria > 0
      ? `<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.4);border-radius:20px;padding:2px 10px;font-weight:800;font-size:12px">🔍 ${u.auditoria}</span>`
      : `<span style="color:var(--muted)">—</span>`;
    return `<tr style="border-bottom:1px solid var(--border2);transition:background .15s" 
                onmouseenter="this.style.background='rgba(167,139,250,0.07)'" 
                onmouseleave="this.style.background=''">
      <td style="padding:11px 14px;font-weight:700;color:${rankColor};font-size:13px">${idx + 1}°</td>
      <td style="padding:11px 14px">
        <div style="font-weight:600;color:var(--text);font-size:13px">${u.nome}</div>
      </td>
      <td style="padding:11px 14px;text-align:center;font-weight:800;color:#a78bfa;font-size:16px">${u.total}</td>
      <td style="padding:11px 14px;text-align:center;font-weight:700;color:${u.reprovacoes > 0 ? '#f87171' : 'var(--muted)'}">
        ${u.reprovacoes > 0 ? `<span style="background:rgba(242,87,87,0.18);color:#f87171;border:1px solid rgba(242,87,87,0.45);border-radius:20px;padding:2px 10px;font-weight:800;font-size:12px">✗ ${u.reprovacoes}</span>` : '—'}
      </td>
      <td style="padding:11px 14px;text-align:center;color:#4ade80;font-weight:600">${u.etiquetas}</td>
      <td style="padding:11px 14px;text-align:center;color:#f5a623;font-weight:600">${u.chamados}</td>
      <td style="padding:11px 14px;text-align:center">${audCell}</td>
      <td style="padding:11px 14px;text-align:center;color:var(--muted);font-size:12px">${pct}%</td>
      <td style="padding:11px 14px">
        <div style="background:rgba(255,255,255,.07);border-radius:20px;height:8px;min-width:80px;overflow:hidden">
          <div style="background:linear-gradient(90deg,#a78bfa,#7c3aed);height:100%;width:${barW}%;border-radius:20px;transition:width .4s"></div>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Detalhe expansível por usuário (últimos 5 registros)
  if (detalheEl) {
    detalheEl.innerHTML = `
      <details style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:14px 16px">
        <summary style="font-size:12px;font-weight:700;color:var(--muted);cursor:pointer;user-select:none;text-transform:uppercase;letter-spacing:.06em">
          🔍 Ver detalhes por usuário (últimos registros)
        </summary>
        <div style="margin-top:14px;display:flex;flex-direction:column;gap:14px">
          ${lista.map(u => {
            const ultimos = [...u.registros].sort((a,b) => (b.ts||0)-(a.ts||0)).slice(0, 5);
            const audBadge = u.auditoria > 0
              ? `<span style="margin-left:8px;background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.4);border-radius:20px;padding:1px 8px;font-size:10px;font-weight:700">🔍 ${u.auditoria} AUDITORIA</span>`
              : '';
            return `<div>
              <div style="font-size:12px;font-weight:700;color:#a78bfa;margin-bottom:6px">${u.nome} — ${u.total} registro(s)${audBadge}</div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:11px">
                  <thead><tr style="background:var(--bg2)">
                    <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600">Data</th>
                    <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600">SELB</th>
                    <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600">Equipamento</th>
                    <th style="padding:6px 10px;text-align:left;color:var(--muted);font-weight:600">Obs.</th>
                    <th style="padding:6px 10px;text-align:right;color:var(--muted);font-weight:600">Cont. PB</th>
                    <th style="padding:6px 10px;text-align:center;color:var(--muted);font-weight:600">Etiqueta</th>
                  </tr></thead>
                  <tbody>
                    ${ultimos.map(r => {
                      const aud = isAud(r);
                      const rowStyle = aud
                        ? 'border-top:1px solid var(--border2);background:rgba(236,72,153,0.08);border-left:3px solid #ec4899'
                        : 'border-top:1px solid var(--border2)';
                      const obsCell = aud
                        ? `<span style="background:rgba(236,72,153,0.15);color:#ec4899;border:1px solid rgba(236,72,153,0.4);border-radius:20px;padding:1px 8px;font-weight:700;font-size:10px">🔍 ${r.obs || 'AUDITORIA'}</span>`
                        : `<span style="color:var(--muted)">${r.obs || '—'}</span>`;
                      return `<tr style="${rowStyle}">
                      <td style="padding:6px 10px;color:var(--muted)">${r.data||'—'} ${r.hora||''}</td>
                      <td style="padding:6px 10px;font-family:var(--mono);font-weight:700;color:var(--accent)">${r.selb||'—'}</td>
                      <td style="padding:6px 10px;color:var(--text);max-width:180px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.equipamento||'—'}</td>
                      <td style="padding:6px 10px;max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${obsCell}</td>
                      <td style="padding:6px 10px;text-align:right;font-family:var(--mono)">${Number(r.contador_pb??r.contador??0).toLocaleString('pt-BR')}</td>
                      <td style="padding:6px 10px;text-align:center">${r.etiqueta_impressa ? '<span style="color:#4ade80;font-weight:700">✓</span>' : '<span style="color:var(--muted)">—</span>'}</td>
                    </tr>`;
                    }).join('')}
                    ${u.total > 5 ? `<tr><td colspan="6" style="padding:6px 10px;color:var(--muted);font-style:italic;text-align:center">... e mais ${u.total - 5} registro(s)</td></tr>` : ''}
                  </tbody>
                </table>
              </div>
            </div>`;
          }).join('')}
        </div>
      </details>`;
  }
}

function exportarRelatorioUsuariosQual() {
  const registros = _qualRelFiltrarRegistros();
  const periodo = document.getElementById('qual-rel-periodo')?.value || 'hoje';

  const isAud = r => ((r.obs || '') + '').toUpperCase().includes('AUDITORIA');
  const porUsuario = {};
  registros.forEach(r => {
    const nome = r.responsavel || r.uid || 'Desconhecido';
    if (!porUsuario[nome]) porUsuario[nome] = { nome, total: 0, etiquetas: 0, chamados: 0, auditoria: 0 };
    porUsuario[nome].total++;
    if (r.etiqueta_impressa) porUsuario[nome].etiquetas++;
    if (r.chamado_aberto) porUsuario[nome].chamados++;
    if (isAud(r)) porUsuario[nome].auditoria++;
  });

  const lista = Object.values(porUsuario).sort((a, b) => b.total - a.total);
  const totalGeral = registros.length;

  const linhas = [
    ['#', 'Responsável', 'Registros', 'Reprovações', 'Etiquetas Impressas', 'Chamados Abertos', 'Auditoria', '% do Total'],
    ...lista.map((u, i) => [
      i + 1,
      u.nome,
      u.total,
      u.reprovacoes,
      u.etiquetas,
      u.chamados,
      u.auditoria,
      totalGeral > 0 ? ((u.total / totalGeral) * 100).toFixed(1) + '%' : '0.0%'
    ])
  ];

  const csv = linhas.map(row => row.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `relatorio_qualidade_por_usuario_${periodo}_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ════════════════════════════════════════════════════
//  FluxoLAB — Abas (Bolsões / Agrupamento por Modelo)
// ════════════════════════════════════════════════════

let _fluxolabActiveTab = 'bolsoes';

function fluxolabSwitchTab(tab) {
  _fluxolabActiveTab = tab;

  const bolsoesLayout   = document.getElementById('fluxolab-bolsoes-layout');
  const modelosPanel    = document.getElementById('fluxolab-tab-modelos-panel');
  const checklistsPanel = document.getElementById('fluxolab-tab-checklists-panel');
  const caindoPanel     = document.getElementById('fluxolab-tab-caindo-panel');
  const btnBolsoes      = document.getElementById('fluxolab-tab-bolsoes');
  const btnModelos      = document.getElementById('fluxolab-tab-modelos');
  const btnChecklists   = document.getElementById('fluxolab-tab-checklists');
  const btnCaindo       = document.getElementById('fluxolab-tab-caindo');

  const setBtn = (btn, active) => {
    if (!btn) return;
    btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    btn.style.color = active ? 'var(--text)' : 'var(--muted)';
  };

  if (bolsoesLayout)   bolsoesLayout.classList.toggle('hide', tab !== 'bolsoes');
  if (modelosPanel)    modelosPanel.style.display    = tab === 'modelos'    ? '' : 'none';
  if (checklistsPanel) checklistsPanel.style.display = tab === 'checklists' ? '' : 'none';
  if (caindoPanel)     caindoPanel.style.display     = tab === 'caindo'     ? '' : 'none';

  setBtn(btnBolsoes,    tab === 'bolsoes');
  setBtn(btnModelos,    tab === 'modelos');
  setBtn(btnChecklists, tab === 'checklists');
  setBtn(btnCaindo,     tab === 'caindo');

  if (tab === 'modelos')    fluxolabRenderModelos();
  if (tab === 'checklists') fluxolabRenderChecklistsImported();
  if (tab === 'caindo')     fluxolabRenderCaindoHoje();
}

function fluxolabRenderModelos() {
  const grid = document.getElementById('fluxolab-modelos-grid');
  if (!grid) return;

  const searchEl = document.getElementById('fluxolab-modelo-search');
  const filter = searchEl ? searchEl.value.trim().toLowerCase() : '';

  // Índice de checklists importados (modelo normalizado -> count)
  const checklistIdx = _fluxolabBuildChecklistIndex();

  // ── Índice detalhado dos checklists importados por modelo (mesmas infos da aba "Checklists Importados") ──
  const _escDet = s => String(s==null?'':s).replace(/[&<>"']/g,
    c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const checklistDetalhes = new Map(); // normKey -> { rows:[], keys:{...} }
  if (Array.isArray(_fluxolabChecklistsImported) && _fluxolabChecklistsImported.length) {
    const sample = _fluxolabChecklistsImported[0];
    const dKeys = {
      modelo:    _fluxolabFindKey(sample,'Descrição Equipamento') || _fluxolabFindKey(sample,'Descricao Equipamento'),
      pedido:    _fluxolabFindKey(sample,'Pedido'),
      cliente:   _fluxolabFindKey(sample,'Razão Social') || _fluxolabFindKey(sample,'Cliente'),
      customer:  _fluxolabFindKey(sample,'Customer') || _fluxolabFindKey(sample,'Contato') || _fluxolabFindKey(sample,'Nome Contato'),
      telefone:  _fluxolabFindKey(sample,'Telefone') || _fluxolabFindKey(sample,'Tel') || _fluxolabFindKey(sample,'Fone') || _fluxolabFindKey(sample,'Celular'),
      tipo:      _fluxolabFindKey(sample,'Tipo'),
      andamento: _fluxolabFindKey(sample,'Andamento'),
      diasUteis: _fluxolabFindKey(sample,'Dias Úteis Andamento') || _fluxolabFindKey(sample,'Dias Uteis Andamento') || _fluxolabFindKey(sample,'Dias Úteis') || _fluxolabFindKey(sample,'Dias Uteis'),
      diasAb:    _fluxolabFindKey(sample,'Dias Aberto'),
      status:    _fluxolabFindKey(sample,'Status Checklist') || _fluxolabFindKey(sample,'Status'),
      obs:       _fluxolabFindKey(sample,'Observação') || _fluxolabFindKey(sample,'Observacao') || _fluxolabFindKey(sample,'OBS') || _fluxolabFindKey(sample,'Obs'),
    };
    if (dKeys.modelo) {
      for (const r of _fluxolabChecklistsImported) {
        const nk = _fluxolabNormModel(r[dKeys.modelo]);
        if (!nk) continue;
        if (!checklistDetalhes.has(nk)) checklistDetalhes.set(nk, { rows: [], keys: dKeys });
        checklistDetalhes.get(nk).rows.push(r);
      }
    }
  }

  function _renderDetalhesPedidos(normKey) {
    const info = checklistDetalhes.get(normKey);
    if (!info || !info.rows.length) {
      return `<div style="padding:14px 18px;color:var(--muted);font-size:12px">Nenhum checklist importado encontrado para este modelo.</div>`;
    }
    const k = info.keys;
    const headers = [
      ['Pedido',     k.pedido],
      ['Cliente',    k.cliente],
      ['Customer · Tel', k.customer || k.telefone],
      ['Tipo',       k.tipo],
      ['Dias Úteis', k.diasUteis || k.diasAb],
      ['Status',     k.status],
      ['Obs',        k.obs],
    ];
    const ths = headers.map(([h]) =>
      `<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--border2);white-space:nowrap">${h}</th>`
    ).join('');
    const trs = info.rows.map(r => {
      const tds = headers.map(([, key]) => {
        let val = '—';
        if (key === k.customer || key === k.telefone || key === (k.customer || k.telefone)) {
          const nome = k.customer ? r[k.customer] : '';
          const tel  = k.telefone ? r[k.telefone] : '';
          val = [nome, tel].filter(Boolean).map(_escDet).join('<br><span style="color:var(--muted);font-size:11px">') + (tel?'</span>':'');
          if (!nome && !tel) val = '—';
        } else if (key && r[key] != null && String(r[key]).trim() !== '') {
          val = _escDet(r[key]);
        }
        return `<td style="padding:7px 12px;font-size:12px;color:var(--text);border-bottom:1px solid var(--border);vertical-align:top">${val}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<div style="background:var(--bg1);overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:760px">
        <thead><tr style="background:var(--bg3)">${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`;
  }

  // Agrupar todos os SELBs por modelo (equipamento) + bolsão
  // modelo -> { total, bolsoes: { key: [{ selb, ts }] } }
  const grupos = {};

  FLUXOLAB_BOLSOES.forEach(b => {
    const items = _fluxolabData[b.key] ? Object.entries(_fluxolabData[b.key]) : [];
    items.forEach(([k, v]) => {
      const _eqStored = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : '';
      const modelo = _eqStored
        || (typeof getEquipName === 'function' ? (getEquipName(v.selb || k) || '') : '')
        || 'DESCONHECIDO';

      if (!grupos[modelo]) grupos[modelo] = { total: 0, bolsoes: {}, maxDias: 0, somaDias: 0, countDias: 0 };
      // Total operacional = apenas bolsões ativos. Exclui SCRAP, DOCA_1 e Gaiola Ag. peças.
      if (b.key !== 'SCRAP' && b.key !== 'DOCA_1' && b.key !== 'GAIOLA_AG_PECAS') grupos[modelo].total++;
      if (!grupos[modelo].bolsoes[b.key]) grupos[modelo].bolsoes[b.key] = { count: 0, maxTs: 0 };
      grupos[modelo].bolsoes[b.key].count++;
      if (v.ts && v.ts < (grupos[modelo].bolsoes[b.key].maxTs || Infinity || v.ts)) {
        // guarda o ts mais antigo (maior dias parado)
        if (!grupos[modelo].bolsoes[b.key].maxTs || v.ts < grupos[modelo].bolsoes[b.key].maxTs) {
          grupos[modelo].bolsoes[b.key].maxTs = v.ts;
        }
      }
      // dias parado global = item mais antigo do modelo
      const dias = v.ts ? Math.floor((Date.now() - v.ts) / 86400000) : 0;
      if (dias > grupos[modelo].maxDias) grupos[modelo].maxDias = dias;
      if (b.key !== 'SCRAP' && b.key !== 'DOCA_1' && b.key !== 'GAIOLA_AG_PECAS' && v.ts) {
        grupos[modelo].somaDias  += dias;
        grupos[modelo].countDias += 1;
      }
    });
  });

  // Ler filtro de ordenação/dias ativo
  const sortFilterEl = document.getElementById('fluxolab-modelo-sort');
  const sortFilter = sortFilterEl ? sortFilterEl.value : 'total';

  // Pré-calcular métricas de dias úteis a partir dos checklists importados
  Object.entries(grupos).forEach(([modelo, g]) => {
    g.mediaDias = g.countDias > 0 ? Math.round(g.somaDias / g.countDias) : 0; // fallback dias corridos
    const normKey = _fluxolabNormModel(modelo);
    const det = checklistDetalhes.get(normKey);
    if (det && det.rows.length) {
      const k = det.keys;
      const duKey = k.diasUteis || k.diasAb;
      if (duKey) {
        const vals = det.rows
          .map(r => parseFloat(r[duKey]))
          .filter(v => !isNaN(v) && v > 0); // ignora 0 e negativos (linhas sem data)
        if (vals.length) {
          g.maxDiasUteis    = Math.max(...vals);
          g.mediaDiasUteis  = calcAverage(vals, null, 1);
        }
      }
    }
    if (g.maxDiasUteis  === undefined) g.maxDiasUteis   = g.maxDias;
    if (g.mediaDiasUteis === undefined) g.mediaDiasUteis = g.mediaDias;
  });

  // ── Adiciona modelos presentes na planilha mas sem SELB no LAB ──
  // Garante que todos os modelos importados apareçam na tabela, mesmo sem equipamentos físicos.
  if (Array.isArray(_fluxolabChecklistsImported) && _fluxolabChecklistsImported.length) {
    const sample = _fluxolabChecklistsImported[0];
    const modelKey = _fluxolabFindKey(sample, 'Descrição Equipamento') || _fluxolabFindKey(sample, 'Descricao Equipamento');
    if (modelKey) {
      // Monta mapa normKey -> nomeOriginal do Firebase (para lookup reverso)
      const gruposNormMap = new Map(); // normKey -> nomeModelo em grupos
      Object.keys(grupos).forEach(m => gruposNormMap.set(_fluxolabNormModel(m), m));

      // Coleta nomes originais únicos da planilha
      const seenNorm = new Set();
      for (const r of _fluxolabChecklistsImported) {
        const nome = String(r[modelKey] || '').trim();
        if (!nome) continue;
        const norm = _fluxolabNormModel(nome);
        if (seenNorm.has(norm)) continue;
        seenNorm.add(norm);
        // Só adiciona se ainda não está em grupos (via match normalizado)
        if (!gruposNormMap.has(norm)) {
          grupos[nome] = { total: 0, bolsoes: {}, maxDias: 0, somaDias: 0, countDias: 0,
                           mediaDias: 0, maxDiasUteis: 0, mediaDiasUteis: 0 };
        }
      }
    }
  }

  // Filtrar por texto + filtro de dias úteis
  let entradas = Object.entries(grupos)
    .filter(([modelo, d]) => {
      // Exibe apenas modelos que têm checklist importado na planilha
      if ((checklistIdx.get(_fluxolabNormModel(modelo)) || 0) === 0) return false;
      if (filter && !modelo.toLowerCase().includes(filter)) return false;
      if (sortFilter === 'acima4')  return d.maxDiasUteis >= 4;
      if (sortFilter === 'acima10') return d.maxDiasUteis >= 10;
      if (sortFilter === 'acima20') return d.maxDiasUteis >= 20;
      if (sortFilter === 'puxar') {
        const cl = checklistIdx.get(_fluxolabNormModel(modelo)) || 0;
        const falt = cl > 0 ? Math.max(0, cl - d.total) : 0;
        const docaQ = (d.bolsoes['DOCA_1'] && d.bolsoes['DOCA_1'].count) || 0;
        return falt > 0 && docaQ > 0; // tem SELBs faltando E tem estoque na Doca 1 para puxar
      }
      if (sortFilter === 'urgencia') {
        // Exibe apenas modelos que têm ao menos um pedido com status "Urgência Laboratório"
        const det = checklistDetalhes.get(_fluxolabNormModel(modelo));
        if (!det || !det.rows.length) return false;
        const sk = det.keys.status;
        if (!sk) return false;
        return det.rows.some(r => {
          const s = String(r[sk] || '').toLowerCase();
          return s.includes('urg') && s.includes('lab');
        });
      }
      return true;
    })
    .sort((a, b) => {
      if (sortFilter === 'mediaDias') return b[1].mediaDiasUteis - a[1].mediaDiasUteis;
      if (sortFilter === 'maxDias')   return b[1].maxDiasUteis   - a[1].maxDiasUteis;
      if (sortFilter === 'urgencia')  {
        const clA = checklistIdx.get(_fluxolabNormModel(a[0])) || 0;
        const clB = checklistIdx.get(_fluxolabNormModel(b[0])) || 0;
        const fA = clA > 0 ? Math.max(0, clA - a[1].total) : 0;
        const fB = clB > 0 ? Math.max(0, clB - b[1].total) : 0;
        if (fA !== fB) return fB - fA;
        return b[1].maxDiasUteis - a[1].maxDiasUteis;
      }
      if (sortFilter === 'puxar') {
        const clA = checklistIdx.get(_fluxolabNormModel(a[0])) || 0;
        const clB = checklistIdx.get(_fluxolabNormModel(b[0])) || 0;
        const fA = clA > 0 ? Math.max(0, clA - a[1].total) : 0;
        const fB = clB > 0 ? Math.max(0, clB - b[1].total) : 0;
        return fB - fA;
      }
      if (sortFilter === 'acima4' || sortFilter === 'acima10' || sortFilter === 'acima20') return b[1].maxDiasUteis - a[1].maxDiasUteis;
      return b[1].total - a[1].total;
    });

  if (entradas.length === 0) {
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted);font-size:13px">Nenhum modelo encontrado. Verifique o filtro ou se a planilha possui a coluna "Descrição Equipamento".</div>';
    return;
  }

  // Descobrir quais bolsões têm ao menos 1 item (para montar colunas dinâmicas)
  const bolsoesAtivos = FLUXOLAB_BOLSOES.filter(b =>
    entradas.some(([, d]) => d.bolsoes[b.key] && d.bolsoes[b.key].count > 0)
  );

  // Helper: badge "PARADO Xd"
  function paradoBadge(ts) {
    if (!ts) return '';
    const dias = Math.floor((Date.now() - ts) / 86400000);
    if (dias < 3) return '';
    const cor = dias >= 20 ? 'rgba(242,87,87,1)' : dias >= 7 ? '#f5a623' : 'var(--muted)';
    const bg  = dias >= 20 ? 'rgba(242,87,87,.15)' : dias >= 7 ? 'rgba(245,166,35,.12)' : 'var(--bg4)';
    const bd  = dias >= 20 ? 'rgba(242,87,87,.4)'  : dias >= 7 ? 'rgba(245,166,35,.35)' : 'var(--border)';
    return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;background:${bg};color:${cor};border:1px solid ${bd};border-radius:6px;padding:1px 6px;white-space:nowrap">▲ PARADO ${dias}d</span>`;
  }

  // Monta tabela
  const colHeaders = bolsoesAtivos.map(b =>
    `<th style="padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);white-space:nowrap;text-align:center;border-bottom:2px solid var(--border2);background:var(--bg3)">${b.icon} ${b.label}</th>`
  ).join('');

  const rows = entradas.map(([modelo, dados], idx) => {
    const clTotal = checklistIdx.get(_fluxolabNormModel(modelo)) || 0;
    // Total de SELBs do modelo (soma de todos os bolsões, incluindo SCRAP) para base proporcional
    const selbTotal = Object.values(dados.bolsoes).reduce((s, b) => s + (b.count || 0), 0);
    // SELBs na Doca 1 para este modelo
    const docaCount = (dados.bolsoes['DOCA_1'] && dados.bolsoes['DOCA_1'].count) || 0;
    // labTotal = dados.total (já exclui SCRAP e DOCA_1 — ver linha de agrupamento)
    const labTotal = dados.total;

    const faltCalc = clTotal > 0 ? Math.max(0, clTotal - labTotal) : 0;

    const cols = (() => {
      return bolsoesAtivos.map(b => {
        const info = dados.bolsoes[b.key];
        const count = (info && info.count) || 0;

        // Coluna Doca 1: mostrar "📦 X → puxar Y" ou "⛔ Puxar estoque"
        if (b.key === 'DOCA_1') {
          if (count > 0) {
            const puxar = Math.min(count, faltCalc);
            const txt = puxar > 0
              ? `<span style="font-size:12px;font-weight:800;color:#f59e0b;font-family:var(--mono);white-space:nowrap">📦 ${count} → puxar ${puxar}</span>`
              : `<span style="font-size:14px;font-weight:900;color:#22d3ee;font-family:var(--mono);white-space:nowrap">📦 ${count}</span>`;
            return `<td style="padding:9px 14px;text-align:center;border-bottom:1px solid var(--border)">
              <div style="display:inline-flex;flex-direction:column;align-items:center;gap:3px">
                ${txt}
                ${paradoBadge(info.maxTs)}
              </div>
            </td>`;
          }
          if (faltCalc > 0) {
            return `<td style="padding:9px 14px;text-align:center;border-bottom:1px solid var(--border)">
              <span title="Sem estoque no Lab nem na Doca 1 — faltam ${faltCalc} SELB(s)" style="display:inline-flex;align-items:center;gap:5px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);border-radius:8px;padding:3px 8px;font-size:10px;font-weight:800;color:#ef4444;white-space:nowrap">⛔ Puxar estoque <span style="font-family:var(--mono);font-size:12px;font-weight:900">${faltCalc}</span></span>
            </td>`;
          }
          return `<td style="padding:9px 14px;text-align:center;color:var(--muted);font-size:12px;border-bottom:1px solid var(--border)">—</td>`;
        }

        if (!info || info.count === 0) {
          return `<td style="padding:9px 14px;text-align:center;color:var(--muted);font-size:12px;border-bottom:1px solid var(--border)">—</td>`;
        }
        const clBadge = clTotal > 0
          ? `<span title="Checklists: ${info.count} SELB(s) deste modelo aqui" style="font-size:10px;font-weight:700;color:#f59e0b;font-family:var(--mono)">📋${info.count}</span>`
          : '';
        return `<td style="padding:9px 14px;text-align:center;border-bottom:1px solid var(--border)">
        <div style="display:inline-flex;flex-direction:column;align-items:center;gap:3px">
          <span style="font-size:18px;font-weight:900;color:var(--text);font-family:var(--mono);line-height:1">${info.count}</span>
          ${paradoBadge(info.maxTs)}
          ${clBadge}
        </div>
      </td>`;
      }).join('');
    })();

    const rowBg = idx % 2 === 0 ? 'var(--bg2)' : 'var(--bg3)';
    const maxDias = dados.maxDias;
    const totalColor = maxDias >= 20 ? 'var(--danger)' : maxDias >= 7 ? '#f5a623' : 'var(--accent)';

    const clCell = clTotal > 0
      ? `<td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border)">
           <span style="font-size:20px;font-weight:900;color:#f59e0b;font-family:var(--mono)">${clTotal}</span>
         </td>`
      : `<td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px">—</td>`;

    // Faltantes = checklists - SELBs nos bolsões de lab (exclui SCRAP e DOCA_1)
    const faltantes = clTotal > 0 ? Math.max(0, clTotal - labTotal) : 0;

    const _duMax = dados.maxDiasUteis || 0;
    const _duMed = dados.mediaDiasUteis || 0;
    const _duShowMed = (sortFilter === 'mediaDias');
    const _du = _duShowMed ? _duMed : _duMax;
    const _duColor = _du >= 20 ? '#ef4444' : _du >= 10 ? '#f59e0b' : _du >= 4 ? '#facc15' : 'var(--muted)';
    const _duLabel = _duShowMed ? `méd ${_du}d` : `${_du}d úteis`;
    const diasBadge = _du > 0
      ? `<span title="máx ${_duMax}d · méd ${_duMed}d úteis" style="font-size:10px;font-weight:700;color:${_duColor};font-family:var(--mono);white-space:nowrap">${_duLabel}</span>`
      : '';

    const faltantesCell = faltantes > 0
      ? `<td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border)">
           <div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px">
             <span title="Precisam entrar mais ${faltantes} SELB(s) nos bolsões para usar todos os checklists" style="font-size:20px;font-weight:900;color:#ef4444;font-family:var(--mono);line-height:1">${faltantes}</span>
             ${diasBadge}
           </div>
         </td>`
      : (clTotal > 0
          ? `<td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border)">
               <div style="display:inline-flex;flex-direction:column;align-items:center;gap:2px">
                 <span style="color:var(--accent2);font-size:13px;font-weight:700">✓</span>
                 ${diasBadge}
               </div>
             </td>`
          : `<td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border);color:var(--muted);font-size:12px">—</td>`);

    const detId = 'fxmod-det-' + idx;
    const normKey = _fluxolabNormModel(modelo);
    const totalCols = 4 + bolsoesAtivos.length; // Modelo + Total + Checklists + Faltantes + bolsões
    const detalhesHtml = _renderDetalhesPedidos(normKey);
    const hasDet = clTotal > 0;

    const mainRow = `<tr style="background:${rowBg};transition:background .12s;cursor:${hasDet?'pointer':'default'}"
      ${hasDet ? `onclick="(function(el,id){var t=document.getElementById(id);var open=t.style.display!=='none';t.style.display=open?'none':'';var a=el.querySelector('.fxmod-arr');if(a)a.style.transform=open?'':'rotate(180deg)';})(this,'${detId}')"` : ''}
      onmouseover="this.style.background='var(--bg4)'" onmouseout="this.style.background='${rowBg}'">
      <td style="padding:10px 16px;border-bottom:1px solid var(--border);min-width:220px;max-width:340px">
        <div style="display:flex;align-items:center;gap:10px">
          ${hasDet ? `<span class="fxmod-arr" style="color:var(--muted);font-size:12px;transition:transform .2s;flex-shrink:0">▾</span>` : `<span style="width:12px;flex-shrink:0"></span>`}
          <div style="font-size:13px;font-weight:600;color:var(--text);line-height:1.3;word-break:break-word">${modelo}</div>
        </div>
      </td>
      <td style="padding:10px 14px;text-align:center;border-bottom:1px solid var(--border)">
        <span style="font-size:20px;font-weight:900;color:${totalColor};font-family:var(--mono)">${dados.total}</span>
      </td>
      ${clCell}
      ${faltantesCell}
      ${cols}
    </tr>`;

    const detRow = hasDet
      ? `<tr id="${detId}" style="display:none;background:var(--bg1)">
           <td colspan="${totalCols}" style="padding:0;border-bottom:1px solid var(--border2)">${detalhesHtml}</td>
         </tr>`
      : '';

    return mainRow + detRow;
  }).join('');

  // ── Painel de resumo: modelos com faltantes e/ou doca disponível ──
  const alertas = entradas
    .map(([modelo, dados]) => {
      const clTotal  = checklistIdx.get(_fluxolabNormModel(modelo)) || 0;
      if (!clTotal) return null;
      const labTot   = dados.total;
      const docaTot  = (dados.bolsoes['DOCA_1'] && dados.bolsoes['DOCA_1'].count) || 0;
      const falt     = Math.max(0, clTotal - labTot);
      if (!falt && !docaTot) return null; // sem interesse
      const du = dados.maxDiasUteis || 0;
      return { modelo, clTotal, labTot, docaTot, falt, du };
    })
    .filter(Boolean);

  // ── Cards de resumo global ──
  const _sumTotalCL  = Array.from(checklistIdx.values()).reduce((s, v) => s + v, 0);
  const _sumTotalLAB = entradas.reduce((s, [, d]) => s + d.total, 0);
  const _sumFaltantes = Math.max(0, _sumTotalCL - _sumTotalLAB);
  const _sumModelos  = entradas.length;

  function _sumCard(label, val, color, icon) {
    return `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:10px 18px;display:flex;flex-direction:column;align-items:center;min-width:110px;gap:2px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);white-space:nowrap">${icon} ${label}</div>
      <div style="font-size:26px;font-weight:900;color:${color};font-family:var(--mono);line-height:1.1">${val}</div>
    </div>`;
  }

  grid.innerHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px;align-items:stretch">
      ${_sumCard('Modelos',   _sumModelos,  'var(--text)',  '📦')}
      ${_sumCard('Checklists', _sumTotalCL, '#f59e0b',      '📋')}
      ${_sumCard('No LAB',    _sumTotalLAB, '#22d3ee',      '🔬')}
      ${_sumCard('Faltantes', _sumFaltantes, _sumFaltantes > 0 ? '#ef4444' : '#22c55e', '⚠')}
    </div>

    <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:16px;overflow:hidden">
      <div style="overflow-x:auto;max-height:calc(100vh - 320px);overflow-y:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead style="position:sticky;top:0;z-index:3">
          <tr>
            <th style="padding:10px 16px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;border-bottom:2px solid var(--border2);background:var(--bg3)">Modelo</th>
            <th style="padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--text);text-align:center;border-bottom:2px solid var(--border2);background:var(--bg3)">Total</th>
            <th style="padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#f59e0b;text-align:center;border-bottom:2px solid var(--border2);background:var(--bg3);white-space:nowrap">📋 Checklists</th>
            <th style="padding:10px 14px;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:#ef4444;text-align:center;border-bottom:2px solid var(--border2);background:var(--bg3);white-space:nowrap">⚠ Faltantes</th>
            ${colHeaders}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>
    </div>`;
}


// ════════════════════════════════════════
// FLUXOLAB — Importação de Checklists (XLSX)
// Agrupa checklists por "Descrição Equipamento"
// Persistência via Firebase (mesmo padrão de importEquipFile)
// ════════════════════════════════════════
let _fluxolabChecklistsImported = []; // [{ ...rowFromXlsx }]

// Cada linha é salva como string JSON para evitar que nomes de colunas com caracteres
// proibidos pelo Firebase (. # $ / [ ]) se tornem chaves aninhadas.
let _fluxolabChecklistsListener = null;
function fluxolabStartChecklistsListener(){
  if (_fluxolabChecklistsListener) return;
  _fluxolabChecklistsListener = _db.ref('/fluxolab_checklists').on('value', function(snap){
    if (!snap.exists()){ _fluxolabChecklistsImported = []; }
    else {
      const val = snap.val();
      try {
        _fluxolabChecklistsImported = Object.values(val).map(s => JSON.parse(s));
      } catch(e) {
        _fluxolabChecklistsImported = [];
        console.warn('[FluxoLAB] erro ao parsear checklists do Firebase', e);
      }
    }
    fluxolabRenderChecklistsImported();
    // Atualiza badge e painel "Caindo Hoje" se estiver ativo
    _fluxolabAtualizarBadgeCaindo();
    if (_fluxolabActiveTab === 'caindo') fluxolabRenderCaindoHoje();
  });
}

function _fluxolabAtualizarBadgeCaindo() {
  const badge = document.getElementById('fluxolab-caindo-badge');
  if (!badge) return;
  const rows = _fluxolabChecklistsImported;
  if (!rows || !rows.length) { badge.style.display = 'none'; return; }
  const sample  = rows[0];
  const kDias   = _fluxolabFindKey(sample, 'Dias Úteis Andamento') || _fluxolabFindKey(sample, 'Dias Uteis Andamento') || _fluxolabFindKey(sample, 'Dias Úteis') || _fluxolabFindKey(sample, 'Dias Uteis') || _fluxolabFindKey(sample, 'Dias Aberto');
  if (!kDias) { badge.style.display = 'none'; return; }
  const count = rows.filter(r => {
    const v = parseFloat(String(r[kDias] || '').replace(',', '.'));
    return !isNaN(v) && v <= 0;
  }).length;
  if (count > 0) {
    badge.textContent  = count;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

async function fluxolabImportChecklists(ev){
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (typeof XLSX === 'undefined') { alert('Biblioteca XLSX não carregada.'); return; }

  showLoader('Importando checklists...');
  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!rows.length) { hideLoader(); alert('Planilha vazia.'); return; }

    // Salva no Firebase: cada linha como string JSON (evita chaves com / # $ . [ ])
    await dbDelete('/fluxolab_checklists');
    const batch = {};
    rows.forEach((r, i) => { batch[String(i)] = JSON.stringify(r); });
    await dbPatch('/fluxolab_checklists', batch);

    hideLoader();
    alert('✅ ' + rows.length + ' checklists importados!');
  } catch(err){
    hideLoader();
    console.error('[FluxoLAB] erro importando checklists', err);
    alert('Erro ao importar a planilha: ' + (err.message || err));
  } finally {
    ev.target.value = '';
  }
}

async function fluxolabClearChecklists(){
  if (!_fluxolabChecklistsImported.length) return;
  if (!confirm('Limpar checklists importados?')) return;
  await dbDelete('/fluxolab_checklists');
}

// Localiza a chave da coluna de modelo de forma tolerante (maiúsculas, acentos, espaços)
function _fluxolabFindKey(row, target){
  const norm = s => String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]/g,'');
  const t = norm(target);
  for (const k of Object.keys(row)) if (norm(k) === t) return k;
  // fallback: contém
  for (const k of Object.keys(row)) if (norm(k).includes(t)) return k;
  return null;
}

function fluxolabRenderChecklistsImported(){
  const grid  = document.getElementById('fluxolab-checklists-grid');
  const stats = document.getElementById('fluxolab-checklists-stats');
  if (!grid) return;

  const esc = s => String(s==null?'':s).replace(/[&<>"']/g,
    c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const rows = _fluxolabChecklistsImported;

  // ── helper de stat card ──
  function statCard(label, val, color) {
    return `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:14px 16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">${label}</div>
      <div style="font-size:26px;font-weight:900;color:${color};font-family:var(--mono)">${val}</div>
    </div>`;
  }

  if (!rows.length) {
    if (stats) stats.innerHTML =
      statCard('Total Pedidos','0','var(--text)') +
      statCard('Lab','0','#22c55e') +
      statCard('Doca','0','#38bdf8') +
      statCard('Pedir Estoque','0','#f87171') +
      statCard('Atrasados','0','#fbbf24') +
      statCard('Urgentes','0','#f43f5e');
    grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--muted);font-size:14px">Nenhuma planilha importada.<br>Clique em <b style="color:var(--text)">⬆ Importar Planilha</b> para começar.</div>';
    return;
  }

  const searchEl = document.getElementById('fluxolab-checklist-search');
  const filter = searchEl ? searchEl.value.trim().toLowerCase() : '';

  // ── mapeamento de colunas ──
  const sample     = rows[0];
  const kModelo    = _fluxolabFindKey(sample,'Descrição Equipamento')||_fluxolabFindKey(sample,'Descricao Equipamento');
  const kAndamento = _fluxolabFindKey(sample,'Andamento');
  const kPedido    = _fluxolabFindKey(sample,'Pedido');
  const kCliente   = _fluxolabFindKey(sample,'Razão Social')||_fluxolabFindKey(sample,'Cliente');
  const kStatus    = _fluxolabFindKey(sample,'Status Checklist')||_fluxolabFindKey(sample,'Status');
  const kDias      = _fluxolabFindKey(sample,'Dias Aberto');
  const kDiasUteis = _fluxolabFindKey(sample,'Dias Úteis Andamento')||_fluxolabFindKey(sample,'Dias Uteis Andamento')||_fluxolabFindKey(sample,'Dias Úteis');
  const kStatusCk  = _fluxolabFindKey(sample,'Status Checklist');

  if (!kModelo) {
    grid.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger);font-size:13px">Coluna "Descrição Equipamento" não encontrada na planilha.</div>';
    return;
  }

  // ── agrupa por modelo ──
  const grupos = {};
  rows.forEach(r => {
    const modelo = String(r[kModelo]||'(Sem modelo)').trim()||'(Sem modelo)';
    if (!grupos[modelo]) grupos[modelo] = { total:0, items:[], somaUteis:0, liberados:0 };
    const g = grupos[modelo];
    g.total++;
    g.items.push(r);
    if (kDiasUteis) g.somaUteis += parseFloat(String(r[kDiasUteis]||'0').replace(',','.')) || 0;
    if (kStatusCk && String(r[kStatusCk]||'').trim().toLowerCase() === 'liberado') g.liberados++;
  });

  // ── índice de SELBs por modelo nos bolsões ──
  // LAB_KEYS: bolsões que contam como "no lab" (excluindo Doca e Scrap)
  const LAB_KEYS  = new Set(['LIMPEZA','LINHA_LIMPEZA','MONTAGEM','COMPLEXA','QUALIDADE','LIBERADAS','GAIOLA_LAB']);
  const DOCA_KEYS = new Set(['DOCA_1']);

  // Mapa de nomes normalizados dos modelos da planilha → nome original
  // Usado para match fuzzy entre nomes do Firebase e da planilha
  const modelosPlanilhaNorm = new Map(); // normKey → nomeOriginal
  Object.keys(grupos).forEach(m => modelosPlanilhaNorm.set(_fluxolabNormModel(m), m));

  // Função de match: tenta exato, depois por palavras-chave (modelo/série)
  function _matchModelo(nomeFirebase) {
    if (!nomeFirebase) return null;
    const norm = _fluxolabNormModel(nomeFirebase);
    if (!norm) return null;
    // 1. Exato
    if (modelosPlanilhaNorm.has(norm)) return norm;
    // 2. Fuzzy: extrai tokens >= 4 chars e verifica se a chave da planilha os contém todos
    const tokens = norm.split(/\s+/).filter(t => t.length >= 4);
    if (!tokens.length) return null;
    for (const [k] of modelosPlanilhaNorm) {
      if (tokens.every(t => k.includes(t))) return k;
    }
    // 3. Fuzzy reverso: tokens do nome da planilha dentro do nome do firebase
    for (const [k] of modelosPlanilhaNorm) {
      const kt = k.split(/\s+/).filter(t => t.length >= 4);
      if (kt.length && kt.every(t => norm.includes(t))) return k;
    }
    return null;
  }

  const labByModelo  = {}; // normKey → count (SELBs nos bolsões de lab)
  const docaByModelo = {}; // normKey → count (SELBs na doca)

  FLUXOLAB_BOLSOES.forEach(bb => {
    if (bb.key === 'SCRAP') return;
    const its = _fluxolabData[bb.key] ? Object.values(_fluxolabData[bb.key]) : [];
    its.forEach(v => {
      const _eqSt = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : ''; const rawNome = _eqSt || (typeof getEquipName === 'function' ? (getEquipName(v.selb || '') || '') : '') || '';
      const matchedKey = _matchModelo(rawNome);
      if (!matchedKey) return; // SELB sem modelo correspondente na planilha
      if (LAB_KEYS.has(bb.key)) {
        labByModelo[matchedKey] = (labByModelo[matchedKey] || 0) + 1;
      } else if (DOCA_KEYS.has(bb.key)) {
        docaByModelo[matchedKey] = (docaByModelo[matchedKey] || 0) + 1;
      }
    });
  });

  // totais globais para os stat cards
  const totalLabSELBs  = Object.values(labByModelo).reduce((s,n)=>s+n,0);
  const totalDocaSELBs = Object.values(docaByModelo).reduce((s,n)=>s+n,0);

  // bolsaoByModelo mantido para compatibilidade (lab + doca)
  const bolsaoByModelo = {};
  Object.keys(labByModelo).forEach(m  => { bolsaoByModelo[m] = (bolsaoByModelo[m]||0) + labByModelo[m];  });
  Object.keys(docaByModelo).forEach(m => { bolsaoByModelo[m] = (bolsaoByModelo[m]||0) + docaByModelo[m]; });

  // ── estatísticas globais ──
  let statAtrasados=0, statUrgentes=0, statEstoque=0;
  Object.entries(grupos).forEach(([modelo, g]) => {
    const totalFluxo = bolsaoByModelo[modelo] || 0;
    const avg = g.total ? g.somaUteis/g.total : 0;
    if (avg >= 2)  statAtrasados += g.total;
    if (totalFluxo < g.total) statUrgentes++;
    if (totalFluxo === 0 && g.total > 0) statEstoque++;
  });

  if (stats) stats.innerHTML =
    statCard('Total Pedidos', rows.length,     'var(--text)') +
    statCard('Lab',           totalLabSELBs,    '#22c55e') +
    statCard('Doca',          totalDocaSELBs,   '#38bdf8') +
    statCard('Pedir Estoque',statEstoque,      '#f87171') +
    statCard('Atrasados',    statAtrasados,    '#fbbf24') +
    statCard('Urgentes',     statUrgentes,     '#f43f5e');

  // ── filtra e ordena (avg desc) ──
  const entradas = Object.entries(grupos)
    .filter(([m, g]) => {
      if (!filter) return true;
      if (m.toLowerCase().includes(filter)) return true;
      return g.items.some(r =>
        (kCliente && String(r[kCliente]||'').toLowerCase().includes(filter)) ||
        (kPedido  && String(r[kPedido ]||'').toLowerCase().includes(filter))
      );
    })
    .sort((a,b) => {
      const avgA = a[1].total ? a[1].somaUteis/a[1].total : 0;
      const avgB = b[1].total ? b[1].somaUteis/b[1].total : 0;
      return avgB - avgA;
    });

  if (!entradas.length) {
    grid.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);font-size:13px">Nenhum resultado para "${esc(filter)}".</div>`;
    return;
  }

  // ── renderiza lista ──
  const listHtml = entradas.map(([modelo, g], idx) => {
    const labQtd   = labByModelo[modelo]  || 0;
    const docaQtd  = docaByModelo[modelo] || 0;
    const totalFluxo = labQtd + docaQtd;
    const faltantes  = Math.max(0, g.total - totalFluxo);
    const avg        = g.total ? Math.round(g.somaUteis/g.total) : 0;
    const isAtr      = avg >= 2;
    const detailId   = 'cl-det-' + idx;

    const avgColor = avg >= 5 ? '#f87171' : avg >= 3 ? '#fbbf24' : '#4ade80';

    const atrBadge = isAtr
      ? `<span style="flex-shrink:0;display:inline-flex;align-items:center;gap:4px;background:rgba(251,191,36,.15);border:1px solid rgba(251,191,36,.5);border-radius:7px;padding:3px 9px;font-size:11px;font-weight:800;color:#fbbf24;white-space:nowrap">⚠ ATR</span>`
      : `<span style="flex-shrink:0;width:58px"></span>`;

    const labBadge  = `<span style="flex-shrink:0;display:inline-flex;align-items:center;gap:4px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.35);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;color:#22c55e;white-space:nowrap">Lab:${labQtd}</span>`;
    const docaBadge = `<span style="flex-shrink:0;display:inline-flex;align-items:center;gap:4px;background:rgba(34,211,238,.1);border:1px solid rgba(34,211,238,.35);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;color:#22d3ee;white-space:nowrap">Doca:${docaQtd}</span>`;

    const cobertura = faltantes > 0
      ? `<span style="flex-shrink:0;font-size:13px;font-weight:700;color:#ef4444;white-space:nowrap">Falta ${faltantes}▾</span>`
      : `<span style="flex-shrink:0;font-size:13px;font-weight:700;color:#22c55e;white-space:nowrap">✓ Coberto</span>`;

    const detailHeaders = ['Pedido','Andamento','Cliente','Status','Dias Aberto'];
    const detailKeys    = [kPedido,kAndamento,kCliente,kStatus,kDias];
    const detailRows    = g.items.map(r =>
      `<tr>${detailKeys.map(k =>
        `<td style="padding:7px 12px;font-size:12px;color:var(--text);border-bottom:1px solid var(--border)">${esc(k?r[k]:'—')}</td>`
      ).join('')}</tr>`
    ).join('');

    return `
    <div style="border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:12px;padding:13px 18px;cursor:pointer;transition:background .12s"
           onclick="(function(el,id){var t=document.getElementById(id);var open=t.style.display!=='none';t.style.display=open?'none':'';el.querySelector('.cl-arr').style.transform=open?'':'rotate(180deg)';})(this,'${detailId}')"
           onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
        ${atrBadge}
        <span style="flex:1;font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(modelo)}</span>
        <span style="flex-shrink:0;font-size:13px;font-weight:700;color:${avgColor};white-space:nowrap">Avg: ${avg}d</span>
        <span style="flex-shrink:0;font-size:13px;font-weight:600;color:var(--muted);white-space:nowrap">${g.total} Peds</span>
        ${labBadge}
        ${docaBadge}
        ${cobertura}
        <span class="cl-arr" style="flex-shrink:0;color:var(--muted);font-size:14px;transition:transform .2s">▾</span>
      </div>
      <div id="${detailId}" style="display:none;background:var(--bg1)">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--bg3)">${detailHeaders.map(h =>
            `<th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--border2)">${h}</th>`
          ).join('')}</tr></thead>
          <tbody>${detailRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  grid.innerHTML = `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:14px;overflow:hidden">${listHtml}</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// FLUXOLAB — ABA "CAINDO HOJE": checklists com 0 dias úteis
// ═══════════════════════════════════════════════════════════════════
function fluxolabRenderCaindoHoje() {
  const grid  = document.getElementById('fluxolab-caindo-grid');
  const stats = document.getElementById('fluxolab-caindo-stats');
  const badge = document.getElementById('fluxolab-caindo-badge');
  if (!grid) return;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function statCard(label, val, color, sub) {
    return `<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:14px 16px">
      <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">${label}</div>
      <div style="font-size:26px;font-weight:900;color:${color};font-family:var(--mono)">${val}</div>
      ${sub ? `<div style="font-size:10px;color:var(--muted);margin-top:4px">${sub}</div>` : ''}
    </div>`;
  }

  const rows = _fluxolabChecklistsImported;

  if (!rows || !rows.length) {
    if (stats) stats.innerHTML = statCard('Caindo Hoje', 0, '#ef4444');
    if (badge) { badge.style.display = 'none'; }
    grid.innerHTML = '<div style="text-align:center;padding:60px;color:var(--muted);font-size:14px">Nenhuma planilha importada.<br>Importe uma planilha na aba <b style="color:var(--text)">Checklists Importados</b>.</div>';
    return;
  }

  const sample     = rows[0];
  const kModelo    = _fluxolabFindKey(sample, 'Descrição Equipamento') || _fluxolabFindKey(sample, 'Descricao Equipamento');
  const kDiasUteis = _fluxolabFindKey(sample, 'Dias Úteis Andamento') || _fluxolabFindKey(sample, 'Dias Uteis Andamento') || _fluxolabFindKey(sample, 'Dias Úteis') || _fluxolabFindKey(sample, 'Dias Uteis');
  const kDiasAb    = _fluxolabFindKey(sample, 'Dias Aberto');
  const kPedido    = _fluxolabFindKey(sample, 'Pedido');
  const kCliente   = _fluxolabFindKey(sample, 'Razão Social') || _fluxolabFindKey(sample, 'Cliente');
  const kAndamento = _fluxolabFindKey(sample, 'Andamento');
  const kStatus    = _fluxolabFindKey(sample, 'Status Checklist') || _fluxolabFindKey(sample, 'Status');

  const diasKey = kDiasUteis || kDiasAb;

  // Filtra apenas os que têm 0 dias (ou <= 0)
  const hoje = rows.filter(r => {
    if (!diasKey) return false;
    const v = parseFloat(String(r[diasKey] || '').replace(',', '.'));
    return !isNaN(v) && v <= 0;
  });

  // Atualiza badge da aba
  if (badge) {
    if (hoje.length > 0) {
      badge.textContent = hoje.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  // Agrupa por modelo
  const grupos = {};
  hoje.forEach(r => {
    const modelo = String((kModelo ? r[kModelo] : null) || '(Sem modelo)').trim();
    if (!grupos[modelo]) grupos[modelo] = [];
    grupos[modelo].push(r);
  });

  const totalModelos = Object.keys(grupos).length;

  if (stats) stats.innerHTML =
    statCard('Caindo Hoje', hoje.length, '#ef4444', 'checklists com 0 dias') +
    statCard('Modelos Afetados', totalModelos, '#fbbf24', 'equipamentos distintos') +
    statCard('Total na Planilha', rows.length, 'var(--text)', 'checklists importados');

  if (!hoje.length) {
    grid.innerHTML = '<div style="text-align:center;padding:60px;color:#4ade80;font-size:15px;font-weight:700">✅ Nenhum checklist caindo hoje!</div>';
    return;
  }

  // Renderiza agrupado por modelo
  const listHtml = Object.entries(grupos)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([modelo, items], idx) => {
      const detailId = 'caindo-det-' + idx;
      const detailKeys    = [kPedido, kAndamento, kCliente, kStatus, diasKey];
      const detailHeaders = ['Pedido', 'Andamento', 'Cliente', 'Status', 'Dias'];
      const detailRows = items.map(r =>
        `<tr>${detailKeys.map(k =>
          `<td style="padding:7px 12px;font-size:12px;color:var(--text);border-bottom:1px solid var(--border)">${esc(k ? r[k] : '—')}</td>`
        ).join('')}</tr>`
      ).join('');

      return `
      <div style="border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:12px;padding:13px 18px;cursor:pointer;transition:background .12s"
             onclick="(function(el,id){var t=document.getElementById(id);var open=t.style.display!=='none';t.style.display=open?'none':'';el.querySelector('.caindo-arr').style.transform=open?'':'rotate(180deg)';})(this,'${detailId}')"
             onmouseover="this.style.background='var(--bg3)'" onmouseout="this.style.background=''">
          <span style="flex-shrink:0;display:inline-flex;align-items:center;gap:4px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.5);border-radius:7px;padding:3px 9px;font-size:11px;font-weight:800;color:#ef4444;white-space:nowrap">🔥 HOJE</span>
          <span style="flex:1;font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(modelo)}</span>
          <span style="flex-shrink:0;font-size:13px;font-weight:700;color:#ef4444;white-space:nowrap">${items.length} checklist${items.length > 1 ? 's' : ''}</span>
          <span class="caindo-arr" style="flex-shrink:0;color:var(--muted);font-size:14px;transition:transform .2s">▾</span>
        </div>
        <div id="${detailId}" style="display:none;background:var(--bg1)">
          <table style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--bg3)">${detailHeaders.map(h =>
              `<th style="padding:7px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);border-bottom:1px solid var(--border2)">${h}</th>`
            ).join('')}</tr></thead>
            <tbody>${detailRows}</tbody>
          </table>
        </div>
      </div>`;
    }).join('');

  grid.innerHTML = `<div style="background:var(--bg2);border:1px solid rgba(239,68,68,.3);border-radius:14px;overflow:hidden">${listHtml}</div>`;
}

// ═══════════════════════════════════════════════════════════════════
// FLUXOLAB — RELATÓRIO: quantos checklists caem por dia
// Usa "Dias Úteis" de cada checklist e agrupa por valor (0=hoje, 1=amanhã, etc.)
// ═══════════════════════════════════════════════════════════════════
function fluxolabRelatorioPorDia() {
  const modal   = document.getElementById('modal-fluxolab-relatorio-dia');
  const content = document.getElementById('fluxolab-relatorio-dia-content');
  if (!modal || !content) return;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  const rows = _fluxolabChecklistsImported;

  if (!rows || !rows.length) {
    content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Nenhuma planilha importada.</div>';
    modal.style.display = 'flex';
    return;
  }

  const sample     = rows[0];
  const kDiasUteis = _fluxolabFindKey(sample, 'Dias Úteis Andamento') || _fluxolabFindKey(sample, 'Dias Uteis Andamento') || _fluxolabFindKey(sample, 'Dias Úteis') || _fluxolabFindKey(sample, 'Dias Uteis');
  const kDiasAb    = _fluxolabFindKey(sample, 'Dias Aberto');
  const kModelo    = _fluxolabFindKey(sample, 'Descrição Equipamento') || _fluxolabFindKey(sample, 'Descricao Equipamento');
  const kPedido    = _fluxolabFindKey(sample, 'Pedido');
  const kCliente   = _fluxolabFindKey(sample, 'Razão Social') || _fluxolabFindKey(sample, 'Cliente');
  const diasKey    = kDiasUteis || kDiasAb;

  if (!diasKey) {
    content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--danger)">Coluna de dias úteis não encontrada na planilha.</div>';
    modal.style.display = 'flex';
    return;
  }

  // Agrupa por quantidade de dias (inteiro, arredondado)
  const porDia = {}; // dia (int) -> { items: [], count: 0 }
  rows.forEach(r => {
    const v = parseFloat(String(r[diasKey] || '').replace(',', '.'));
    if (isNaN(v)) return;
    const d = Math.round(v);
    if (!porDia[d]) porDia[d] = { count: 0, items: [] };
    porDia[d].count++;
    porDia[d].items.push(r);
  });

  // Ordena por dia (menor primeiro, negativos = já vencidos)
  const dias = Object.keys(porDia).map(Number).sort((a, b) => a - b);

  if (!dias.length) {
    content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Nenhum dado de dias encontrado.</div>';
    modal.style.display = 'flex';
    return;
  }

  // Maior barra = referência de largura
  const maxCount = Math.max(...dias.map(d => porDia[d].count));

  const labelDia = d => {
    if (d < 0)  return `<span style="color:#ef4444">⚠ Vencido (${Math.abs(d)}d atrás)</span>`;
    if (d === 0) return `<span style="color:#ef4444;font-weight:900">🔥 Hoje</span>`;
    if (d === 1) return `<span style="color:#fbbf24">Amanhã</span>`;
    return `<span style="color:var(--text)">Em ${d} dia${d > 1 ? 's' : ''}</span>`;
  };

  const corBarra = d => {
    if (d <= 0)  return '#ef4444';
    if (d <= 2)  return '#fbbf24';
    if (d <= 5)  return '#f97316';
    return '#4ade80';
  };

  // Resumo totais
  const totalVencidos = dias.filter(d => d < 0).reduce((s, d) => s + porDia[d].count, 0);
  const totalHoje     = (porDia[0] || {}).count || 0;
  const totalAmanha   = (porDia[1] || {}).count || 0;
  const total7d       = dias.filter(d => d >= 0 && d <= 7).reduce((s, d) => s + porDia[d].count, 0);

  const resumo = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:22px">
      <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">Vencidos</div>
        <div style="font-size:26px;font-weight:900;color:#ef4444;font-family:var(--mono)">${totalVencidos}</div>
      </div>
      <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);border-radius:12px;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">🔥 Hoje</div>
        <div style="font-size:26px;font-weight:900;color:#ef4444;font-family:var(--mono)">${totalHoje}</div>
      </div>
      <div style="background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:12px;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">Amanhã</div>
        <div style="font-size:26px;font-weight:900;color:#fbbf24;font-family:var(--mono)">${totalAmanha}</div>
      </div>
      <div style="background:var(--bg3);border:1px solid var(--border2);border-radius:12px;padding:14px 16px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px">Próx. 7 dias</div>
        <div style="font-size:26px;font-weight:900;color:var(--text);font-family:var(--mono)">${total7d}</div>
      </div>
    </div>`;

  // Tabela/barras por dia
  const barrasHtml = dias.map(d => {
    const { count, items } = porDia[d];
    const pct = Math.max(4, Math.round((count / maxCount) * 100));
    const cor = corBarra(d);

    // Resumo dos equipamentos desse dia
    const equipResumo = (() => {
      const eq = {};
      items.forEach(r => {
        const m = String((kModelo ? r[kModelo] : null) || '(Sem modelo)').trim();
        eq[m] = (eq[m] || 0) + 1;
      });
      return Object.entries(eq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([m, n]) => `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--text);white-space:nowrap;margin:2px">${esc(m)}<span style="color:${cor};font-weight:900">${n}</span></span>`)
        .join('');
    })();

    return `
    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
        <div style="width:130px;flex-shrink:0;font-size:12px;font-weight:700">${labelDia(d)}</div>
        <div style="flex:1;background:var(--bg3);border-radius:6px;height:24px;position:relative;overflow:hidden">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:${cor};border-radius:6px;opacity:.85;transition:width .3s"></div>
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:12px;font-weight:900;color:#fff;font-family:var(--mono)">${count}</span>
        </div>
      </div>
      <div style="padding-left:140px;display:flex;flex-wrap:wrap;gap:2px;margin-bottom:2px">${equipResumo}</div>
    </div>`;
  }).join('');

  content.innerHTML = resumo + `
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:12px">Distribuição por dia (dias úteis restantes)</div>
    ${barrasHtml}`;

  modal.style.display = 'flex';
}

// FLUXOLAB — Indexação de checklists por modelo (para badges nos bolsões)
// ════════════════════════════════════════
function _fluxolabNormModel(s){
  return String(s||'').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[-_./\\()\[\]{}|#@!?*,;:'"]/g,' ')
    .replace(/\s+/g,' ').trim();
}
function _fluxolabBuildChecklistIndex(){
  const idx = new Map();
  if (!Array.isArray(_fluxolabChecklistsImported) || !_fluxolabChecklistsImported.length) return idx;
  const sample = _fluxolabChecklistsImported[0];
  const k = _fluxolabFindKey(sample, 'Descrição Equipamento') || _fluxolabFindKey(sample, 'Descricao Equipamento');
  if (!k) return idx;
  for (const r of _fluxolabChecklistsImported){
    const m = _fluxolabNormModel(r[k]);
    if (!m) continue;
    idx.set(m, (idx.get(m) || 0) + 1);
  }
  return idx;
}

// Faz a aba "Bolsões" re-renderizar quando os checklists importados mudam
(function _patchChecklistsRefresh(){
  const _origRender = typeof fluxolabRenderChecklistsImported === 'function' ? fluxolabRenderChecklistsImported : null;
  if (!_origRender) return;
  window.fluxolabRenderChecklistsImported = function(){
    _origRender.apply(this, arguments);
    if (typeof _fluxolabRenderGrid === 'function') {
      try { _fluxolabRenderGrid(); } catch(e){}
    }
  };
})();

// ════════════════════════════════════════════════════════════════════
// QUALIDADE — LIBERADAS (inserção manual de SELBs)
// ════════════════════════════════════════════════════════════════════
(function(){
  function todayStr(){
    const d = new Date();
    return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0') + '/' + d.getFullYear();
  }
  function parseSelbs(raw){
    return (raw||'').toUpperCase().split(/[\s,;\n\r\t]+/).map(x=>x.trim()).filter(Boolean);
  }
  function recognizeSelb(selb){
    let nome = '';
    try { if(typeof getEquipName === 'function') nome = getEquipName(selb) || ''; } catch(e){}
    if(!nome){
      const recs = [].concat((typeof history!=='undefined'?history:[])||[], (typeof _consultaRecords!=='undefined'?_consultaRecords:[])||[]);
      const m = recs.find(h => (h.selb||'').toUpperCase() === selb);
      if(m && m.equipamento) nome = m.equipamento;
    }
    return nome;
  }
  function updatePreview(){
    const ta = document.getElementById('qual-lib-textarea');
    const box = document.getElementById('qual-lib-preview');
    const btn = document.getElementById('qual-lib-save');
    const cnt = document.getElementById('qual-lib-count');
    if(!ta || !box) return;
    const selbs = parseSelbs(ta.value);
    const liberadas = window._qualLiberadas || {};
    const jaLib = new Set();
    Object.values(liberadas).forEach(r => { if(r && r.selb) jaLib.add(String(r.selb).toUpperCase()); });
    const seen = new Set();
    let okCount = 0, badCount = 0, dupCount = 0;
    const rows = selbs.map(selb => {
      if(seen.has(selb)) return { selb, status:'dup-input', nome:'' };
      seen.add(selb);
      if(jaLib.has(selb)){ dupCount++; return { selb, status:'dup', nome: recognizeSelb(selb) }; }
      const nome = recognizeSelb(selb);
      if(nome){ okCount++; return { selb, status:'ok', nome }; }
      badCount++; return { selb, status:'bad', nome:'' };
    });
    if(rows.length === 0){
      box.innerHTML = '<div style="padding:14px;text-align:center;color:var(--muted);font-size:12px">Cole ou digite os SELBs acima — um por linha (ou separados por espaço/vírgula).</div>';
    } else {
      box.innerHTML = rows.map(r => {
        const colors = {
          ok:  {bg:'rgba(74,222,128,.08)', bd:'rgba(74,222,128,.4)',  c:'#4ade80', icon:'✓', tag:'reconhecido'},
          bad: {bg:'rgba(239,68,68,.08)',  bd:'rgba(239,68,68,.4)',   c:'#ef4444', icon:'✗', tag:'desconhecido'},
          dup: {bg:'rgba(245,166,35,.08)', bd:'rgba(245,166,35,.4)',  c:'#f5a623', icon:'⚠', tag:'já liberado'},
          'dup-input': {bg:'rgba(148,163,184,.08)', bd:'rgba(148,163,184,.4)', c:'#94a3b8', icon:'↺', tag:'duplicado'}
        }[r.status];
        return '<div style="display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:8px;background:'+colors.bg+';border:1px solid '+colors.bd+';margin-bottom:4px">'
          + '<span style="color:'+colors.c+';font-weight:900;font-size:14px;width:14px;text-align:center">'+colors.icon+'</span>'
          + '<span style="font-family:var(--mono);font-weight:700;color:var(--text);font-size:12px;min-width:120px">'+r.selb+'</span>'
          + '<span style="color:var(--muted);font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(r.nome||'—')+'</span>'
          + '<span style="font-size:10px;font-weight:700;color:'+colors.c+';text-transform:uppercase;letter-spacing:.05em">'+colors.tag+'</span>'
          + '</div>';
      }).join('');
    }
    if(cnt) cnt.innerHTML = '<span style="color:#4ade80;font-weight:700">'+okCount+' OK</span>'
      + (badCount?' · <span style="color:#ef4444;font-weight:700">'+badCount+' desconhecido(s)</span>':'')
      + (dupCount?' · <span style="color:#f5a623;font-weight:700">'+dupCount+' já liberado(s)</span>':'');
    if(btn){
      btn.disabled = okCount === 0;
      btn.style.opacity = okCount === 0 ? '.5' : '1';
      btn.style.cursor  = okCount === 0 ? 'not-allowed' : 'pointer';
      btn.textContent = okCount > 0 ? ('💾 Liberar ' + okCount + ' SELB(s)') : '💾 Liberar';
    }
  }

  // ── Painel de listagem de Liberadas ──────────────────────────────────────
  window.qualOpenLiberadasPanel = function(){
    let ov = document.getElementById('qual-lib-panel-overlay');
    if(ov){ ov.style.display='flex'; _qualRenderLiberadasList(); return; }
    ov = document.createElement('div');
    ov.id = 'qual-lib-panel-overlay';
    ov.setAttribute('style','position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px');
    ov.innerHTML = ''
      + '<div style="background:var(--bg2);border:1px solid rgba(236,72,153,.4);border-radius:14px;width:min(860px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)">'
      +   '<div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px">'
      +     '<div><h3 style="margin:0;font-size:16px;font-weight:700;color:#ec4899">✅ SELBs Liberados Manualmente</h3>'
      +     '<p style="margin:4px 0 0;font-size:11px;color:var(--muted)" id="qual-lib-panel-subtitle">Carregando...</p></div>'
      +     '<div style="display:flex;align-items:center;gap:8px">'
      +       '<input id="qual-lib-panel-search" placeholder="Buscar SELB ou equipamento..." style="background:var(--bg3);border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:12px;padding:6px 12px;outline:none;width:220px" oninput="_qualRenderLiberadasList()">'
      +       '<button onclick="window.qualOpenLiberadasModal && window.qualOpenLiberadasModal()" style="background:#ec4899;border:none;color:#fff;padding:7px 14px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">＋ Adicionar</button>'
      +       '<button onclick="document.getElementById(\'qual-lib-panel-overlay\').style.display=\'none\'" style="background:transparent;border:1px solid var(--border2);color:var(--muted);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px">×</button>'
      +     '</div>'
      +   '</div>'
      +   '<div id="qual-lib-panel-body" style="overflow-y:auto;flex:1;min-height:0">'
      +     '<div style="text-align:center;color:var(--muted);font-size:13px;padding:40px">Carregando...</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){ if(e.target===ov) ov.style.display='none'; });
    _qualRenderLiberadasList();
  };

  window._qualRenderLiberadasList = function _qualRenderLiberadasList(){
    const body    = document.getElementById('qual-lib-panel-body');
    const subtitle= document.getElementById('qual-lib-panel-subtitle');
    const q       = (document.getElementById('qual-lib-panel-search')?.value || '').toUpperCase().trim();
    if(!body) return;

    let rows = Object.entries(window._qualLiberadas || {})
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));

    if(q){
      rows = rows.filter(r =>
        (r.selb  || '').toUpperCase().includes(q) ||
        (r.equipamento || '').toUpperCase().includes(q) ||
        (r.user  || '').toUpperCase().includes(q)
      );
    }

    if(subtitle) subtitle.textContent =
      rows.length + ' registro' + (rows.length !== 1 ? 's' : '') +
      (q ? ' · filtrado por "' + q + '"' : '');

    if(!rows.length){
      body.innerHTML = '<div style="text-align:center;color:var(--muted);font-size:13px;padding:40px">'
        + (q ? 'Nenhum resultado para "' + q + '"' : 'Nenhum SELB liberado ainda.') + '</div>';
      return;
    }

    // Agrupa por data
    const byDate = {};
    rows.forEach(r => {
      const d = r.data || (r.ts ? new Date(r.ts).toLocaleDateString('pt-BR') : '—');
      if(!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    });

    let html = '<table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<thead><tr style="position:sticky;top:0;z-index:2;background:var(--bg2)">'
      + '<th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">SELB</th>'
      + '<th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">EQUIPAMENTO</th>'
      + '<th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">DATA</th>'
      + '<th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">HORA</th>'
      + '<th style="padding:10px 14px;text-align:left;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">RESPONSÁVEL</th>'
      + '<th style="padding:10px 14px;text-align:center;font-size:10px;font-weight:700;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid var(--border2)">AÇÃO</th>'
      + '</tr></thead><tbody>';

    Object.entries(byDate).forEach(([date, items]) => {
      // Separador de data
      html += '<tr><td colspan="6" style="padding:8px 14px 4px;background:var(--bg3);border-bottom:1px solid var(--border);border-top:1px solid var(--border2)">'
        + '<span style="font-size:10px;font-weight:800;color:#ec4899;letter-spacing:.07em;text-transform:uppercase">'
        + date + '</span>'
        + '<span style="font-size:10px;color:var(--muted);margin-left:8px">' + items.length + ' SELB' + (items.length !== 1 ? 's' : '') + '</span>'
        + '</td></tr>';

      items.forEach(r => {
        const hora = r.ts ? new Date(r.ts).toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'}) : '—';
        const equip = (r.equipamento || '—').replace(/MULTIFUNCIONAL\s*/i,'MF ').replace(/IMPRESSORA\s*/i,'IMP ');
        const isAdmin = typeof currentUser !== 'undefined' && currentUser && currentUser.isAdmin;
        html += '<tr style="border-bottom:1px solid var(--border);transition:background .1s" onmouseover="this.style.background=\'var(--bg3)\'" onmouseout="this.style.background=\'\'">'
          + '<td style="padding:10px 14px;font-family:var(--mono);font-weight:700;font-size:13px;color:#ec4899">' + (r.selb || '—') + '</td>'
          + '<td style="padding:10px 14px;color:var(--text);max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + (r.equipamento || '') + '">' + equip + '</td>'
          + '<td style="padding:10px 14px;color:var(--muted)">' + (r.data || '—') + '</td>'
          + '<td style="padding:10px 14px;color:var(--muted);font-family:var(--mono)">' + hora + '</td>'
          + '<td style="padding:10px 14px;color:var(--muted)">' + (r.user || '—') + '</td>'
          + '<td style="padding:10px 14px;text-align:center">'
          + (isAdmin
              ? '<button onclick="_qualRemoveLiberada(\'' + r.key + '\')" title="Remover registro" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#ef4444;border-radius:6px;width:26px;height:26px;cursor:pointer;font-size:14px;font-weight:700;line-height:1;transition:all .15s" onmouseover="this.style.background=\'rgba(239,68,68,.3)\'" onmouseout="this.style.background=\'rgba(239,68,68,.12)\'">×</button>'
              : '<span style="color:var(--border2);font-size:14px">—</span>')
          + '</td>'
          + '</tr>';
      });
    });

    html += '</tbody></table>';
    body.innerHTML = html;
  }

  window._qualRemoveLiberada = async function(key){
    if(!key) return;
    if(!confirm('Remover este registro de liberação?')) return;
    try {
      await _db.ref('/qualidade_liberadas/' + key).remove();
      _qualRenderLiberadasList();
      if(typeof renderQualRegistros === 'function') renderQualRegistros();
    } catch(e){
      alert('Erro ao remover: ' + (e && e.message || e));
    }
  };

  // Ao salvar liberadas, atualiza o painel se estiver aberto
  const _origQualSave = window.qualSaveLiberadas;

  window.qualSaveLiberadas = async function(){
    await (_origQualSave ? _origQualSave.apply(this, arguments) : Promise.resolve());
    const panel = document.getElementById('qual-lib-panel-overlay');
    if(panel && panel.style.display !== 'none') _qualRenderLiberadasList();
  };

    window.qualOpenLiberadasModal = function(){
    let ov = document.getElementById('qual-lib-overlay');
    if(ov){ ov.style.display='flex'; updatePreview(); return; }
    ov = document.createElement('div');
    ov.id = 'qual-lib-overlay';
    ov.setAttribute('style','position:fixed;inset:0;z-index:600;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px');
    ov.innerHTML = ''
      + '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:14px;width:min(720px,100%);max-height:90vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.5)">'
      +   '<div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px">'
      +     '<div><h3 style="margin:0;font-size:16px;font-weight:700;color:#ec4899">✅ Liberar SELBs manualmente</h3>'
      +     '<p style="margin:4px 0 0;font-size:11px;color:var(--muted)">Cole os SELBs (um por linha ou separados por espaço/vírgula). Apenas os reconhecidos serão liberados.</p></div>'
      +     '<button onclick="document.getElementById(\'qual-lib-overlay\').style.display=\'none\'" style="background:transparent;border:1px solid var(--border2);color:var(--muted);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:16px">×</button>'
      +   '</div>'
      +   '<div style="padding:18px 22px;display:flex;flex-direction:column;gap:12px;overflow:auto">'
      +     '<textarea id="qual-lib-textarea" placeholder="SELB001&#10;SELB002&#10;SELB003" rows="5" style="background:var(--bg3);border:1px solid var(--border2);border-radius:9px;color:var(--text);font-family:var(--mono);font-size:13px;padding:10px 12px;outline:none;resize:vertical;width:100%"></textarea>'
      +     '<div id="qual-lib-count" style="font-size:11px;color:var(--muted)"></div>'
      +     '<div id="qual-lib-preview" style="max-height:280px;overflow:auto;background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:10px"></div>'
      +   '</div>'
      +   '<div style="padding:14px 22px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">'
      +     '<button onclick="document.getElementById(\'qual-lib-overlay\').style.display=\'none\'" style="background:transparent;border:1px solid var(--border2);color:var(--text);padding:8px 16px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer">Cancelar</button>'
      +     '<button id="qual-lib-save" style="background:#ec4899;border:1px solid #ec4899;color:#fff;padding:8px 18px;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer">💾 Liberar</button>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function(e){ if(e.target===ov) ov.style.display='none'; });
    document.getElementById('qual-lib-textarea').addEventListener('input', updatePreview);
    document.getElementById('qual-lib-save').addEventListener('click', window.qualSaveLiberadas);
    updatePreview();
    setTimeout(()=>document.getElementById('qual-lib-textarea').focus(), 60);
  };

  window.qualSaveLiberadas = async function(){
    const ta = document.getElementById('qual-lib-textarea');
    if(!ta) return;
    const selbs = parseSelbs(ta.value);
    const liberadas = window._qualLiberadas || {};
    const jaLib = new Set();
    Object.values(liberadas).forEach(r => { if(r && r.selb) jaLib.add(String(r.selb).toUpperCase()); });
    const seen = new Set();
    const novos = [];
    selbs.forEach(selb => {
      if(seen.has(selb) || jaLib.has(selb)) return;
      seen.add(selb);
      const nome = recognizeSelb(selb);
      if(nome) novos.push({ selb, nome });
    });
    if(novos.length === 0){ alert('Nenhum SELB reconhecido para liberar.'); return; }
    if(typeof _db === 'undefined' || !_db){ alert('Banco de dados indisponível.'); return; }
    const data = todayStr();
    const ts = Date.now();
    const user = (typeof currentUser !== 'undefined' && currentUser && (currentUser.name || currentUser.email)) || 'sistema';
    try {
      const ref = _db.ref('/qualidade_liberadas');
      const updates = {};
      novos.forEach(n => {
        const key = ref.push().key;
        updates[key] = { selb: n.selb, equipamento: n.nome, data: data, ts: ts, user: user };
      });
      await ref.update(updates);
      if(typeof fluxolabFinalizarSelb === 'function'){
        for(const n of novos){
          fluxolabFinalizarSelb(n.selb, 'QUALIDADE', 'ok').catch(e =>
            console.warn('[FluxoLAB] Erro ao mover SELB liberado manualmente:', e));
        }
      }
      ta.value = '';
      const ov = document.getElementById('qual-lib-overlay');
      if(ov) ov.style.display='none';
      if(typeof renderQualRegistros === 'function') renderQualRegistros();
    } catch(err){
      console.error(err);
      alert('Erro ao salvar: ' + (err && err.message || err));
    }
  };
})();

// ════════════════════════════════════════════════════════════
// ⏱️ TEMPO SELB — Lógica movida e centralizada em index.html
// O bloco antigo (Por SELB via /history + /qualidade) foi removido
// para evitar conflito com window.renderTempoSelb definido em index.html,
// que agora também calcula a Média por Modelo e o tempo de Limpeza+Montagem.
// ════════════════════════════════════════════════════════════
/* ════════════════════════════════════════════════════════════════
   PATCH — FluxoLAB › Checklists Importados
   Reestiliza a aba para parecer a tela "Pedidos" (KPIs no topo,
   cards agrupadores por modelo, tabela expansível com colunas
   PEDIDO / CLIENTE / CUSTOMER·TEL / TIPO / DIAS ÚTEIS / STATUS / OBS / URGENTE).
════════════════════════════════════════════════════════════════ */
(function(){
  const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function findKey(obj, ...names){
    if(!obj) return null;
    const keys = Object.keys(obj);
    const norm = s => String(s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
      .replace(/[^a-z0-9]/g,'');
    for(const n of names){
      const t = norm(n);
      const k = keys.find(k => norm(k) === t);
      if(k) return k;
    }
    for(const n of names){
      const t = norm(n);
      const k = keys.find(k => norm(k).includes(t));
      if(k) return k;
    }
    return null;
  }

  function ensureHeader(){
    const panel = document.getElementById('fluxolab-tab-checklists-panel');
    if(!panel || document.getElementById('flcl-header-pedidos')) return;

    // Esconde o bloco antigo de import (substituído pelo header novo)
    const oldBar = panel.querySelector('div'); // primeiro div = barra de import
    if(oldBar) oldBar.style.display = 'none';
    const summary = document.getElementById('fluxolab-checklists-summary');
    if(summary) summary.style.display = 'none';

    const header = document.createElement('div');
    header.id = 'flcl-header-pedidos';
    header.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px">
        <div>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:22px">📋</span>
            <h2 style="font-size:24px;font-weight:800;color:var(--accent);margin:0;letter-spacing:-.02em">Pedidos</h2>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-top:4px">
            Cruza a demanda (pedidos) com a oferta (seu estoque).
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="position:relative">
            <input id="flcl-search-top" placeholder="Pesquisar OBS, Pedido, Cliente…"
              style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;
                     color:var(--text);font-family:var(--font);font-size:12px;
                     padding:10px 14px;outline:none;width:320px"/>
          </div>
          <button id="flcl-btn-import"
            style="display:inline-flex;align-items:center;gap:8px;background:var(--accent);
                   border:none;border-radius:10px;color:#04130c;font-family:var(--font);
                   font-size:12px;font-weight:700;padding:10px 16px;cursor:pointer;
                   box-shadow:0 6px 18px rgba(16,185,129,.35)">
            ⬆ Importar Planilha
          </button>
          <button id="flcl-btn-clear" title="Limpar checklists importados"
            style="background:var(--bg3);border:1px solid var(--border2);border-radius:10px;
                   color:var(--muted);font-size:14px;padding:10px 12px;cursor:pointer">
            🗑
          </button>
        </div>
      </div>
      <div id="flcl-kpis"
        style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:18px"></div>
    `;
    panel.insertBefore(header, panel.firstChild);

    // Wiring
    const fileInput = document.getElementById('fluxolab-checklists-file');
    document.getElementById('flcl-btn-import').onclick = () => fileInput && fileInput.click();
    document.getElementById('flcl-btn-clear').onclick = () => {
      if(typeof fluxolabClearChecklists === 'function') fluxolabClearChecklists();
    };
    const topSearch = document.getElementById('flcl-search-top');
    const oldSearch = document.getElementById('fluxolab-checklist-search');
    topSearch.addEventListener('input', () => {
      if(oldSearch){ oldSearch.value = topSearch.value; }
      if(typeof fluxolabRenderChecklistsImported === 'function')
        fluxolabRenderChecklistsImported();
    });

    // Responsivo
    const mq = window.matchMedia('(max-width:1100px)');
    const apply = () => {
      const k = document.getElementById('flcl-kpis');
      if(k) k.style.gridTemplateColumns = mq.matches
        ? 'repeat(3,minmax(0,1fr))' : 'repeat(6,minmax(0,1fr))';
    };
    mq.addEventListener('change', apply); apply();
  }

  function kpiCard(icon, label, value, color){
    return `
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:14px;
                  padding:16px 18px;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:700;
                    letter-spacing:.12em;color:var(--muted);text-transform:uppercase">
          <span style="font-size:12px;opacity:.85">${icon}</span>${label}
        </div>
        <div style="font-family:var(--mono);font-size:30px;font-weight:800;color:${color};
                    line-height:1">${value}</div>
      </div>`;
  }

  function renderKPIs(rows, grupos, statusCounts){
    const k = document.getElementById('flcl-kpis');
    if(!k) return;
    const total    = rows.length;
    const lab      = statusCounts.lab      || 0;
    const doca     = statusCounts.doca     || 0;
    const estoque  = statusCounts.estoque  || 0;
    const atras    = statusCounts.atrasados || 0;
    const urg      = statusCounts.urgentes  || 0;
    k.innerHTML = [
      kpiCard('📋','Total Pedidos', total,   'var(--text)'),
      kpiCard('🛡','Lab (Pronto)',  lab,     'var(--accent)'),
      kpiCard('📦','Puxar Doca',    doca,    '#3b82f6'),
      kpiCard('🛒','Pedir Estoque', estoque, 'var(--danger)'),
      kpiCard('⚠','Atrasados',     atras,   'var(--gold)'),
      kpiCard('🔔','Urgentes',      urg,     'var(--purple)'),
    ].join('');
  }

  function classifyStatus(s){
    const t = String(s||'').toLowerCase();
    if(/liberad|pronto|lab/.test(t)) return 'lab';
    if(/doca/.test(t))               return 'doca';
    if(/estoque|pedir/.test(t))      return 'estoque';
    return null;
  }

  function newRender(){
    const grid = document.getElementById('fluxolab-checklists-grid');
    if(!grid) return;
    ensureHeader();

    let rows = [];
    try { rows = (typeof _fluxolabChecklistsImported !== 'undefined' && _fluxolabChecklistsImported) || []; } catch(e){}
    if(!rows.length && window._fluxolabChecklistsImported) rows = window._fluxolabChecklistsImported;
    if(!rows.length){
      renderKPIs([], {}, {});
      grid.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--muted);font-size:13px;
                    background:var(--bg2);border:1px dashed var(--border2);border-radius:14px">
          Nenhuma planilha importada. Clique em <b style="color:var(--accent)">Importar Planilha</b> para começar.
        </div>`;
      return;
    }

    const s = rows[0];
    const kModelo  = findKey(s,'Descrição Equipamento','Descricao Equipamento','Modelo');
    const kPedido  = findKey(s,'Pedido','Nº Pedido','Numero Pedido','OS');
    const kCli     = findKey(s,'Razão Social','Razao Social','Cliente');
    const kCliId   = findKey(s,'Codigo Cliente','Código Cliente','ID Cliente');
    const kCust    = findKey(s,'Customer','Contato','Atendente','Responsavel','Responsável');
    const kTel     = findKey(s,'Telefone','Tel','Fone','Celular');
    const kTipo    = findKey(s,'Tipo','Tipo Pedido','Modalidade');
    const kDias    = findKey(s,'Dias Uteis','Dias Úteis','Dias Aberto','Dias');
    const kStatus  = findKey(s,'Status Checklist','Status','Andamento');
    const kObs     = findKey(s,'OBS','Observação','Observacao','Obs');
    const kUrg     = findKey(s,'Urgente','Prioridade');

    if(!kModelo){
      renderKPIs([], {}, {});
      grid.innerHTML = `<div style="text-align:center;padding:40px;color:var(--danger);font-size:13px">
        Coluna "Descrição Equipamento" não encontrada na planilha.</div>`;
      return;
    }

    // Agrupa
    const grupos = {};
    const statusCounts = { lab:0, doca:0, estoque:0, atrasados:0, urgentes:0 };
    rows.forEach(r => {
      const modelo = String(r[kModelo]||'(Sem modelo)').trim() || '(Sem modelo)';
      if(!grupos[modelo]) grupos[modelo] = { items:[], dias:[], lab:0, doca:0, atr:0 };
      grupos[modelo].items.push(r);
      const dias = kDias ? parseInt(String(r[kDias]).replace(/\D/g,''),10) : NaN;
      if(!isNaN(dias)){
        grupos[modelo].dias.push(dias);
        if(dias > 10){ grupos[modelo].atr++; statusCounts.atrasados++; }
      }
      const cls = kStatus ? classifyStatus(r[kStatus]) : null;
      if(cls === 'lab')     { grupos[modelo].lab++;  statusCounts.lab++; }
      if(cls === 'doca')    { grupos[modelo].doca++; statusCounts.doca++; }
      if(cls === 'estoque') {                        statusCounts.estoque++; }
      if(kUrg && /sim|true|1|x/i.test(String(r[kUrg]||''))) statusCounts.urgentes++;
    });

    renderKPIs(rows, grupos, statusCounts);

    // Filtro
    const topSearch = document.getElementById('flcl-search-top');
    const oldSearch = document.getElementById('fluxolab-checklist-search');
    const filter = ((topSearch && topSearch.value) || (oldSearch && oldSearch.value) || '')
      .trim().toLowerCase();

    const matchRow = (r) => {
      if(!filter) return true;
      const blob = [
        r[kModelo], kPedido&&r[kPedido], kCli&&r[kCli],
        kObs&&r[kObs], kCust&&r[kCust], kTel&&r[kTel]
      ].map(v => String(v==null?'':v).toLowerCase()).join(' ');
      return blob.includes(filter);
    };

    const entradas = Object.entries(grupos)
      .map(([m,d]) => {
        const items = d.items.filter(matchRow);
        return [m, { ...d, items, total: items.length }];
      })
      .filter(([,d]) => d.total > 0)
      .sort((a,b) => b[1].total - a[1].total);

    if(!entradas.length){
      grid.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted);
        font-size:13px;background:var(--bg2);border:1px solid var(--border2);border-radius:14px">
        Nenhum resultado para o filtro.</div>`;
      return;
    }

    const headers = ['PEDIDO','CLIENTE','CUSTOMER · TEL','TIPO','DIAS ÚTEIS','STATUS','OBS','URGENTE'];

    const cards = entradas.map((entry, idx) => {
      const [modelo, d] = entry;
      const id = 'flcl-grp-' + idx;
      const avg = d.dias.length
        ? Math.round(d.dias.reduce((a,b)=>a+b,0)/d.dias.length)
        : 0;
      const falta = Math.max(0, d.total - d.lab - d.doca);
      const isAtr = d.atr > 0;

      const detailRows = d.items.map(r => {
        const dias = kDias ? parseInt(String(r[kDias]).replace(/\D/g,''),10) : NaN;
        const diasTxt = isNaN(dias) ? '—' : (dias + 'd');
        const diasColor = isNaN(dias) ? 'var(--muted)' :
          (dias > 10 ? 'var(--danger)' : dias > 5 ? 'var(--gold)' : 'var(--accent)');
        const diasWarn = !isNaN(dias) && dias > 10 ? ' ⚠' : '';

        const status = kStatus ? String(r[kStatus]||'').trim() : '';
        const stCls = classifyStatus(status);
        const stBg = stCls === 'lab' ? 'rgba(16,185,129,.12)' :
                     stCls === 'doca' ? 'rgba(59,130,246,.12)' :
                     stCls === 'estoque' ? 'rgba(239,68,68,.12)' : 'var(--bg3)';
        const stColor = stCls === 'lab' ? 'var(--accent)' :
                        stCls === 'doca' ? '#3b82f6' :
                        stCls === 'estoque' ? 'var(--danger)' : 'var(--text)';

        const tipo = kTipo ? String(r[kTipo]||'').trim() : '';
        const tipoBadge = tipo ? `<span style="display:inline-block;background:var(--bg4);
          border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:10px;
          font-weight:700;color:var(--text)">${esc(tipo)}</span>` : '—';

        const cli = kCli ? String(r[kCli]||'').trim() : '—';
        const cliId = kCliId ? String(r[kCliId]||'').trim() : '';
        const cliCell = `<div style="font-size:11px;font-weight:600;color:var(--text);max-width:280px">
          ${esc(cli||'—')}${cliId?` <span style="color:var(--muted);font-weight:500">(${esc(cliId)})</span>`:''}
        </div>`;

        const cust = kCust ? String(r[kCust]||'').trim() : '';
        const tel  = kTel  ? String(r[kTel]||'').trim()  : '';
        const custCell = (cust||tel)
          ? `<div style="font-size:11px;color:var(--text);font-weight:600">${esc(cust||'—')}</div>
             ${tel?`<div style="font-size:10.5px;color:var(--muted);margin-top:2px">${esc(tel)}</div>`:''}`
          : '—';

        const obs = kObs ? String(r[kObs]||'').trim() : '';
        const obsCell = obs
          ? `<div style="max-width:320px;color:var(--text);font-size:10.5px;line-height:1.5">${esc(obs)}</div>`
          : '—';

        const isUrg = kUrg && /sim|true|1|x/i.test(String(r[kUrg]||''));
        const urgBtn = `<button style="background:${isUrg?'rgba(139,92,246,.18)':'var(--bg3)'};
          border:1px solid ${isUrg?'rgba(139,92,246,.5)':'var(--border2)'};
          color:${isUrg?'var(--purple)':'var(--muted)'};border-radius:8px;padding:5px 12px;
          font-size:10.5px;font-weight:700;cursor:pointer">Marcar</button>`;

        const pedido = kPedido ? String(r[kPedido]||'').trim() : '—';

        return `<tr style="transition:background .15s" onmouseover="this.style.background='rgba(148,163,184,.04)'" onmouseout="this.style.background=''">
          <td style="padding:14px 14px;border-bottom:1px solid var(--border);font-size:11.5px;font-weight:600;color:var(--text);font-family:var(--mono)">${esc(pedido||'—')}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border)">${cliCell}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border)">${custCell}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border)">${tipoBadge}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border);font-size:12px;font-weight:700;color:${diasColor};font-family:var(--mono)">${diasTxt}${diasWarn}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border)">
            <span style="display:inline-block;background:${stBg};color:${stColor};
              border:1px solid ${stColor.startsWith('var')?'var(--border2)':stColor};
              border-radius:6px;padding:4px 10px;font-size:10px;font-weight:700;
              text-transform:uppercase;letter-spacing:.04em">${esc(status||'—')}</span>
          </td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border)">${obsCell}</td>
          <td style="padding:14px 14px;border-bottom:1px solid var(--border);text-align:right">${urgBtn}</td>
        </tr>`;
      }).join('');

      const atrBadge = isAtr
        ? `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(245,158,11,.15);
            color:var(--gold);border:1px solid rgba(245,158,11,.45);border-radius:8px;
            padding:4px 10px;font-size:10px;font-weight:800;letter-spacing:.05em">⚠ ATR</span>`
        : '';

      return `
        <div style="background:var(--bg2);border:1px solid ${isAtr?'rgba(245,158,11,.35)':'var(--border2)'};
                    border-radius:14px;margin-bottom:14px;overflow:hidden;
                    ${isAtr?'box-shadow:0 0 0 1px rgba(245,158,11,.08), 0 8px 24px rgba(245,158,11,.05);':''}">
          <div onclick="(function(el){var t=document.getElementById('${id}');var open=t.style.display!=='none';t.style.display=open?'none':'';el.querySelector('.flcl-chev').textContent=open?'▾':'▴';})(this)"
               style="display:flex;align-items:center;gap:16px;padding:16px 20px;cursor:pointer;
                      background:linear-gradient(180deg,var(--bg3),var(--bg2))">
            ${atrBadge}
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:14px">
              <div style="font-size:14px;font-weight:800;color:var(--text);letter-spacing:.01em">
                ${esc(modelo)}
              </div>
              <div style="font-size:11px;color:var(--muted)">Avg: ${avg}d</div>
            </div>
            <div style="display:flex;align-items:center;gap:18px;font-size:11px;font-weight:700">
              <span style="color:var(--muted)">${d.total} Peds</span>
              <span style="color:var(--accent)">Lab:${d.lab}</span>
              <span style="color:#3b82f6">Doca:${d.doca}</span>
              <span style="color:var(--danger)">Falta ${falta}</span>
              <span class="flcl-chev" style="color:var(--muted);font-size:14px;width:14px;text-align:center">▾</span>
            </div>
          </div>
          <div id="${id}" style="display:none;overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;min-width:1100px">
              <thead>
                <tr style="background:var(--bg3)">
                  ${headers.map((h,i) => `<th style="padding:10px 14px;text-align:${i===headers.length-1?'right':'left'};
                    font-size:10px;font-weight:800;letter-spacing:.08em;color:var(--muted);
                    border-bottom:1px solid var(--border2)">${h}</th>`).join('')}
                </tr>
              </thead>
              <tbody>${detailRows}</tbody>
            </table>
          </div>
        </div>`;
    }).join('');

    grid.innerHTML = cards;
    grid.style.overflowX = 'visible';
  }

  // Sobrescreve a função quando ela existir e refaz a render se a aba já estiver aberta.
  function installPatch(){
    if(typeof window.fluxolabRenderChecklistsImported !== 'function'){
      return setTimeout(installPatch, 200);
    }
    window.fluxolabRenderChecklistsImported = newRender;

    // Render imediato se a aba está visível
    const panel = document.getElementById('fluxolab-tab-checklists-panel');
    if(panel && panel.style.display !== 'none') newRender();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', installPatch);
  } else {
    installPatch();
  }
})();
/* ═══════════════════════════════════════════════════════════════════
   PATCH — Busca por SELB: mostra por onde o SELB já passou
   Adicione em index.html APÓS o app.js:
     <script src="patch-busca-selb.js"></script>
   ═══════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  // Tabela de bolsões (igual ao app.js) — usada como fallback se window não expuser
  var BOLSOES_FALLBACK = {
    LIMPEZA:       { label:'Limpeza',             icon:'🧹', color:'#4f8ef7' },
    LINHA_LIMPEZA: { label:'Bolsão Montagem',     icon:'✨', color:'#60a5fa' },
    MONTAGEM:      { label:'Montagem',            icon:'🔧', color:'#3dd68c' },
    COMPLEXA:      { label:'Complexa',            icon:'⚙️', color:'#a78bfa' },
    QUALIDADE:     { label:'Bolsão Qualidade',    icon:'🔬', color:'#f5a623' },
    LIBERADAS:     { label:'Liberados Qualidade', icon:'✅', color:'#10b981' },
    SCRAP:         { label:'Scrap',               icon:'🗑️', color:'#f25757' },
    GAIOLA_LAB:       { label:'Gaiola LAB',          icon:'🪣', color:'#e879f9' },
    GAIOLA_AG_PECAS:  { label:'Gaiola Ag. peças',    icon:'🛠️', color:'#f59e0b' },
    DOCA_1:           { label:'Doca 1',              icon:'📦', color:'#22d3ee' },
  };
  function bolsaoInfo(key){
    var list = (typeof FLUXOLAB_BOLSOES !== 'undefined' && FLUXOLAB_BOLSOES) || [];
    var found = list.find && list.find(function(b){ return b.key === key; });
    if(found) return { label:found.label, icon:found.icon, color:found.color };
    return BOLSOES_FALLBACK[key] || { label:key||'—', icon:'📍', color:'#94a3b8' };
  }

  function fmtTime(ts){
    if(!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'});
  }
  function tempoAgo(ts){
    if(!ts) return '';
    var s = Math.floor((Date.now()-ts)/1000);
    if(s<60) return s+'s atrás';
    var m = Math.floor(s/60); if(m<60) return m+'min atrás';
    var h = Math.floor(m/60); if(h<24) return h+'h atrás';
    var d = Math.floor(h/24); return d+(d===1?' dia atrás':' dias atrás');
  }

  // ── Injeta a caixa de busca abaixo de "Destacar modelo" ─────────
  function injetarBusca(){
    var view = document.getElementById('view-fluxolab');
    if(!view) return false;
    if(document.getElementById('busca-selb-box')) return true;

    var box = document.createElement('div');
    box.id = 'busca-selb-box';
    box.style.cssText = 'background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:14px 18px;margin:12px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    box.innerHTML = ''
      + '<span style="font-size:14px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:6px">'
      +   '<span style="font-size:16px">🔎</span> Buscar SELB:'
      + '</span>'
      + '<input id="busca-selb-input" type="text" placeholder="Digite o código do SELB e pressione Enter..." '
      +   'style="flex:1;min-width:260px;background:var(--bg3);border:1px solid var(--border2);border-radius:9px;'
      +   'color:var(--text);font-family:var(--font);font-size:13px;padding:9px 14px;outline:none">'
      + '<button id="busca-selb-btn" '
      +   'style="background:var(--accent);border:none;border-radius:9px;color:#fff;font-family:var(--font);'
      +   'font-size:13px;font-weight:700;padding:9px 18px;cursor:pointer;transition:opacity .15s">'
      +   'Ver histórico'
      + '</button>'
      + '<span style="font-size:12px;color:var(--muted)">Exibe todos os bolsões por onde o SELB já passou</span>';

    // Inserir logo após o bloco "Destacar modelo" se existir; senão, no topo do view
    var ref = view.querySelector('[id*="destac"], [class*="destac"]');
    var anchor = null;
    // procura o container do "Destacar modelo:"
    var labels = view.querySelectorAll('span, label, div');
    for(var i=0;i<labels.length;i++){
      if((labels[i].textContent||'').trim().toLowerCase().indexOf('destacar modelo')===0){
        // sobe até o container linha
        var n = labels[i];
        while(n && n.parentElement && n.parentElement !== view){ n = n.parentElement; }
        anchor = n; break;
      }
    }
    if(anchor && anchor.parentElement){
      anchor.parentElement.insertBefore(box, anchor.nextSibling);
    } else {
      view.insertBefore(box, view.firstChild);
    }

    var input = document.getElementById('busca-selb-input');
    var btn   = document.getElementById('busca-selb-btn');
    function go(){
      var v = (input.value||'').trim().toUpperCase();
      if(!v){ input.focus(); return; }
      buscarHistorico(v);
    }
    btn.addEventListener('click', go);
    input.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); go(); } });
    return true;
  }

  // ── Busca o histórico no Firebase + bolsão atual em memória ─────
  function buscarHistorico(selb){
    abrirModalLoading(selb);

    var localAtual = '';
    try{
      if(typeof _fluxolabData !== 'undefined' && _fluxolabData){
        Object.entries(_fluxolabData).forEach(function(entry){
          var bolsao = entry[0], items = entry[1];
          if(!items) return;
          Object.values(items).forEach(function(v){
            if(v && v.selb && String(v.selb).trim().toUpperCase() === selb){
              localAtual = bolsao;
            }
          });
        });
      }
    }catch(_){}

    if(typeof firebase === 'undefined' || !firebase.database){
      renderResultado(selb, [], localAtual, 'Firebase indisponível');
      return;
    }

    firebase.database().ref('/fluxolab_log')
      .orderByChild('selb').equalTo(selb)
      .once('value')
      .then(function(snap){
        var arr = [];
        snap.forEach(function(child){
          var v = child.val()||{};
          arr.push({
            ts: v.ts||0,
            de: v.de||'',
            para: v.para||'',
            user: v.user||'',
            equipamento: v.equipamento||''
          });
        });
        arr.sort(function(a,b){ return (a.ts||0) - (b.ts||0); });
        renderResultado(selb, arr, localAtual, null);
      })
      .catch(function(err){
        console.error('[Busca SELB]', err);
        renderResultado(selb, [], localAtual, (err && err.message) || 'Erro ao consultar');
      });
  }

  // Expõe a função globalmente para ser chamada de outros lugares (ex: Relatórios)
  window.buscarHistoricoSelb = buscarHistorico;

  // ── Modal ───────────────────────────────────────────────────────
  function abrirModalLoading(selb){
    fecharModal();
    var ov = document.createElement('div');
    ov.id = 'busca-selb-modal';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)';
    ov.innerHTML = ''
      + '<div style="background:var(--bg2);border:1px solid var(--border2);border-radius:14px;max-width:680px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.6)">'
      +   '<div style="padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px">'
      +     '<div style="display:flex;align-items:center;gap:10px;min-width:0">'
      +       '<span style="font-size:18px">🔎</span>'
      +       '<div style="min-width:0">'
      +         '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:700">Histórico do SELB</div>'
      +         '<div style="font-family:var(--mono);font-size:18px;font-weight:800;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">'+selb+'</div>'
      +       '</div>'
      +     '</div>'
      +     '<button id="busca-selb-close" style="background:transparent;border:1px solid var(--border2);border-radius:8px;color:var(--text);font-size:14px;font-weight:700;padding:6px 12px;cursor:pointer">Fechar</button>'
      +   '</div>'
      +   '<div id="busca-selb-body" style="padding:20px 22px;overflow-y:auto;flex:1">'
      +     '<div style="display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px">'
      +       '<span style="width:16px;height:16px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;display:inline-block"></span>'
      +       'Consultando histórico...'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(ov);
    document.getElementById('busca-selb-close').addEventListener('click', fecharModal);
    ov.addEventListener('click', function(e){ if(e.target === ov) fecharModal(); });
  }
  function fecharModal(){
    var ov = document.getElementById('busca-selb-modal');
    if(ov) ov.remove();
  }

  function renderResultado(selb, eventos, atual, erro){
    var body = document.getElementById('busca-selb-body');
    if(!body) return;

    var html = '';

    if(erro){
      html += '<div style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.4);color:#f25757;border-radius:9px;padding:10px 14px;font-size:13px;margin-bottom:14px">⚠ '+erro+'</div>';
    }

    if(atual){
      var bi = bolsaoInfo(atual);
      html += '<div style="background:rgba(16,185,129,.10);border:1px solid rgba(16,185,129,.4);border-radius:10px;padding:12px 14px;margin-bottom:16px;display:flex;align-items:center;gap:10px">'
        + '<span style="font-size:11px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:.05em">Atualmente em:</span>'
        + '<span style="font-size:18px">'+bi.icon+'</span>'
        + '<span style="font-size:14px;font-weight:700;color:'+bi.color+'">'+bi.label+'</span>'
        + '</div>';
    }

    if(!eventos.length){
      html += '<div style="text-align:center;padding:30px;color:var(--muted);font-size:13px">'
        + (atual ? 'Nenhum movimento registrado no log para este SELB.' : 'SELB não encontrado nos bolsões nem no histórico.')
        + '</div>';
      body.innerHTML = html;
      return;
    }

    html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px">'
      + 'Linha do tempo ('+eventos.length+' movimento'+(eventos.length===1?'':'s')+')'
      + '</div>';

    html += '<div style="position:relative;padding-left:22px;border-left:2px solid var(--border2)">';
    eventos.forEach(function(ev, idx){
      var bDe   = bolsaoInfo(ev.de);
      var bPara = bolsaoInfo(ev.para);
      var ultimo = (idx === eventos.length - 1);
      html += '<div style="position:relative;margin-bottom:14px">'
        + '<span style="position:absolute;left:-29px;top:6px;width:12px;height:12px;border-radius:50%;background:'+bPara.color+';border:2px solid var(--bg2);box-shadow:0 0 0 2px '+bPara.color+'40"></span>'
        + '<div style="background:'+(ultimo?'var(--bg3)':'var(--bg2)')+';border:1px solid '+(ultimo?bPara.color+'66':'var(--border)')+';border-radius:9px;padding:10px 12px">'
        +   '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;font-weight:600;color:var(--text)">'
        +     (ev.de ? '<span style="opacity:.7">'+bDe.icon+' '+bDe.label+'</span><span style="color:var(--muted)">→</span>' : '<span style="opacity:.7;font-size:11px;color:var(--muted)">[entrada]</span>')
        +     '<span style="color:'+bPara.color+'">'+bPara.icon+' '+bPara.label+'</span>'
        +   '</div>'
        +   '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:11px;color:var(--muted)">'
        +     '<span>🕒 '+fmtTime(ev.ts)+' <span style="opacity:.7">('+tempoAgo(ev.ts)+')</span></span>'
        +     (ev.user ? '<span>👤 '+ev.user+'</span>' : '')
        +   '</div>'
        +   (ev.equipamento ? '<div style="margin-top:6px;font-size:11px;color:var(--text);opacity:.85">📦 '+ev.equipamento+'</div>' : '')
        + '</div>'
        + '</div>';
    });
    html += '</div>';

    body.innerHTML = html;
  }

  // ── Inicialização ──────────────────────────────────────────────
  function tentarInjetar(){
    if(injetarBusca()) return;
    setTimeout(tentarInjetar, 600);
  }

  // Observa trocas de aba — sempre que view-fluxolab aparecer, garante a caixa
  function observarView(){
    var obs = new MutationObserver(function(){
      var view = document.getElementById('view-fluxolab');
      if(view && view.offsetParent !== null) injetarBusca();
    });
    obs.observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['style','class'] });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ tentarInjetar(); observarView(); });
  } else {
    tentarInjetar();
    observarView();
  }
})();
/* ═══════════════════════════════════════════════════════════════════
   PATCH — Bipagem de código de peça nas solicitações
   Cole este arquivo após o app.js (ou adicione no patch.js existente)
   ═══════════════════════════════════════════════════════════════════

   O que este patch faz:
   1. Sobrescreve _renderSolicitacoesPanel → cards maiores + campo de bipe
   2. Sobrescreve entregarPeca → salva o código bipado no Firebase
   3. Nova função entregarPecaComCodigo → chamada ao bipar (Enter / blur)
   4. Sobrescreve renderSolicitacoesDoDia → adiciona coluna "Código"
   5. Adiciona <th>Código</th> na tabela via DOM (sem mexer no HTML)
*/


// ── v2: timestamp de boot + set de bipes em andamento (anti-loop / anti-histórico) ──
window._labBootTs = window._labBootTs || Date.now();
window._labBipesEmAndamento = window._labBipesEmAndamento || new Set();
const _LAB_HIST_MS = 10 * 60 * 1000; // 10 min — entregas mais antigas que isso são histórico

// ── 1. Injetar <th>Código</th> na tabela assim que o DOM estiver pronto ──────
(function injetarColunaCodigo(){
  function _inject(){
    const thead = document.querySelector('#view-solicitacoes table.rtbl thead tr');
    if(!thead) return;
    // Evita duplicação
    if(thead.querySelector('th[data-cod-bipe]')) return;
    const th = document.createElement('th');
    th.setAttribute('data-cod-bipe','1');
    th.textContent = 'Código';
    // Inserir antes de "Status" (último th)
    const ths = thead.querySelectorAll('th');
    thead.insertBefore(th, ths[ths.length - 1]);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _inject);
  } else {
    _inject();
    // Fallback: view pode ser renderizada depois
    setTimeout(_inject, 1500);
  }
})();

// ── 2. Sobrescreve _renderSolicitacoesPanel ───────────────────────────────────
// Modelo: 4 BOLSÕES por tempo (5min / 10min / 30min / +1h)
// - Cada bolsão exibe no máx. 3 cards; o restante rola dentro da coluna
// - Cards podem ser arrastados entre bolsões; ao arrastar, ficam TRAVADOS
//   (ignoram o tempo e permanecem no bolsão escolhido até o usuário liberar)
// - Os "locks" persistem em localStorage por id da solicitação

window._BOLSOES_PECAS = [
  { key:'b5',   label:'Até 5 min',   icon:'🟢', color:'#3dd68c', maxMs: 5*60*1000 },
  { key:'b10',  label:'Até 10 min',  icon:'🟡', color:'#eab308', maxMs: 10*60*1000 },
  { key:'b30',  label:'Até 30 min',  icon:'🟠', color:'#f59e0b', maxMs: 30*60*1000 },
  { key:'b60',  label:'+1 hora',     icon:'🔴', color:'#ef4444', maxMs: Infinity }
];

window._bolsaoLocks = (function(){
  try { return JSON.parse(localStorage.getItem('_bolsaoLocks_v1')||'{}'); }
  catch(e){ return {}; }
})();
window._saveBolsaoLocks = function(){
  try { localStorage.setItem('_bolsaoLocks_v1', JSON.stringify(window._bolsaoLocks||{})); }
  catch(e){}
};
window._bucketByAge = function(ageMs){
  for (var i=0;i<window._BOLSOES_PECAS.length;i++){
    if (ageMs <= window._BOLSOES_PECAS[i].maxMs) return window._BOLSOES_PECAS[i].key;
  }
  return 'b60';
};

window._bolsaoDragStart = function(ev, groupKey){
  try { ev.dataTransfer.setData('text/plain', groupKey); ev.dataTransfer.effectAllowed='move'; } catch(e){}
  ev.currentTarget && ev.currentTarget.classList.add('drag-ghost');
};
window._bolsaoDragEnd = function(ev){
  ev.currentTarget && ev.currentTarget.classList.remove('drag-ghost');
};
window._bolsaoDragOver = function(ev){ ev.preventDefault(); try{ ev.dataTransfer.dropEffect='move'; }catch(e){} };
window._bolsaoDrop = function(ev, targetBolsao){
  ev.preventDefault();
  var groupKey = ev.dataTransfer.getData('text/plain');
  if(!groupKey) return;
  window._bolsaoLocks[groupKey] = targetBolsao;
  window._saveBolsaoLocks();
  if(document.getElementById('view-pecas')?.classList.contains('active')) window._renderSolicitacoesPanel('pecas-solicitacoes-panel','');
  if(document.getElementById('subview-pecas-a')?.style.display !== 'none') window._renderSolicitacoesPanel('pecas-a-solicitacoes-panel','');
};
window._bolsaoUnlock = function(groupKey){
  delete window._bolsaoLocks[groupKey];
  window._saveBolsaoLocks();
  if(document.getElementById('view-pecas')?.classList.contains('active')) window._renderSolicitacoesPanel('pecas-solicitacoes-panel','');
  if(document.getElementById('subview-pecas-a')?.style.display !== 'none') window._renderSolicitacoesPanel('pecas-a-solicitacoes-panel','');
};

// CSS dos bolsões
(function(){
  if(document.getElementById('bolsoes-css')) return;
  var st = document.createElement('style');
  st.id = 'bolsoes-css';
  st.textContent =
    '.bolsao-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}'+
    '.bolsao-col{background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px;display:flex;flex-direction:column;min-height:200px;transition:background .15s}'+
    '.bolsao-col.drop-hover{background:rgba(61,214,140,.06);border-color:rgba(61,214,140,.4)}'+
    '.bolsao-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 4px 10px;border-bottom:1px solid rgba(255,255,255,.06);margin-bottom:8px}'+
    '.bolsao-title{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700}'+
    '.bolsao-count{background:rgba(255,255,255,.08);border-radius:12px;font-size:10px;font-weight:800;padding:2px 8px;color:#cbd5e1}'+
    '.bolsao-list{display:flex;flex-direction:column;gap:8px;max-height:560px;overflow-y:auto;padding-right:4px;scrollbar-width:thin}'+
    '.bolsao-list::-webkit-scrollbar{width:6px}'+
    '.bolsao-list::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px}'+
    '.bolsao-card{background:var(--bg2);border:1px solid rgba(245,166,35,.4);border-left:4px solid var(--warn);border-radius:12px;padding:12px;cursor:grab;transition:transform .12s,box-shadow .12s}'+
    '.bolsao-card:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,.35)}'+
    '.bolsao-card.locked{border-style:dashed;border-color:rgba(96,165,250,.55);box-shadow:inset 0 0 0 1px rgba(96,165,250,.15)}'+
    '.bolsao-card.drag-ghost{opacity:.45}'+
    '.bolsao-lock-btn{background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.45);border-radius:6px;color:#93c5fd;font-size:10px;font-weight:700;padding:2px 8px;cursor:pointer}';
  document.head.appendChild(st);
})();

// ── Helper: decodifica observação de cor de toner ────────────────────────────
// Entrada: string de obs (ex: "Y", "M", "BK", "C")
// Retorna: objeto { label, color, bg, emoji } ou null se não for código de toner
window._tonerCorInfo = function(obs){
  if(!obs) return null;
  var map = {
    'Y':   { label: 'Yellow · Amarelo', color: '#eab308', bg: 'rgba(234,179,8,.18)',   emoji: '🟡' },
    'M':   { label: 'Magenta',          color: '#ec4899', bg: 'rgba(236,72,153,.18)',  emoji: '🟣' },
    'C':   { label: 'Ciano',            color: '#22d3ee', bg: 'rgba(34,211,238,.18)',  emoji: '🔵' },
    'BK':  { label: 'Black · Preto',    color: '#94a3b8', bg: 'rgba(148,163,184,.15)', emoji: '⚫' },
    'K':   { label: 'Black · Preto',    color: '#94a3b8', bg: 'rgba(148,163,184,.15)', emoji: '⚫' },
    'B':   { label: 'Black · Preto',    color: '#94a3b8', bg: 'rgba(148,163,184,.15)', emoji: '⚫' },
  };
  var key = obs.trim().toUpperCase().replace(/\s+/g,'');
  return map[key] || null;
};

window._renderSolicitacoesPanel = function(panelId, q){
  var panel = document.getElementById(panelId);
  if(!panel) return;

  var todas = Object.entries(_solicitacoesPecas || {});
  var pendentes = todas
    .filter(function(e){ return !e[1].lida; })
    .filter(function(e){
      var p = e[1];
      return !q || (p.selb||'').toUpperCase().includes(q) || (p.nome||'').toUpperCase().includes(q);
    })
    .sort(function(a,b){ return (a[1].ts||0) - (b[1].ts||0); }); // crescente: mais antigo primeiro

  if(!pendentes.length){
    panel.style.display = 'none';
    return;
  }

  var isAdmin = currentUser && currentUser.isAdmin;
  panel.style.display = 'block';

  var marcarTodasBtn = isAdmin
    ? '<button onclick="marcarTodasPecasLidas()" style="background:rgba(61,214,140,.1);border:1px solid rgba(61,214,140,.35);border-radius:8px;color:var(--accent2);font-family:var(--font);font-size:11px;font-weight:600;padding:5px 12px;cursor:pointer">✓ Marcar todas como lidas</button>'
    : '';

  // Agrupar por SELB + UID — minTs = quando o grupo apareceu pela 1ª vez (ordem de entrada)
  var groups = {};
  pendentes.forEach(function(entry){
    var p = entry[1];
    var key = (p.selb || 'SN') + '_' + (p.uid || '');
    if(!groups[key]) groups[key] = { items:[], maxTs:0, minTs: p.ts||0 };
    groups[key].items.push(entry);
    if((p.ts||0) > groups[key].maxTs) groups[key].maxTs = p.ts||0;
    if((p.ts||0) < groups[key].minTs) groups[key].minTs = p.ts||0;
  });

  // Bucket por idade (ou lock manual)
  var now = Date.now();
  var byBolsao = {}; window._BOLSOES_PECAS.forEach(function(b){ byBolsao[b.key]=[]; });
  Object.keys(groups).forEach(function(gk){
    var g = groups[gk];
    var locked = window._bolsaoLocks[gk];
    var bk = locked || window._bucketByAge(now - g.maxTs);
    if(!byBolsao[bk]) bk = 'b60';
    byBolsao[bk].push({ key: gk, group: g, locked: !!locked });
  });
  // Ordenar cada bolsão por minTs crescente → card mais antigo permanece fixo no topo
  Object.keys(byBolsao).forEach(function(bk){
    byBolsao[bk].sort(function(a,b){ return (a.group.minTs||0) - (b.group.minTs||0); });
  });

  function renderCard(entry){
    var gk         = entry.key;
    var groupItems = entry.group.items;
    var first      = groupItems[0][1];
    var selb       = first.selb || '—';
    var tempoAtras = _tempoAtras(entry.group.maxTs);
    var lockedCls  = entry.locked ? ' locked' : '';
    var lockBtn    = entry.locked
      ? '<button class="bolsao-lock-btn" onclick="event.stopPropagation();window._bolsaoUnlock(\''+gk.replace(/'/g,"\\'")+'\')">🔒 travado · liberar</button>'
      : '';

    var itemsHtml = groupItems.map(function(en){
      var id  = en[0];
      var p   = en[1];
      var safeSelb = (selb||'').replace(/'/g,'');
      var safeId   = id.replace(/'/g,'');

      var qtdLabel = (p.quantidade > 1)
        ? '<span style="background:rgba(245,166,35,.3);color:var(--warn);border-radius:6px;font-size:10px;font-weight:800;padding:1px 7px;margin-left:4px">x' + p.quantidade + '</span>'
        : '';
      var obsHtml = (function(){
        if(!p.obs) return '';
        var cor = window._tonerCorInfo(p.obs);
        if(cor){
          return '<div style="display:inline-flex;align-items:center;gap:5px;margin-top:6px;'
            + 'background:' + cor.bg + ';border:1px solid ' + cor.color + '55;border-radius:7px;padding:3px 9px">'
            + '<span style="font-size:12px">' + cor.emoji + '</span>'
            + '<span style="font-size:12px;font-weight:800;color:' + cor.color + '">' + p.obs.trim().toUpperCase() + '</span>'
            + '<span style="font-size:11px;color:' + cor.color + ';opacity:.9">= ' + cor.label + '</span>'
            + '</div>';
        }
        return '<div style="font-size:10px;color:var(--muted);font-style:italic;margin-top:4px">"' + p.obs + '"</div>';
      })();

      var btnHtml = isAdmin ? (
        '<div style="display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap" onmousedown="event.stopPropagation()">'
          + '<input id="bipe-' + safeId + '" type="text" placeholder="🔍 Bipe o código..." '
            + 'onmousedown="event.stopPropagation()" '
            + 'style="flex:1;min-width:120px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:var(--text);font-family:var(--font);font-size:12px;padding:6px 10px;outline:none" '
            + 'onkeydown="if(event.key===\'Enter\'){ event.preventDefault(); window.entregarPecaComCodigo(\'' + safeId + '\',\'' + safeSelb + '\'); }" />'
          + '<button onclick="event.stopPropagation();window.entregarPecaComCodigo(\'' + safeId + '\',\'' + safeSelb + '\')" '
            + 'style="background:rgba(61,214,140,.12);border:1px solid rgba(61,214,140,.45);border-radius:8px;color:var(--accent2);font-size:11px;font-weight:700;padding:6px 12px;cursor:pointer;white-space:nowrap">✓ Entregar</button>'
          + '<button onclick="event.stopPropagation();removerSolicitacaoPeca(\'' + safeId + '\',\'' + safeSelb + '\')" '
            + 'style="background:rgba(242,87,87,.1);border:1px solid rgba(242,87,87,.4);border-radius:8px;color:var(--danger);font-size:12px;font-weight:700;padding:6px 10px;cursor:pointer">×</button>'
        + '</div>'
      ) : '';

      return '<div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 10px;margin-top:6px">'
        + '<div style="display:flex;align-items:center;gap:6px">'
          + '<span style="font-size:13px">🔩</span>'
          + '<span style="font-size:12px;font-weight:700;color:var(--warn)">' + (p.peca||'—') + qtdLabel + '</span>'
        + '</div>'
        + obsHtml
        + btnHtml
      + '</div>';
    }).join('');

    return '<div class="bolsao-card'+lockedCls+'" draggable="true" '
      + 'ondragstart="window._bolsaoDragStart(event,\''+gk.replace(/'/g,"\\'")+'\')" '
      + 'ondragend="window._bolsaoDragEnd(event)">'
      + '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">'
        + '<div>'
          + '<div style="display:flex;align-items:center;gap:6px">'
            + '<div style="font-family:var(--mono);font-weight:800;color:var(--accent);font-size:15px">' + selb + '</div>'
            + '<button data-selb="' + selb.replace(/"/g,'&quot;') + '" onmousedown="event.stopPropagation()" onclick="event.stopPropagation();window._copiarSelb(this.dataset.selb,this)" title="Copiar SELB" style="background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:5px;color:var(--muted);font-size:10px;font-weight:700;padding:2px 7px;cursor:pointer;line-height:1;flex-shrink:0;transition:all .15s">⎘</button>'
          + '</div>'
          + '<div style="font-size:11px;color:var(--text);font-weight:600;margin-top:2px">' + (first.nome||'—') + ' <span style="color:var(--muted);font-weight:400">· ' + (first.setor||'—') + '</span></div>'
          + (first.equipamento ? '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + first.equipamento + '</div>' : '')
        + '</div>'
        + '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">'
          + '<span style="font-size:10px;color:var(--muted);background:var(--bg3);padding:2px 7px;border-radius:6px;white-space:nowrap">⏱ ' + tempoAtras + '</span>'
          + lockBtn
        + '</div>'
      + '</div>'
      + itemsHtml
    + '</div>';
  }

  var colsHtml = window._BOLSOES_PECAS.map(function(b){
    var arr = byBolsao[b.key] || [];
    var visible = arr.slice(0, 3);    // mostra 3; o restante fica acessível pelo scroll
    var listHtml = arr.map(renderCard).join('') || '<div style="font-size:11px;color:var(--muted);text-align:center;padding:14px 0;opacity:.6">Vazio</div>';
    return '<div class="bolsao-col" '
      + 'ondragover="window._bolsaoDragOver(event);this.classList.add(\'drop-hover\')" '
      + 'ondragleave="this.classList.remove(\'drop-hover\')" '
      + 'ondrop="this.classList.remove(\'drop-hover\');window._bolsaoDrop(event,\''+b.key+'\')">'
      + '<div class="bolsao-head">'
        + '<div class="bolsao-title" style="color:'+b.color+'">'+b.icon+' '+b.label+'</div>'
        + '<span class="bolsao-count">'+arr.length+(arr.length>3?' · rolar':'')+'</span>'
      + '</div>'
      + '<div class="bolsao-list">'+listHtml+'</div>'
    + '</div>';
  }).join('');

  // ── Preserva scroll entre re-renders rápidos (ex: 2 escritas Firebase na entrega) ──
  // Salva posições só na PRIMEIRA chamada de um lote; o rAF restaura uma única vez.
  if (!window._bolsaoRafPending) window._bolsaoRafPending = {};
  if (!window._bolsaoScrollSave) window._bolsaoScrollSave = {};

  if (!window._bolsaoRafPending[panelId]) {
    // Primeira chamada: captura posições reais antes de qualquer re-render do lote
    panel.querySelectorAll('.bolsao-list').forEach(function(el, i){
      var k = panelId + '_' + i;
      if (el.scrollTop > 0) window._bolsaoScrollSave[k] = el.scrollTop;
      else delete window._bolsaoScrollSave[k];
    });
    window._bolsaoRafPending[panelId] = true;
    requestAnimationFrame(function(){
      window._bolsaoRafPending[panelId] = false;
      var p = document.getElementById(panelId);
      if (!p) return;
      p.querySelectorAll('.bolsao-list').forEach(function(el, i){
        var saved = window._bolsaoScrollSave[panelId + '_' + i];
        if (saved) el.scrollTop = saved;
      });
    });
  }

  panel.innerHTML = ''
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">'
      + '<div style="display:flex;align-items:center;gap:8px">'
        + '<span style="font-size:16px">🔔</span>'
        + '<span style="font-size:14px;font-weight:700;color:var(--warn)">Solicitações de Peças Pendentes</span>'
        + '<span style="background:var(--warn);color:#000;border-radius:20px;font-size:11px;font-weight:800;padding:2px 9px">' + pendentes.length + '</span>'
        + '<span style="font-size:10px;color:var(--muted);margin-left:4px">arraste para travar em outro bolsão</span>'
      + '</div>'
      + marcarTodasBtn
    + '</div>'
    + '<div class="bolsao-grid">' + colsHtml + '</div>';
};

// Tick para reclassificar conforme o tempo avança
if(!window._bolsoesTick){
  window._bolsoesTick = setInterval(function(){
    if(typeof window._renderSolicitacoesPanel !== 'function') return;
    if(document.getElementById('view-pecas')?.classList.contains('active')) window._renderSolicitacoesPanel('pecas-solicitacoes-panel','');
    if(document.getElementById('subview-pecas-a')?.style.display !== 'none') window._renderSolicitacoesPanel('pecas-a-solicitacoes-panel','');
  }, 30000);
}

// ── helper: popup modal bonito ────────────────────────────────────────────────
window._labPopup = function(titulo, htmlMsg, tipo) {
  var old = document.getElementById('lbpop');
  if (old) old.remove();
  var cores = {
    ok:    { borda: '#4ade80', bg: 'rgba(74,222,128,.13)', icone: '✅' },
    erro:  { borda: '#f87171', bg: 'rgba(248,113,113,.13)', icone: '❌' },
    aviso: { borda: '#f5a623', bg: 'rgba(245,166,35,.13)',  icone: '⚠️' }
  };
  var c = cores[tipo] || cores.aviso;
  if (!document.getElementById('lbpop-css')) {
    var st = document.createElement('style');
    st.id = 'lbpop-css';
    st.textContent = '@keyframes lbfade{from{opacity:0}to{opacity:1}} @keyframes lbslide{from{transform:translateY(28px);opacity:0}to{transform:none;opacity:1}}';
    document.head.appendChild(st);
  }
  var ov = document.createElement('div');
  ov.id = 'lbpop';
  ov.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(5px);animation:lbfade .2s ease';
  ov.innerHTML = '<div style="background:#1a1f2e;border:2px solid ' + c.borda + ';border-radius:18px;padding:32px 36px;max-width:440px;width:90%;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.6);animation:lbslide .25s ease">'
    + '<div style="font-size:54px;margin-bottom:10px">' + c.icone + '</div>'
    + '<div style="font-size:19px;font-weight:800;color:' + c.borda + ';margin-bottom:10px">' + titulo + '</div>'
    + '<div style="font-size:13px;color:#ccc;line-height:1.7;margin-bottom:24px">' + htmlMsg + '</div>'
    + '<button onclick="document.getElementById(\"lbpop\").remove()" style="background:' + c.bg + ';border:1px solid ' + c.borda + ';border-radius:10px;color:' + c.borda + ';font-size:14px;font-weight:700;padding:10px 36px;cursor:pointer">OK</button>'
    + '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', function(e){ if(e.target === ov) ov.remove(); });
  setTimeout(function(){ if(ov.parentNode) ov.remove(); }, 2000);
};

// ── 3. entregarPecaComCodigo — Firebase + Supabase direto + popup resultado ──
//      v2: 3 guardas (histórico / já processado / concorrência)
window.entregarPecaComCodigo = async function(id, selb) {
  var inputEl = document.getElementById('bipe-' + id);
  var codigo  = inputEl ? inputEl.value.trim() : '';

  // GUARDA 0 — Concorrência (duplo Enter / duplo clique)
  if(window._labBipesEmAndamento.has(id)){
    console.log('[LabTech] Bipe já em andamento para', id);
    return;
  }

  if (!codigo) {
    var ok = confirm('Nenhum codigo foi bipado para o SELB ' + selb + '.\nDeseja confirmar a entrega mesmo assim?\n\n(Sem codigo a baixa no estoque NAO sera feita)');
    if (!ok) { if (inputEl) inputEl.focus(); return; }
  }

  if (!window._db) {
    window._labPopup('Firebase desconectado', 'Recarregue a pagina e tente novamente.', 'erro');
    return;
  }

  // Lê o registro ANTES de qualquer escrita para aplicar guardas
  var recAtual = null;
  try{
    var preSnap = await window._db.ref('/solicitacoes_pecas/' + id).once('value');
    recAtual = preSnap.val() || {};
  }catch(e){
    window._labPopup('Erro ao ler solicitação', String(e.message||e), 'erro');
    return;
  }

  // GUARDA 1 — Histórico: registro anterior ao boot - 10 min NÃO dá baixa
  var refTs = Number(recAtual.entregueTs || recAtual.ts || 0);
  if(refTs && refTs < (window._labBootTs - _LAB_HIST_MS)){
    window._labPopup(
      'Solicitação histórica',
      'Esta solicitação é anterior ao carregamento da página e <b>não dá baixa automática</b> no estoque do Pietro.<br><br>' +
      'Se precisar registrar baixa retroativa, faça direto no sistema do Pietro.',
      'aviso'
    );
    return;
  }

  // GUARDA 2 — Já processado: mostra resultado anterior, NÃO chama Supabase de novo
  if(recAtual._supabaseBaixa){
    var sb = recAtual._supabaseBaixa;
    if(sb.ok){
      window._labPopup(
        'Já baixado',
        'Esta entrega <b>já teve baixa confirmada</b> no estoque do Pietro.<br><br>' +
        'Código: <b style="color:#4ade80">' + ((sb.payload && sb.payload.p_code) || '—') + '</b>',
        'aviso'
      );
    } else {
      var errAnt = sb.erro || (sb.resposta && (sb.resposta.error || sb.resposta.message)) || 'Erro anterior';
      window._labPopup(
        'Já tentado (com erro)',
        'Esta entrega já foi tentada e <b>falhou</b>. Para refazer, peça a um admin rodar no console:<br><br>' +
        '<code style="font-size:11px;background:rgba(0,0,0,.3);padding:3px 8px;border-radius:5px">baixarNoSupabaseManual(\'' + id + '\')</code><br><br>' +
        '<span style="color:#fca5a5;font-size:12px">Último erro: ' + errAnt + '</span>',
        'aviso'
      );
    }
    return;
  }

  // ── Tudo OK, processa ────────────────────────────────────────────────
  window._labBipesEmAndamento.add(id);
  if (inputEl) inputEl.disabled = true;
  var btns = inputEl ? inputEl.closest('div').querySelectorAll('button') : [];
  btns.forEach(function(b){ b.disabled = true; });

  // Helper: reabilita o card para nova tentativa (NAO remove da lista)
  function _reabilitarCard(){
    if (inputEl) {
      inputEl.disabled = false;
      inputEl.style.borderColor = '';
      try { inputEl.focus(); inputEl.select(); } catch(_){}
    }
    btns.forEach(function(b){ b.disabled = false; });
  }

  try {
    // Caso sem codigo: confirma entrega manual (marca como lida, sem Supabase)
    if (!codigo) {
      await window._db.ref('/solicitacoes_pecas/' + id).update({
        lida:       true,
        entregueTs: Date.now(),
        codigoBipe: null
      });
      if (inputEl) {
        inputEl.style.borderColor = 'rgba(61,214,140,.8)';
        inputEl.value = 'entregue';
      }
      window._labPopup('Entrega Registrada',
        'A entrega foi confirmada para o SELB <b>' + selb + '</b>.<br><br>' +
        '<span style="color:#fbbf24">Nenhum codigo foi bipado, portanto a baixa no estoque do Pietro NAO foi realizada.</span>',
        'aviso');
      return;
    }

    function _setor(raw) {
      var s = String(raw || '').toUpperCase().trim();
      if (s.includes('REMANU')) return 'REMANU';
      if (s.includes('3D'))     return '3D';
      return 'LAB';
    }

    var payload = {
      p_code:  codigo.trim().toUpperCase(),
      p_qty:   Math.max(1, parseInt(recAtual.quantidade, 10) || 1),
      p_selb:  String(recAtual.selb || selb || '').trim().toUpperCase(),
      p_setor: _setor(recAtual.setor)
    };

    console.log('[LabTech] Chamando Supabase...', payload);

    var SUPA_URL = ['https://idpmr','jjalhnpsxpfug','ph.supabase.co'].join('');
    var SUPA_KEY = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6','ImlkcG1yamphbGhucHN4cGZ1Z3BoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjU2N','jcsImV4cCI6MjA5MzI0MTY2N30.L4hV7YM9yjdOOW9zBl84L-1si2DU8nBI3J1WgmW02lY'].join('');

    var res = await fetch(SUPA_URL + '/rest/v1/rpc/registrar_baixa_integracao', {
      method:  'POST',
      headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    var data = null;
    try { data = await res.json(); } catch(_) {}

    if (!res.ok || (data && data.success === false)) {
      // ERRO / SEM SALDO — NAO marca como lida, mantem o card na lista para nova tentativa
      var errMsg = (data && (data.message || data.error || data.hint)) || ('HTTP ' + res.status);
      console.error('[LabTech] Supabase erro:', errMsg, data);
      _reabilitarCard();
      window._labPopup(
        'Erro no Estoque!',
        'A baixa <b>NAO</b> foi realizada no sistema do Pietro.<br><br>' +
        '<span style="font-family:monospace;font-size:12px;background:rgba(0,0,0,.3);padding:4px 10px;border-radius:6px;display:inline-block;color:#fca5a5">' + errMsg + '</span>',
        'erro'
      );
    } else {
      // SUCESSO — agora sim marca como lida e salva o codigo bipado
      console.log('[LabTech] Supabase OK:', data);
      try {
        await window._db.ref('/solicitacoes_pecas/' + id).update({
          lida:       true,
          entregueTs: Date.now(),
          codigoBipe: codigo
        });
      } catch(_){}
      try { await window._db.ref('/solicitacoes_pecas/' + id + '/_supabaseBaixa').set({ ok: true, ts: Date.now(), payload: payload, resposta: data || null }); } catch(_) {}
      if (inputEl) {
        inputEl.style.borderColor = 'rgba(61,214,140,.8)';
        inputEl.value = codigo;
      }
      // Após sucesso: focar no próximo input de bipe do MESMO card (mesmo SELB)
      try {
        if (inputEl) {
          var card = inputEl.closest('div[style*="border-left"]') || inputEl.closest('div');
          // procura próximo input bipe-* no mesmo card que ainda não foi entregue
          var proximo = null;
          if (card) {
            var inputs = card.querySelectorAll('input[id^="bipe-"]');
            for (var i = 0; i < inputs.length; i++) {
              var inp = inputs[i];
              if (inp !== inputEl && !inp.disabled) { proximo = inp; break; }
            }
          }
          if (proximo) {
            setTimeout(function(){ try { proximo.focus(); proximo.select(); } catch(_){} }, 50);
          }
        }
      } catch(_){}
      window._labPopup(
        'Baixa Realizada!',
        'Codigo <b style="color:#4ade80">' + codigo + '</b> baixado com sucesso no estoque do Pietro.<br><br>' +
        'SELB: <b>' + (recAtual.selb || selb) + '</b> &nbsp;|&nbsp; Peca: <b>' + (recAtual.peca || 'ignorado') + '</b> &nbsp;|&nbsp; Qtd: <b>' + payload.p_qty + '</b>',
        'ok'
      );
    }

  } catch (e) {
    // FALHA DE REDE — NAO marca como lida, mantem o card para nova tentativa
    console.error('[LabTech] Erro geral:', e);
    _reabilitarCard();
    window._labPopup(
      'Erro de Conexao',
      'Nao foi possivel conectar ao sistema do Pietro.<br><br>' +
      '<span style="font-size:12px;color:#fca5a5">' + String(e.message || e) + '</span><br><br>' +
      '<span style="font-size:11px;color:var(--muted)">Bipe novamente para tentar de novo.</span>',
      'erro'
    );
  } finally {
    window._labBipesEmAndamento.delete(id);
  }
};

// ── 4. Mantém entregarPeca original como alias (usado em outros lugares) ──────
window.entregarPeca = async function(id, selb){
  // Tenta usar o novo fluxo com input de bipe se ele existir na tela
  var inputEl = document.getElementById('bipe-' + id);
  if(inputEl){
    window.entregarPecaComCodigo(id, selb);
    return;
  }
  // Fallback original sem campo de bipe
  if(!confirm('Confirmar entrega da peça para o SELB ' + selb + '?\n\nO registro será mantido no histórico.')) return;
  try {
    await window._db.ref('/solicitacoes_pecas/' + id).update({ lida: true, entregueTs: Date.now() });
  } catch(e){
    alert('Erro ao confirmar entrega.');
    console.error('entregarPeca error:', e);
  }
};

// ── 5. Sobrescreve renderSolicitacoesDoDia → linha por peça + coluna Código ───
window.renderSolicitacoesDoDia = function(){
  const tbody = document.getElementById('solicitacoes-dia-body');
  if(!tbody) return;

  // Garante cabeçalhos corretos (substitui thead inteiro para evitar duplicação)
  const thead = document.querySelector('#view-solicitacoes table.rtbl thead tr');
  if(thead && !thead.querySelector('th[data-sol-patch]')){
    thead.innerHTML = `
      <th>Hora</th>
      <th>SELB</th>
      <th>Equipamento</th>
      <th>Profissional</th>
      <th>Peça</th>
      <th>Qtd</th>
      <th>Observação</th>
      <th data-sol-patch="1">Código</th>
      <th>Status</th>
    `;
  }

  const q       = (document.getElementById('solicitacoes-search').value||'').toUpperCase();
  const dFrom   = document.getElementById('solicitacoes-date-from').value;
  const dTo     = document.getElementById('solicitacoes-date-to').value;
  const modFilt = (document.getElementById('solicitacoes-model').value || '').toUpperCase();

  if(!dFrom || !dTo) return;

  const startTs = new Date(dFrom + 'T00:00:00').getTime();
  const endTs   = new Date(dTo   + 'T23:59:59').getTime();

  const todas    = Object.values(_solicitacoesPecas || {});
  const filtered = todas.filter(p => {
    const dataOk  = p.ts && p.ts >= startTs && p.ts <= endTs;
    const modelOk = !modFilt || (p.equipamento||'').toUpperCase().includes(modFilt);
    const match   = !q || (p.selb||'').includes(q) || (p.nome||'').toUpperCase().includes(q) || (p.peca||'').toUpperCase().includes(q);
    return dataOk && modelOk && match;
  }).sort((a,b) => (b.ts||0) - (a.ts||0));

  if(!filtered.length){
    tbody.innerHTML = `<tr><td colspan="9" class="empty">Nenhuma solicitação encontrada neste período.</td></tr>`;
    _renderSolicitacoesStats([]);
    return;
  }

  // Agrupar por SELB + UID + DATA
  const groups = {};
  filtered.forEach(p => {
    const key = (p.selb||'SN') + '_' + (p.uid||'') + '_' + new Date(p.ts).toDateString();
    if(!groups[key]) groups[key] = [];
    groups[key].push(p);
  });

  // Ordenar grupos pelo ts mais recente
  const sortedKeys = Object.keys(groups).sort((a,b) => {
    const maxA = Math.max(...groups[a].map(x => x.ts||0));
    const maxB = Math.max(...groups[b].map(x => x.ts||0));
    return maxB - maxA;
  });

  tbody.innerHTML = sortedKeys.map(key => {
    const items  = groups[key];
    const first  = items[0];
    const rowspan = items.length;

    // Células compartilhadas (mescladas via rowspan)
    const hora = `${new Date(first.ts).toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit'})} ${new Date(first.ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}`;
    const todosLidos  = items.every(it => it.lida);
    const statusClass = todosLidos ? 'bok' : 'bpec';
    const statusLabel = todosLidos ? 'Entregue' : 'Pendente';

    const sharedCells = `
      <td rowspan="${rowspan}" style="font-family:var(--mono);font-size:12px;color:var(--muted);vertical-align:top;padding-top:10px">${hora}</td>
      <td rowspan="${rowspan}" style="font-family:var(--mono);font-weight:700;color:var(--accent);font-size:14px;vertical-align:top;padding-top:10px">${first.selb||'—'}</td>
      <td rowspan="${rowspan}" style="font-size:11px;color:var(--muted);vertical-align:top;padding-top:10px;max-width:160px;white-space:normal;line-height:1.4">${first.equipamento||'—'}</td>
      <td rowspan="${rowspan}" style="vertical-align:top;padding-top:10px;white-space:nowrap">${first.nome||'—'} <span style="font-size:10px;color:var(--muted)">· ${first.setor||'—'}</span></td>
    `;

    const statusCell = `
      <td rowspan="${rowspan}" style="vertical-align:top;padding-top:10px">
        <span class="badge ${statusClass}">${statusLabel}</span>
      </td>
    `;

    return items.map((it, idx) => {
      const qtd = parseInt(it.quantidade)||1;

      // Badge da peça
      const pecaCell = `<span style="background:rgba(245,166,35,.15);color:var(--warn);border-radius:6px;font-size:11px;font-weight:700;padding:3px 9px;display:inline-block">${it.peca||'—'}</span>`;

      // Código bipado
      const cod = it.codigoBipe && it.codigoBipe.trim();
      let codigoCell = cod
        ? `<span style="font-family:var(--mono);font-size:11px;background:rgba(61,214,140,.12);color:var(--accent2);border-radius:6px;padding:3px 9px;white-space:nowrap">${cod}</span>`
        : `<span style="color:var(--muted);font-size:11px">—</span>`;

      // Status do Supabase anexado abaixo do código
      if (it._supabaseBaixa) {
        if (it._supabaseBaixa.ok) {
          codigoCell += `<br><span style="font-size:10px;color:#4ade80;margin-top:4px;display:inline-block" title="Baixa confirmada no Supabase">✅ Baixa OK</span>`;
        } else {
          const errMsg = (it._supabaseBaixa.resposta && it._supabaseBaixa.resposta.error) || it._supabaseBaixa.erro || 'Erro';
          codigoCell += `<br><span style="font-size:10px;color:#f87171;margin-top:4px;display:inline-block" title="${errMsg}">❌ ${errMsg.length > 20 ? errMsg.substring(0, 20) + '...' : errMsg}</span>`;
        }
      }

      // Obs — com decodificação de cor de toner
      const obsCell = (function(){
        if(!it.obs) return '<span style="color:var(--muted);font-size:11px">—</span>';
        const cor = window._tonerCorInfo(it.obs);
        if(cor){
          return '<span style="display:inline-flex;align-items:center;gap:4px;'
            + 'background:' + cor.bg + ';border:1px solid ' + cor.color + '55;border-radius:6px;padding:2px 8px">'
            + '<span style="font-size:11px">' + cor.emoji + '</span>'
            + '<span style="font-size:11px;font-weight:800;color:' + cor.color + '">' + it.obs.trim().toUpperCase() + '</span>'
            + '<span style="font-size:10px;color:' + cor.color + ';opacity:.85">= ' + cor.label + '</span>'
            + '</span>';
        }
        return '<span style="font-size:11px;color:var(--muted);font-style:italic">' + it.obs + '</span>';
      })();

      // Separador visual entre peças do mesmo grupo
      const borderTop = idx > 0 ? 'border-top:1px dashed rgba(255,255,255,0.06)' : '';

      if(idx === 0){
        // Primeira linha do grupo: inclui células mescladas + status
        return `<tr style="cursor:pointer;${borderTop}" onclick="abrirDetalhesSolicitacaoDia('${key}')">
          ${sharedCells}
          <td style="${borderTop}">${pecaCell}</td>
          <td style="font-family:var(--mono);font-weight:700;color:var(--warn);${borderTop}">${qtd}</td>
          <td style="${borderTop}">${obsCell}</td>
          <td style="${borderTop}">${codigoCell}</td>
          ${statusCell}
        </tr>`;
      } else {
        // Linhas seguintes do grupo: só colunas de peça
        return `<tr style="cursor:pointer;${borderTop}" onclick="abrirDetalhesSolicitacaoDia('${key}')">
          <td style="${borderTop}">${pecaCell}</td>
          <td style="font-family:var(--mono);font-weight:700;color:var(--warn);${borderTop}">${qtd}</td>
          <td style="${borderTop}">${obsCell}</td>
          <td style="${borderTop}">${codigoCell}</td>
        </tr>`;
      }
    }).join('');
  }).join('');

  _renderSolicitacoesStats(filtered);
};


// ── 6. Adiciona Bolsão Eletrônica ao FluxoLAB (movimentação apenas manual) ───
(function adicionarBolsaoEletronica(){
  // Aguarda FLUXOLAB_BOLSOES estar disponível
  function _inject(){
    if(typeof FLUXOLAB_BOLSOES === 'undefined') { setTimeout(_inject, 500); return; }

    // Evita duplicação em hot-reload
    if(FLUXOLAB_BOLSOES.find(b => b.key === 'ELETRONICA')) return;

    // Inserir antes de DOCA_1 (último bolsão) para aparecer no fim do layout
    const docaIdx = FLUXOLAB_BOLSOES.findIndex(b => b.key === 'DOCA_1');
    const novoB = {
      key:    'ELETRONICA',
      label:  'Eletrônica',
      icon:   '⚡',
      color:  '#facc15',
      bg:     'rgba(250,204,21,.08)',
      border: 'rgba(250,204,21,.3)',
    };

    if(docaIdx >= 0){
      FLUXOLAB_BOLSOES.splice(docaIdx, 0, novoB);
    } else {
      FLUXOLAB_BOLSOES.push(novoB);
    }

    // Força rebuild da lista de destinos (limpa cache do dataset.built)
    const destList = document.getElementById('fmov-dest-list');
    if(destList) destList.dataset.built = '';

    // Re-renderiza o FluxoLAB se a view estiver aberta
    if(typeof renderFluxolab === 'function') renderFluxolab();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _inject);
  } else {
    _inject();
  }
})();
/* ═══════════════════════════════════════════════════════════════════════════
   PATCH v3 — Bipagem de peças (mobile-friendly + anti-leitura-errada)
   Cole DEPOIS do patch-bipagem-peca.js (v2) — só sobrescreve o que precisa.
   ───────────────────────────────────────────────────────────────────────────
   Problemas que resolve:
   • Scanner Bluetooth/HID em celular: o teclado virtual aparece e atrapalha
     → adiciona inputmode="none" + autocomplete/autocorrect/spellcheck off
   • onblur disparando entrega com código parcial (re-render rouba o foco no
     meio do scan) → remove o fallback no blur
   • Re-render do painel perdendo o foco no input ativo → preserva foco e
     posição do cursor após cada render
   • Caracteres do scanner chegando muito rápido + Enter tardio gerando leitura
     truncada → buffer com auto-commit por inatividade (>=4 chars, 80 ms sem
     novas teclas) OU Enter, o que vier primeiro
   • Leitura duplicada do mesmo código (alguns scanners enviam 2x) → debounce
     de 500 ms por (id+codigo)
   • IME / autocomplete do Android inserindo composições estranhas → ignora
     eventos durante composition
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  if (typeof window._renderSolicitacoesPanel !== 'function') {
    console.warn('[LabTech v3] _renderSolicitacoesPanel ainda não existe — recarregue após o patch v2.');
  }

  // ── Estado interno ────────────────────────────────────────────────────────
  var MIN_LEN          = 4;     // mínimo de caracteres p/ considerar leitura válida
  var IDLE_COMMIT_MS   = 80;    // sem teclas por X ms → commita
  var DEDUP_MS         = 500;   // ignora repetição idêntica nesse intervalo
  var _ultimoBipe      = {};    // { id: { code, ts } }
  var _idleTimers      = {};    // { id: timeoutId }
  var _focoAtivo       = null;  // { id, selStart, selEnd, value }

  // ── Utilitário: preservar foco entre re-renders ───────────────────────────
  function _snapshotFoco(){
    var el = document.activeElement;
    if (!el || !el.id || el.id.indexOf('bipe-') !== 0) { _focoAtivo = null; return; }
    _focoAtivo = {
      id: el.id,
      value: el.value,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd
    };
  }
  function _restaurarFoco(){
    if (!_focoAtivo) return;
    var el = document.getElementById(_focoAtivo.id);
    if (!el) return;
    if (el.value === '' && _focoAtivo.value) el.value = _focoAtivo.value;
    try { el.focus({ preventScroll: true }); } catch(_) { el.focus(); }
    try { el.setSelectionRange(_focoAtivo.selStart, _focoAtivo.selEnd); } catch(_) {}
  }

  // Hook no Firebase update: snapshot ANTES, restaura DEPOIS do render
  if (typeof window._renderSolicitacoesPanel === 'function') {
    var _origRender = window._renderSolicitacoesPanel;
    window._renderSolicitacoesPanel = function(){
      _snapshotFoco();
      var r = _origRender.apply(this, arguments);
      // espera o DOM novo
      requestAnimationFrame(function(){ _restaurarFoco(); _wireBipeInputs(); });
      return r;
    };
  }

  // ── Anexa handlers robustos a todos os inputs de bipe ─────────────────────
  function _wireBipeInputs(){
    var inputs = document.querySelectorAll('input[id^="bipe-"]');
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (el.dataset.lab3) continue;
      el.dataset.lab3 = '1';

      // Mobile-friendly: sem teclado virtual, sem autocorrect
      el.setAttribute('inputmode', 'none');
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('spellcheck', 'false');
      el.setAttribute('enterkeyhint', 'done');

      // Remove o onblur original (causava entrega com código parcial)
      el.onblur = null;

      // Extrai id do bipe e selb do botão Entregar adjacente
      var id = el.id.replace(/^bipe-/, '');
      var selb = _descobrirSelb(el);

      // Ignora composições do IME
      var _composing = false;
      el.addEventListener('compositionstart', function(){ _composing = true; });
      el.addEventListener('compositionend', function(){ _composing = false; });

      // Auto-commit por inatividade (scanner HID despeja chars rapidíssimo
      // e às vezes não envia Enter no fim em alguns modos)
      el.addEventListener('input', (function(eid, esel){
        return function(){
          if (_composing) return;
          if (_idleTimers[eid]) clearTimeout(_idleTimers[eid]);
          _idleTimers[eid] = setTimeout(function(){
            var node = document.getElementById('bipe-' + eid);
            if (!node) return;
            var v = (node.value || '').trim();
            if (v.length >= MIN_LEN) _commit(eid, esel, v);
          }, IDLE_COMMIT_MS);
        };
      })(id, selb));

      // Enter / Tab → commit imediato
      el.addEventListener('keydown', (function(eid, esel){
        return function(ev){
          if (_composing) return;
          if (ev.key === 'Enter' || ev.key === 'Tab') {
            ev.preventDefault();
            if (_idleTimers[eid]) { clearTimeout(_idleTimers[eid]); _idleTimers[eid] = null; }
            var node = document.getElementById('bipe-' + eid);
            var v = (node && node.value || '').trim();
            if (!v) return; // não dispara entrega "vazia" sem confirmação manual
            _commit(eid, esel, v);
          }
        };
      })(id, selb));
    }
  }

  function _descobrirSelb(inputEl){
    // O onclick do botão Entregar tem a forma: entregarPecaComCodigo('id','SELB')
    var btn = inputEl.parentElement && inputEl.parentElement.querySelector('button[onclick*="entregarPecaComCodigo"]');
    if (!btn) return '';
    var m = /entregarPecaComCodigo\('([^']+)','([^']+)'\)/.exec(btn.getAttribute('onclick') || '');
    return m ? m[2] : '';
  }

  function _commit(id, selb, codigo){
    var prev = _ultimoBipe[id];
    var now  = Date.now();
    if (prev && prev.code === codigo && (now - prev.ts) < DEDUP_MS) {
      // leitura duplicada do scanner — ignora
      return;
    }
    _ultimoBipe[id] = { code: codigo, ts: now };
    if (typeof window.entregarPecaComCodigo === 'function') {
      window.entregarPecaComCodigo(id, selb);
    }
  }

  // ── Primeira passada (cards já renderizados antes deste script) ───────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireBipeInputs);
  } else {
    _wireBipeInputs();
  }
  // Reaplica a cada 1.5s como rede de segurança (renders fora do hook)
  setInterval(_wireBipeInputs, 1500);

  console.log('[LabTech] patch-bipagem-peca v3 ativo: scan mobile robusto, anti-blur, anti-duplicado, foco preservado.');
})();
/* ═══════════════════════════════════════════════════════════════════════════
   PATCH v4 — Bipagem de peças (scanner HID com layout fixo + validação)
   Cole DEPOIS do patch-bipagem-peca-v3.js.
   ───────────────────────────────────────────────────────────────────────────
   O que esta versão acrescenta:
   • monta o código via KeyboardEvent.code (Digit3, KeyL, etc.), evitando que
     o layout/teclado do Android transforme 302LV94130 em N#HPAIjH
   • impede que símbolos estranhos entrem no campo durante leitura HID
   • normaliza para MAIÚSCULO e remove espaços invisíveis
   • só entrega código com padrão seguro (A-Z, 0-9, / . _ -)
   • mantém fallback por input/evento para scanners em modo text injection

   Observação importante:
   Se o scanner/dispositivo estiver configurado para um wedge incompatível,
   esta correção melhora muito no navegador. Se ainda vier lixo, ajuste o
   scanner para "Text Injection / Commit Text" ou layout compatível.
   ═══════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  if (window.__labTechPatchV4Installed) return;
  window.__labTechPatchV4Installed = true;

  var MIN_LEN = 4;
  var IDLE_COMMIT_MS = 90;
  var DEDUP_MS = 700;
  var RE_CODIGO_VALIDO = /^[A-Z0-9._\/-]{4,}$/;

  var _ultimoBipe = {};
  var _idleTimers = {};
  var _focoAtivo = null;

  function _sanitize(v){
    return String(v || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, '')
      .toUpperCase()
      .trim();
  }

  function _isValidCodigo(v){
    return RE_CODIGO_VALIDO.test(v);
  }

  function _snapshotFoco(){
    var el = document.activeElement;
    if (!el || !el.id || el.id.indexOf('bipe-') !== 0) { _focoAtivo = null; return; }
    _focoAtivo = {
      id: el.id,
      value: el.value,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd
    };
  }

  function _restaurarFoco(){
    if (!_focoAtivo) return;
    var el = document.getElementById(_focoAtivo.id);
    if (!el) return;
    if (!el.value && _focoAtivo.value) el.value = _sanitize(_focoAtivo.value);
    try { el.focus({ preventScroll: true }); } catch(_) { el.focus(); }
    try { el.setSelectionRange(_focoAtivo.selStart, _focoAtivo.selEnd); } catch(_) {}
  }

  function _charFromCode(code){
    if (!code) return '';
    var m;
    m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return m[1];
    if (code === 'Minus' || code === 'NumpadSubtract') return '-';
    if (code === 'Slash' || code === 'NumpadDivide') return '/';
    if (code === 'Period' || code === 'NumpadDecimal') return '.';
    if (code === 'IntlRo' || code === 'IntlYen') return '/';
    return '';
  }

  function _setValue(el, value){
    var clean = _sanitize(value);
    el.value = clean;
    try {
      var pos = clean.length;
      el.setSelectionRange(pos, pos);
    } catch(_) {}
  }

  function _insertAtCursor(el, chunk){
    var start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    var end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    var next = el.value.slice(0, start) + chunk + el.value.slice(end);
    _setValue(el, next);
  }

  function _scheduleCommit(id, selb){
    if (_idleTimers[id]) clearTimeout(_idleTimers[id]);
    _idleTimers[id] = setTimeout(function(){
      var el = document.getElementById('bipe-' + id);
      if (!el) return;
      var codigo = _sanitize(el.value);
      if (_isValidCodigo(codigo)) _commit(id, selb, codigo);
      else if (codigo) console.warn('[LabTech v4] leitura descartada por padrão inválido:', codigo);
    }, IDLE_COMMIT_MS);
  }

  function _descobrirSelb(inputEl){
    var scope = inputEl.parentElement;
    if (!scope) return '';
    var btn = scope.querySelector('button[onclick*="entregarPecaComCodigo"]');
    if (!btn) return '';
    var m = /entregarPecaComCodigo\('([^']+)','([^']+)'\)/.exec(btn.getAttribute('onclick') || '');
    return m ? m[2] : '';
  }

  function _commit(id, selb, codigo){
    codigo = _sanitize(codigo);
    if (!_isValidCodigo(codigo)) {
      console.warn('[LabTech v4] código inválido bloqueado:', codigo);
      return;
    }

    var prev = _ultimoBipe[id];
    var now = Date.now();
    if (prev && prev.code === codigo && (now - prev.ts) < DEDUP_MS) return;
    _ultimoBipe[id] = { code: codigo, ts: now };

    var input = document.getElementById('bipe-' + id);
    if (input) _setValue(input, codigo);

    if (typeof window.entregarPecaComCodigo === 'function') {
      window.entregarPecaComCodigo(id, selb);
    }
  }

  function _wireOne(original){
    if (!original || original.dataset.lab4 === '1') return original;

    var el = original.cloneNode(true);
    el.dataset.lab3 = '1';
    el.dataset.lab4 = '1';
    el.onblur = null;

    el.setAttribute('inputmode', 'none');
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocorrect', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('enterkeyhint', 'done');
    el.setAttribute('virtualkeyboardpolicy', 'manual');

    var id = el.id.replace(/^bipe-/, '');
    var selb = _descobrirSelb(original);
    var composing = false;

    el.addEventListener('focus', function(){
      _setValue(el, el.value);
    });

    el.addEventListener('compositionstart', function(){ composing = true; });
    el.addEventListener('compositionend', function(){ composing = false; });

    el.addEventListener('keydown', function(ev){
      if (composing) return;

      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        if (_idleTimers[id]) { clearTimeout(_idleTimers[id]); _idleTimers[id] = null; }
        var codigoEnter = _sanitize(el.value);
        if (codigoEnter) _commit(id, selb, codigoEnter);
        return;
      }

      if (ev.key === 'Backspace') {
        ev.preventDefault();
        if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number' && el.selectionStart !== el.selectionEnd) {
          var next = el.value.slice(0, el.selectionStart) + el.value.slice(el.selectionEnd);
          _setValue(el, next);
        } else {
          _setValue(el, el.value.slice(0, -1));
        }
        return;
      }

      if (ev.key === 'Escape') {
        ev.preventDefault();
        _setValue(el, '');
        return;
      }

      if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

      var mapped = _charFromCode(ev.code);
      if (mapped) {
        ev.preventDefault();
        _insertAtCursor(el, mapped);
        _scheduleCommit(id, selb);
      }
    });

    el.addEventListener('input', function(){
      if (composing) return;
      var before = el.value || '';
      var clean = _sanitize(before);
      if (before !== clean) _setValue(el, clean);
      _scheduleCommit(id, selb);
    });

    el.addEventListener('paste', function(ev){
      ev.preventDefault();
      var text = '';
      if (ev.clipboardData && typeof ev.clipboardData.getData === 'function') {
        text = ev.clipboardData.getData('text');
      }
      var clean = _sanitize(text);
      if (!clean) return;
      _setValue(el, clean);
      _scheduleCommit(id, selb);
    });

    if (original === document.activeElement) {
      original.replaceWith(el);
      try { el.focus({ preventScroll: true }); } catch(_) { el.focus(); }
    } else {
      original.replaceWith(el);
    }

    return el;
  }

  function _wireBipeInputs(){
    var inputs = document.querySelectorAll('input[id^="bipe-"]');
    for (var i = 0; i < inputs.length; i++) _wireOne(inputs[i]);
  }

  if (typeof window._renderSolicitacoesPanel === 'function') {
    var _origRender = window._renderSolicitacoesPanel;
    window._renderSolicitacoesPanel = function(){
      _snapshotFoco();
      var r = _origRender.apply(this, arguments);
      requestAnimationFrame(function(){ _wireBipeInputs(); _restaurarFoco(); });
      return r;
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wireBipeInputs);
  } else {
    _wireBipeInputs();
  }

  setInterval(_wireBipeInputs, 1500);
  console.log('[LabTech] patch-bipagem-peca v4 ativo: HID por code, validação e anti-layout-errado.');
})();
/* ════════════════════════════════════════════════════════════════════════
   PATCH — Integração LabTech (Firebase) → Supabase (estoque-lab do Pietro)
   v2 — corrige LOOP INFINITO de baixa
   --------------------------------------------------------------------------
   MUDANÇAS EM RELAÇÃO À VERSÃO ANTERIOR:
   1. processarSolicitacao agora ignora QUALQUER registro que já tenha
      `_supabaseBaixa` definido (sucesso OU erro). Antes só ignorava sucesso,
      o que causava reprocessamento infinito em saldo insuficiente.
   2. Cooldown local de 30 s por id evita cascata mesmo se o snapshot
      vier várias vezes.
   3. Toast com de-duplicação: mesma mensagem em < 3 s é suprimida.
   4. Watcher segue DESABILITADO (entregarPecaComCodigo já chama o Supabase
      no bipe). Para reativar, basta ligar o bloco no final.
   ════════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const SUPABASE_URL = ['https://idpmr','jjalhnpsxpfug','ph.supabase.co'].join('');
  const SUPABASE_ANON_KEY = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6','ImlkcG1yamphbGhucHN4cGZ1Z3BoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjU2N','jcsImV4cCI6MjA5MzI0MTY2N30.L4hV7YM9yjdOOW9zBl84L-1si2DU8nBI3J1WgmW02lY'].join('');
  const RPC = SUPABASE_URL + '/rest/v1/rpc/registrar_baixa_integracao';

  const _bootTs = Date.now();
  const _emAndamento = new Set();
  const _ultimoProcessamento = new Map(); // id -> ts (cooldown)
  const COOLDOWN_MS = 30 * 1000;

  function normalizarSetor(raw){
    const s = String(raw || '').toUpperCase().trim();
    if(s.includes('REMANU')) return 'REMANU';
    if(s.includes('3D'))     return '3D';
    return 'LAB';
  }

  function log(msg, extra){
    if(extra !== undefined) console.log('[Supabase-Integração]', msg, extra);
    else                    console.log('[Supabase-Integração]', msg);
  }

  async function chamarSupabase(payload){
    const res = await fetch(RPC, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    let data = null;
    try{ data = await res.json(); }catch(_){}
    if(!res.ok){
      throw new Error((data && (data.message || data.error || data.hint)) || ('HTTP ' + res.status));
    }
    return data;
  }

  // ── Toast com de-duplicação ─────────────────────────────────────────
  const _toastRecentes = new Map(); // msg -> ts
  function showToast(msg, isError) {
    const now = Date.now();
    const ultimo = _toastRecentes.get(msg) || 0;
    if(now - ultimo < 3000) return; // suprime duplicado
    _toastRecentes.set(msg, now);
    // Limpeza periódica do mapa
    if(_toastRecentes.size > 50){
      for(const [k,v] of _toastRecentes){
        if(now - v > 10000) _toastRecentes.delete(k);
      }
    }

    const div = document.createElement('div');
    div.textContent = msg;
    div.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: ${isError ? '#f87171' : '#4ade80'};
      color: ${isError ? '#fff' : '#064e3b'};
      padding: 12px 20px; border-radius: 8px;
      font-weight: bold; font-family: sans-serif; font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      z-index: 99999; opacity: 0; transition: opacity 0.3s;
    `;
    document.body.appendChild(div);
    setTimeout(() => div.style.opacity = '1', 50);
    setTimeout(() => {
      div.style.opacity = '0';
      setTimeout(() => div.remove(), 300);
    }, 5000);
  }

  // ── Núcleo: dado um registro de solicitação, dispara a baixa ──────────
  async function processarSolicitacao(id, rec){
    if(!rec) return;
    if(!(rec.lida === true && rec.entregueTs)) return;
    if(!rec.codigoBipe || !String(rec.codigoBipe).trim()) {
      log('Entrega sem código bipado — baixa ignorada para', id);
      return;
    }

    // ★★★ CORREÇÃO PRINCIPAL DO LOOP ★★★
    // Se já existe QUALQUER tentativa anterior (sucesso OU erro), não tenta de novo.
    // Para reprocessar manualmente: window.baixarNoSupabaseManual(id) — apaga _supabaseBaixa e refaz.
    if(rec._supabaseBaixa) {
      log('Já processado anteriormente — ignorando (use baixarNoSupabaseManual para refazer).', id);
      return;
    }

    // Cooldown local
    const agora = Date.now();
    const ult = _ultimoProcessamento.get(id) || 0;
    if(agora - ult < COOLDOWN_MS){
      log('Cooldown ativo para', id);
      return;
    }
    _ultimoProcessamento.set(id, agora);

    // Ignora entregas pré-boot (com janela de 10 min)
    const DEZ_MINUTOS = 10 * 60 * 1000;
    if(Number(rec.entregueTs) < (_bootTs - DEZ_MINUTOS)) {
      try{ await window._db.ref('/solicitacoes_pecas/'+id+'/_supabaseBaixa').set({
        ok:false, skip:true, motivo:'pré-boot', ts: Date.now()
      }); }catch(_){}
      return;
    }

    if(_emAndamento.has(id)) return;
    _emAndamento.add(id);

    const payload = {
      p_code:  String(rec.codigoBipe).trim().toUpperCase(),
      p_qty:   Math.max(1, parseInt(rec.quantidade,10) || 1),
      p_selb:  String(rec.selb || '').trim().toUpperCase(),
      p_setor: normalizarSetor(rec.setor)
    };

    log('Disparando baixa no Supabase', { id, payload });

    try{
      const data = await chamarSupabase(payload);
      if(data && data.success === false) {
        log('Supabase retornou success: false', data);
        showToast('❌ Erro no Supabase: ' + (data.error || 'Peça não encontrada ou saldo insuficiente.'), true);
        try{
          await window._db.ref('/solicitacoes_pecas/'+id+'/_supabaseBaixa').set({
            ok: false, ts: Date.now(), payload, resposta: data
          });
        }catch(_){}
      } else {
        log('Baixa OK', data);
        showToast('✅ Baixa realizada no Supabase com sucesso!', false);
        try{
          await window._db.ref('/solicitacoes_pecas/'+id+'/_supabaseBaixa').set({
            ok: true, ts: Date.now(), payload, resposta: data || null
          });
        }catch(_){}
      }
    }catch(err){
      console.error('[Supabase-Integração] Falha na baixa', id, err);
      showToast('❌ Falha na conexão com Supabase: ' + String(err.message || err), true);
      try{
        await window._db.ref('/solicitacoes_pecas/'+id+'/_supabaseBaixa').set({
          ok: false, ts: Date.now(), payload, erro: String(err && err.message || err)
        });
      }catch(_){}
    }finally{
      _emAndamento.delete(id);
    }
  }

  // ── Wire-up DESABILITADO ──────────────────────────────────────────────
  // entregarPecaComCodigo (patch-bipagem-peca.js) já chama o Supabase
  // diretamente no bipe. Watcher fica como backup manual via console.
  function iniciar(){
    log('Watcher desabilitado — baixa feita diretamente pelo bipagem patch.');
    // Para reativar (com a guarda corrigida acima), descomente:
    // window._db.ref('/solicitacoes_pecas').on('child_changed', snap => {
    //   processarSolicitacao(snap.key, snap.val());
    // });
    // window._db.ref('/solicitacoes_pecas').on('child_added', snap => {
    //   processarSolicitacao(snap.key, snap.val());
    // });
  }

  // ── Função de teste / reprocessamento manual ──────────────────────────
  window.baixarNoSupabaseManual = async function(idOuPayload){
    if(typeof idOuPayload === 'string'){
      const snap = await window._db.ref('/solicitacoes_pecas/'+idOuPayload).once('value');
      const rec = snap.val();
      if(!rec) return console.warn('Solicitação não encontrada:', idOuPayload);
      if(rec._supabaseBaixa) await window._db.ref('/solicitacoes_pecas/'+idOuPayload+'/_supabaseBaixa').remove();
      _ultimoProcessamento.delete(idOuPayload);
      return processarSolicitacao(idOuPayload, rec);
    }
    return chamarSupabase(idOuPayload);
  };

  iniciar();
})();
/* ════════════════════════════════════════════════════════════════════════
   PATCH — PCP: acesso à aba Qualidade (gaiola-lab) + botão Liberar
   ─────────────────────────────────────────────────────────────────────
   O que faz:
   1. Injeta 'PCP' em PERM_SECTORS_FIXOS para aparecer na matriz de
      permissões (aba Admin → Permissões de Abas)
   2. Sobrescreve defaultPermsForSector para PCP herdar os defaults
      corretos (gaiola-lab: true entre eles)
   3. Força re-merge das permissões após a injeção
   4. Garante que applySectorTabPerms não esconde gaiola-lab do PCP
   5. Sobrescreve liberarPeca para aceitar PCP além de admin
      (hoje não há guard — patch defensivo caso seja adicionado depois)
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function waitFor(fn, interval) {
    if (fn()) return;
    const t = setInterval(function () { if (fn()) clearInterval(t); }, interval || 100);
  }

  /* ── 1. Injeta PCP em PERM_SECTORS_FIXOS ─────────────────────────── */
  waitFor(function () {
    if (typeof PERM_SECTORS_FIXOS === 'undefined') return false;
    if (!PERM_SECTORS_FIXOS.includes('PCP')) {
      PERM_SECTORS_FIXOS.push('PCP');
      console.log('[LabTech] PCP injetado em PERM_SECTORS_FIXOS');
    }
    return true;
  });

  /* ── 2. Sobrescreve defaultPermsForSector para incluir PCP ──────── */
  waitFor(function () {
    if (typeof defaultPermsForSector !== 'function') return false;
    const _orig = defaultPermsForSector;
    window.defaultPermsForSector = function (sector) {
      if (sector === 'PCP') {
        return {
          'dashboard':    true,
          'consulta':     true,
          'relatorios':   true,
          'pecas':        true,
          'solicitacoes': true,
          'maquinas-a':   true,
          'gaiola-lab':   true,   // ← QUALIDADE
          'perdidas':     true,
          'garantia':     true,
          'scanner':      true,
          'fluxolab':     true,
        };
      }
      return _orig(sector);
    };
    console.log('[LabTech] defaultPermsForSector sobrescrito para PCP');
    return true;
  });

  /* ── 3. Re-merge permissões depois que tudo carregou ─────────────── */
  // Aguarda _applySectorTabPermsRaw estar disponível e re-dispara
  waitFor(function () {
    if (typeof _applySectorTabPermsRaw !== 'function') return false;
    if (typeof defaultPermsForSector !== 'function') return false;
    // Re-aplica para que PCP agora entre no merge
    _applySectorTabPermsRaw();
    console.log('[LabTech] Permissões re-aplicadas com PCP incluído');
    return true;
  });

  /* ── 4. Garante que applySectorTabPerms não bloqueia gaiola-lab do PCP ── */
  waitFor(function () {
    if (typeof applySectorTabPerms !== 'function') return false;
    const _orig = applySectorTabPerms;
    window.applySectorTabPerms = function (u) {
      _orig(u);
      // Após a aplicação, garante que PCP mantém acesso à aba qualidade
      if (u && !u.isAdmin && u.sector === 'PCP') {
        const tabQual = document.getElementById('tab-gaiola-lab');
        if (tabQual) tabQual.style.display = '';
      }
    };
    console.log('[LabTech] applySectorTabPerms protegido para PCP');
    return true;
  });

  /* ── 5. Garante que setView('gaiola-lab') não bloqueia PCP ───────── */
  waitFor(function () {
    if (typeof setView !== 'function') return false;
    const _origSetView = setView;
    window.setView = function (v) {
      // Deixa passar normalmente — sem override de segurança para gaiola-lab no original
      return _origSetView.apply(this, arguments);
    };
    return true;
  });

  /* ── 6. Patch defensivo: liberarPeca aceita PCP além de admin ────── */
  // Hoje liberarPeca não tem guard de permissão — patch preventivo
  // caso seja adicionado no futuro. Também substitui o confirm() nativo.
  waitFor(function () {
    if (typeof liberarPeca !== 'function') return false;
    const _orig = liberarPeca;
    window.liberarPeca = async function (docId, dateKey) {
      const user = typeof currentUser !== 'undefined' ? currentUser : null;
      const temPermissao = user && (user.isAdmin || user.sector === 'PCP');
      if (!temPermissao) {
        if (typeof window._labPopup === 'function') {
          window._labPopup('Sem permissão', 'Apenas Admin e PCP podem liberar SELBs.', 'erro');
        } else {
          alert('Sem permissão para liberar.');
        }
        return;
      }

      // Substitui confirm() nativo por modal customizado se disponível
      if (typeof window._labConfirm === 'function') {
        const ok = await window._labConfirm(
          'Confirmar liberação',
          'Deseja aprovar e liberar este SELB?<br><span style="color:var(--muted);font-size:12px">Ele sairá da lista de aguardando peças.</span>'
        );
        if (!ok) return;
        // Chama versão original mas pulando o confirm interno
        // Monkey-patch temporário do confirm
        const _c = window.confirm;
        window.confirm = function () { return true; };
        try { await _orig(docId, dateKey); } finally { window.confirm = _c; }
      } else {
        return _orig(docId, dateKey);
      }
    };
    console.log('[LabTech] liberarPeca patch PCP aplicado');
    return true;
  });

  /* ── 7. Re-aplica permissões quando o usuário PCP fizer login ────── */
  waitFor(function () {
    if (typeof loginAs !== 'function') return false;
    const _orig = loginAs;
    window.loginAs = function (u) {
      const r = _orig.apply(this, arguments);
      if (u && !u.isAdmin && u.sector === 'PCP') {
        // Pequeno delay para garantir que applySectorTabPerms rodou
        setTimeout(function () {
          const tabQual = document.getElementById('tab-gaiola-lab');
          if (tabQual) tabQual.style.display = '';
        }, 100);
      }
      return r;
    };
    return true;
  });

  console.log('[LabTech] patch-pcp-qualidade carregado');
})();
/* ════════════════════════════════════════════════════════════════════════
   PATCH — PCP: permissão para marcar checkbox "Concluída" na aba Qualidade
   (toggleEtiquetaImpressaManual)
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function canAct() {
    return currentUser && (
      currentUser.isAdmin ||
      currentUser.sector === 'DESMEMBRAMENTO' ||
      currentUser.sector === 'PCP'
    );
  }

  function waitFor(fn, interval) {
    if (fn()) return;
    const t = setInterval(function () { if (fn()) clearInterval(t); }, interval || 100);
  }

  waitFor(function () {
    if (typeof window.toggleEtiquetaImpressaManual !== 'function') return false;

    window.toggleEtiquetaImpressaManual = async function (regId, checked, el) {
      try {
        if (!canAct()) {
          if (typeof window._labPopup === 'function') {
            window._labPopup('Sem permissão', 'Apenas Admin, Desmembramento e PCP podem alterar este status.', 'erro');
          } else {
            alert('Apenas administradores, Desmembramento ou PCP podem alterar este status.');
          }
          if (el) el.checked = !checked;
          return;
        }

        const titulo = checked ? 'Confirmar conclusão' : 'Reverter para pendente';
        const msg = checked
          ? 'Marcar este SELB como <b>CONCLUÍDO</b> (etiqueta impressa)?'
          : 'Reverter este SELB para <b>PENDENTE</b> (etiqueta não impressa)?';

        let ok = false;
        if (typeof window._labConfirm === 'function') {
          ok = await window._labConfirm(titulo, msg);
        } else {
          ok = confirm(checked
            ? 'Marcar este SELB como CONCLUÍDO (etiqueta impressa)?'
            : 'Reverter este SELB para PENDENTE (etiqueta não impressa)?');
        }

        if (!ok) {
          if (el) el.checked = !checked;
          return;
        }

        await _db.ref('/qualidade_registros/' + regId).update(
          checked
            ? { etiqueta_impressa: true,  etiqueta_impressa_ts: Date.now(), etiqueta_impressa_by: currentUser.name || null }
            : { etiqueta_impressa: false, etiqueta_impressa_ts: null, etiqueta_revertida_ts: Date.now(), etiqueta_revertida_by: currentUser.name || null }
        );

        // ── FluxoLAB: SELB sai de LIBERADAS quando etiqueta marcada como concluída ──
        if (checked) {
          try {
            const reg = Object.values(_qualRegistros || {}).find(r => r._id === regId || r._key === regId)
                     || await _db.ref('/qualidade_registros/' + regId).once('value').then(s => s.val()).catch(() => null);
            if (reg && reg.selb) {
              const selb = String(reg.selb).toUpperCase().trim();
              const bolsaoRef = _db.ref('/fluxolab/LIBERADAS');
              const snap = await bolsaoRef.once('value');
              const data = snap.val() || {};
              const keyToRemove = Object.keys(data).find(k => String(data[k].selb || '').toUpperCase().trim() === selb);
              if (keyToRemove) {
                await bolsaoRef.child(keyToRemove).remove();
                console.log('[LabTech] SELB', selb, 'removido de LIBERADAS pelo PCP');
              }
            }
          } catch (fe) {
            console.warn('[LabTech] Erro ao atualizar FluxoLAB:', fe);
          }
        }

        if (typeof renderQualRegistros === 'function') renderQualRegistros();

      } catch (e) {
        console.error('[LabTech] Erro em toggleEtiquetaImpressaManual:', e);
        if (el) el.checked = !checked;
      }
    };

    console.log('[LabTech] patch-pcp-qualidade-checkbox carregado');
    return true;
  });
})();
/* ════════════════════════════════════════════════════════════════════════
   PATCH — Remove o alerta "Sem SELB em andamento" (popup de 2 minutos)
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // 1. Esconde o painel assim que o DOM estiver pronto
  function ocultarPainel() {
    const panel = document.getElementById('selb-alert-panel');
    if (panel) {
      panel.style.display = 'none';
      panel.innerHTML = '';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ocultarPainel);
  } else {
    ocultarPainel();
  }

  // 2. Neutraliza updateSummary para não re-popular o painel
  const _waitHook = setInterval(function () {
    if (typeof window.updateSummary !== 'function') return;
    clearInterval(_waitHook);

    const _orig = window.updateSummary;
    window.updateSummary = function () {
      _orig.apply(this, arguments);
      ocultarPainel(); // garante que fique vazio mesmo se renderAlerts rodar
    };

    console.log('[LabTech] patch-disable-selb-alert: alerta "Sem SELB" desativado.');
  }, 100);

})();

/* ═══════════════════════════════════════════════════════════════════════════
   PATCH v5 — Bipagem de peças: digitação manual no celular + botão copiar SELB
   ─────────────────────────────────────────────────────────────────────────────
   Problemas resolvidos:
   • v3/v4 definem inputmode="none" → teclado virtual some no celular
   • IDLE_COMMIT_MS = 80–90ms → entrega dispara enquanto o usuário digita
   • Agora: detecta velocidade. Scanner HID (chars < 60ms) → auto-commit 90ms.
     Digitação humana (qualquer gap > 200ms) → desativa auto-commit; só commita
     via botão Entregar ou tecla Enter.
   • Botão ⎘ copiar SELB: função global _copiarSelb.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__labTechPatchV5Installed) return;
  window.__labTechPatchV5Installed = true;

  /* ── constantes ─────────────────────────────────────────────────────────── */
  var SCANNER_GAP_MS = 60;   // gap entre chars ≤ isso → é scanner HID
  var HUMAN_GAP_MS   = 200;  // gap ≥ isso → é humano → sem auto-commit
  var SCANNER_IDLE   = 90;   // scanner: commita após 90ms de silêncio
  var MIN_LEN        = 4;
  var DEDUP_MS       = 700;
  var RE_VALIDO      = /^[A-Z0-9._\/-]{4,}$/;

  /* ── estado por input ───────────────────────────────────────────────────── */
  var _lastInputTs = {};   // { id → timestamp do último input }
  var _humanMode   = {};   // { id → true se humano detectado nessa sessão }
  var _idleTimers  = {};
  var _ultimoBipe  = {};

  /* ── helpers ────────────────────────────────────────────────────────────── */
  function _sanitize(v) {
    return String(v || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, '').toUpperCase().trim();
  }
  function _isMobile() {
    return /Mobi|Android|iPhone/i.test(navigator.userAgent) ||
           window.matchMedia('(max-width: 768px)').matches;
  }
  function _scontext(el) {
    var btn = el.parentElement && el.parentElement.querySelector('button[onclick*="entregarPecaComCodigo"]');
    if (!btn) return { id: el.id.replace(/^bipe-/, ''), selb: '' };
    var m = /entregarPecaComCodigo\('([^']+)','([^']+)'\)/.exec(btn.getAttribute('onclick') || '');
    return { id: el.id.replace(/^bipe-/, ''), selb: m ? m[2] : '' };
  }

  /* ── commit real ────────────────────────────────────────────────────────── */
  function _commit(id, selb, codigo) {
    codigo = _sanitize(codigo);
    if (!RE_VALIDO.test(codigo)) return;
    var prev = _ultimoBipe[id], now = Date.now();
    if (prev && prev.code === codigo && (now - prev.ts) < DEDUP_MS) return;
    _ultimoBipe[id] = { code: codigo, ts: now };
    var inp = document.getElementById('bipe-' + id);
    if (inp) inp.value = codigo;
    if (typeof window.entregarPecaComCodigo === 'function') {
      window.entregarPecaComCodigo(id, selb);
    }
  }

  function _scheduleCommit(id, selb) {
    if (_idleTimers[id]) clearTimeout(_idleTimers[id]);
    _idleTimers[id] = setTimeout(function () {
      var el = document.getElementById('bipe-' + id);
      if (!el) return;
      var v = _sanitize(el.value);
      if (v.length >= MIN_LEN) _commit(id, selb, v);
    }, SCANNER_IDLE);
  }

  /* ── patch em cada input de bipe ────────────────────────────────────────── */
  function _patchOne(el) {
    if (el.dataset.lab5) return;
    el.dataset.lab5 = '1';

    var ctx = _scontext(el);
    var id  = ctx.id, selb = ctx.selb;

    /* Restaura teclado virtual no celular (v3/v4 o bloquearam com inputmode=none) */
    if (_isMobile()) {
      el.setAttribute('inputmode', 'text');
      el.removeAttribute('virtualkeyboardpolicy');
    }

    /* Listener de input — detecta velocidade e decide se auto-commita */
    el.addEventListener('input', function () {
      var now  = Date.now();
      var last = _lastInputTs[id] || 0;
      var gap  = now - last;
      _lastInputTs[id] = now;

      /* Se QUALQUER gap for humano, marca modo humano para essa sessão de digitação */
      if (last > 0 && gap >= HUMAN_GAP_MS) {
        _humanMode[id] = true;
      }
      /* Reset modo humano quando o campo fica vazio (nova leitura) */
      if (!el.value) {
        _humanMode[id] = false;
        _lastInputTs[id] = 0;
      }

      /* Cancela timer anterior */
      if (_idleTimers[id]) { clearTimeout(_idleTimers[id]); _idleTimers[id] = null; }

      var v = _sanitize(el.value);
      if (v.length < MIN_LEN) return;

      /* Só auto-commita se for scanner (sem gaps humanos detectados) */
      if (!_humanMode[id]) {
        _scheduleCommit(id, selb);
      }
      /* Digitação humana → aguarda botão Entregar ou Enter */
    });

    /* Enter / Tab → commit imediato, independente de modo */
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === 'Tab') {
        ev.preventDefault();
        if (_idleTimers[id]) { clearTimeout(_idleTimers[id]); _idleTimers[id] = null; }
        var v = _sanitize(el.value);
        if (v) _commit(id, selb, v);
        /* Reseta estado para próxima leitura */
        _humanMode[id]    = false;
        _lastInputTs[id]  = 0;
      }
    }, true /* capture — prioridade sobre handlers anteriores */);
  }

  function _wireAll() {
    document.querySelectorAll('input[id^="bipe-"]').forEach(_patchOne);
  }

  /* Hook no render para reaplicar após cada atualização */
  if (typeof window._renderSolicitacoesPanel === 'function') {
    var _orig = window._renderSolicitacoesPanel;
    window._renderSolicitacoesPanel = function () {
      var r = _orig.apply(this, arguments);
      requestAnimationFrame(_wireAll);
      return r;
    };
  }

  _wireAll();
  setInterval(_wireAll, 1500);
  console.log('[LabTech] patch v5 ativo: teclado manual liberado no celular, auto-commit só para scanner HID.');
})();

/* ── Botão copiar SELB ──────────────────────────────────────────────────────── */
window._copiarSelb = function (selb, btn) {
  var _ok = function () {
    var orig = btn.innerHTML;
    btn.innerHTML = '✓';
    btn.style.color = 'var(--accent2)';
    btn.style.borderColor = 'var(--accent2)';
    setTimeout(function () {
      btn.innerHTML = orig;
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(selb).then(_ok).catch(function () {
      _fallback(selb); _ok();
    });
  } else {
    _fallback(selb); _ok();
  }
  function _fallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }
};

/* ════════════════════════════════════════════════════════════════════
   PATCH — Sugestão de código mais usado por peça (últimos 120 dias)
   --------------------------------------------------------------------
   Para cada solicitação pendente em "SELBs Aguardando Peças", consulta
   o histórico em `_solicitacoesPecas` (que alimenta o "Registro de
   Solicitações do Dia") e mostra ao lado do nome da peça o código de
   produto mais frequente para o MESMO modelo de equipamento + MESMA
   peça nos últimos 120 dias. Inclui um botão para copiar o código
   (e preencher o campo de bipe).
   ════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';
  var _MS_120D = 120 * 24 * 60 * 60 * 1000;

  function _norm(s){
    return String(s == null ? '' : s)
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Normaliza a obs para uma chave canônica de cor de toner.
  // "black", "BK", "B", "K" → "BLACK"; "Y", "yellow", "amarelo" → "YELLOW"; etc.
  // Obs que não são cores de toner são retornadas normalizadas sem alteração.
  function _normObs(obs){
    var s = _norm(obs);
    if(!s) return '';
    var aliases = {
      'Y': 'YELLOW', 'YELLOW': 'YELLOW', 'AMARELO': 'YELLOW',
      'M': 'MAGENTA', 'MAGENTA': 'MAGENTA',
      'C': 'CYAN',    'CIANO': 'CYAN',    'CYAN': 'CYAN',
      'B': 'BLACK',   'BK': 'BLACK',      'K': 'BLACK', 'BLACK': 'BLACK', 'PRETO': 'BLACK',
    };
    return aliases[s] || s;
  }

  // Cache curto para evitar varrer todo o histórico em cada render
  var _cache = { ts: 0, key: '', map: null };

  function _buildIndex(){
    var src = (typeof _solicitacoesPecas !== 'undefined' && _solicitacoesPecas) ? _solicitacoesPecas : {};
    var keys = Object.keys(src);
    var key  = keys.length + ':' + (keys[keys.length-1] || '');
    var now  = Date.now();
    if(_cache.map && _cache.key === key && (now - _cache.ts) < 15000) return _cache.map;

    var cutoff = now - _MS_120D;
    // map[eq][peca] = { porObs:{ obsN:{ codigo:count } }, total:{ codigo:count } }
    var map = Object.create(null);
    for(var i=0; i<keys.length; i++){
      var r = src[keys[i]];
      if(!r) continue;
      var cod = r.codigoBipe;
      if(!cod) continue;
      var ts  = r.entregueTs || r.ts || 0;
      if(ts < cutoff) continue;
      var eqN = _norm(r.equipamento);
      var pcN = _norm(r.peca);
      if(!eqN || !pcN) continue;
      var obN = _normObs(r.obs); // chave canônica de cor (ex: "black"/"BK"/"B" → "BLACK")
      var codU = String(cod).trim().toUpperCase();
      if(!codU) continue;
      if(!map[eqN]) map[eqN] = Object.create(null);
      if(!map[eqN][pcN]) map[eqN][pcN] = { porObs: Object.create(null), total: Object.create(null) };
      var bucket = map[eqN][pcN];
      bucket.total[codU] = (bucket.total[codU] || 0) + 1;
      if(obN){
        if(!bucket.porObs[obN]) bucket.porObs[obN] = Object.create(null);
        bucket.porObs[obN][codU] = (bucket.porObs[obN][codU] || 0) + 1;
      }
    }
    _cache = { ts: now, key: key, map: map };
    return map;
  }

  function _best(counts){
    var k = null, n = 0;
    for(var c in counts){ if(counts[c] > n){ k = c; n = counts[c]; } }
    return k ? { codigo: k, ocorrencias: n } : null;
  }

  window._codigoMaisUsadoUltimos120 = function(equipamento, peca, obs){
    var eqN = _norm(equipamento), pcN = _norm(peca), obN = _normObs(obs);
    if(!eqN || !pcN) return null;
    var idx = _buildIndex();
    var bucket = idx[eqN] && idx[eqN][pcN];
    if(!bucket) return null;
    // Se há obs (cor de toner): busca APENAS dentro do bucket da cor
    // NÃO faz fallback para bucket.total — evita sugerir código de outra cor
    if(obN){
      return bucket.porObs[obN] ? _best(bucket.porObs[obN]) : null;
    }
    // Sem obs: usa total (qualquer entrega anterior para este equip+peça)
    return _best(bucket.total);
  };

  // ── Cópia + preenchimento do campo de bipe ─────────────────────────
  window._copiarCodigoSugerido = function(codigo, btn, inputId){
    var orig = btn.innerHTML;
    var origColor = btn.style.color;
    var origBorder = btn.style.borderColor;
    function _ok(){
      btn.innerHTML = '✓';
      btn.style.color = 'var(--accent2)';
      btn.style.borderColor = 'var(--accent2)';
      setTimeout(function(){
        btn.innerHTML = orig;
        btn.style.color = origColor;
        btn.style.borderColor = origBorder;
      }, 1400);
    }
    function _fallback(text){
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch(e) {}
      document.body.removeChild(ta);
    }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(codigo).then(_ok).catch(function(){ _fallback(codigo); _ok(); });
    } else {
      _fallback(codigo); _ok();
    }
    // Pré-preenche o campo de bipe correspondente, se existir e estiver vazio
    if(inputId){
      var inp = document.getElementById(inputId);
      if(inp && !inp.disabled && !inp.value){
        inp.value = codigo;
        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch(_){}
      }
    }
  };

  // ── Injeta a badge ao lado do nome da peça em cada card ────────────
  function _injetarSugestoes(){
    var inputs = document.querySelectorAll('input[id^="bipe-"]');
    if(!inputs.length) return;
    var src = (typeof _solicitacoesPecas !== 'undefined' && _solicitacoesPecas) ? _solicitacoesPecas : {};
    inputs.forEach(function(inp){
      var id  = inp.id.slice(5); // remove "bipe-"
      var rec = src[id];
      if(!rec) return;
      var item = inp.closest('div[style*="margin-top:6px"]');
      if(!item || item.querySelector('.cod-sugerido-wrap')) return;
      var topRow = item.firstElementChild;
      if(!topRow) return;
      var sug = window._codigoMaisUsadoUltimos120(rec.equipamento, rec.peca, rec.obs);
      if(!sug) return;
      var inputId = inp.id;
      var safeCod = String(sug.codigo).replace(/'/g, "\\'");
      var safeIn  = String(inputId).replace(/'/g, "\\'");
      var wrap = document.createElement('span');
      wrap.className = 'cod-sugerido-wrap';
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-left:6px;background:rgba(96,165,250,.12);border:1px solid rgba(96,165,250,.4);border-radius:6px;padding:2px 6px;font-family:var(--mono);font-size:10px;font-weight:700;color:#93c5fd;line-height:1';
      wrap.title = 'Código mais usado nos últimos 120 dias para este modelo + peça (' + sug.ocorrencias + ' uso' + (sug.ocorrencias > 1 ? 's' : '') + ')';
      wrap.innerHTML =
          '<span style="opacity:.8;font-size:9px">★</span>'
        + '<span class="cod-val">' + sug.codigo + '</span>'
        + '<button type="button" '
        +   'onmousedown="event.stopPropagation()" '
        +   'onclick="event.stopPropagation();window._copiarCodigoSugerido(\'' + safeCod + '\',this,\'' + safeIn + '\')" '
        +   'title="Copiar código e preencher bipe" '
        +   'style="background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.4);border-radius:4px;color:#93c5fd;cursor:pointer;font-size:10px;font-weight:700;padding:1px 5px;line-height:1;margin-left:2px">⎘</button>';
      topRow.appendChild(wrap);
    });
  }

  // Hook no render dos cards de solicitações
  if(typeof window._renderSolicitacoesPanel === 'function'){
    var _orig = window._renderSolicitacoesPanel;
    window._renderSolicitacoesPanel = function(){
      var r = _orig.apply(this, arguments);
      requestAnimationFrame(_injetarSugestoes);
      return r;
    };
  }

  // Reaplica periodicamente (cobre inserções tardias / reconexão Firebase)
  setInterval(_injetarSugestoes, 1800);
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _injetarSugestoes);
  } else {
    setTimeout(_injetarSugestoes, 600);
  }
})();

/* ════════════════════════════════════════════════════════════════════
   PATCH — Aguardando Peças: exibir TODOS os registros (inclusive
   os já confirmados / já entregues), inclusive aqueles que não estão
   mais com status 'aguardando' no history.
   --------------------------------------------------------------------
   • NÃO remove linhas confirmadas (mantém comportamento original).
   • Sintetiza linhas a partir de `_solicitacoesPecas` (TODAS — pendentes
     e já entregues) para SELBs ainda não presentes na tabela, dentro
     do filtro de datas (pecas-date-from / pecas-date-to).
   • Reaplica via MutationObserver no <tbody> e setInterval.
   ════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  function _fmtDataHora(ts){
    if(!ts) return '—';
    try {
      var d = new Date(ts);
      return d.toLocaleDateString('pt-BR') + ' ' +
             d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
    } catch(e){ return '—'; }
  }

  function _ehSolicitado(selb){
    try { return localStorage.getItem('selb_solicitado_' + selb) === '1'; }
    catch(e){ return false; }
  }

  function _selbDaLinha(tr){
    if(!tr) return '';
    var ds = tr.getAttribute('data-row-selb') || tr.getAttribute('data-selb');
    if(ds) return ds.trim();
    if(tr.cells && tr.cells[1]){
      var raw = tr.cells[1].textContent || '';
      return raw.split(/\s+/)[0].trim();
    }
    return '';
  }

  function _faixaDatas(){
    var fromEl = document.getElementById('pecas-date-from');
    var toEl   = document.getElementById('pecas-date-to');
    var fromIso = (fromEl && fromEl.value) ? fromEl.value : '';
    var toIso   = (toEl   && toEl.value)   ? toEl.value   : '';
    var fromTs = fromIso ? new Date(fromIso + 'T00:00:00').getTime() : 0;
    var toTs   = toIso   ? new Date(toIso   + 'T23:59:59.999').getTime() : Number.MAX_SAFE_INTEGER;
    return { fromTs: fromTs, toTs: toTs };
  }

  var _aplicando = false;

  function _aplicar(){
    if(_aplicando) return;
    var tbody = document.getElementById('pecas-body');
    if(!tbody) return;
    _aplicando = true;
    try {
      // 1. Mapa de SELBs já presentes (não duplicar)
      var presentes = Object.create(null);
      Array.prototype.forEach.call(tbody.querySelectorAll('tr'), function(tr){
        var s = _selbDaLinha(tr);
        if(s) presentes[s.toUpperCase()] = true;
      });

      // 2. Sintetiza linhas a partir de _solicitacoesPecas (TODOS os registros
      //    no intervalo de datas atual — pendentes E entregues)
      var src = (typeof _solicitacoesPecas !== 'undefined' && _solicitacoesPecas) ? _solicitacoesPecas : {};
      var faixa = _faixaDatas();
      var grupos = Object.create(null);

      for(var id in src){
        var p = src[id];
        if(!p) continue;
        var selb = (p.selb || '').toString().trim();
        if(!selb) continue;
        if(presentes[selb.toUpperCase()]) continue;

        var ts = p.ts || p.entregueTs || 0;
        if(!ts) continue;
        if(ts < faixa.fromTs || ts > faixa.toTs) continue;

        if(!grupos[selb]){
          grupos[selb] = {
            itens: [],
            primeiro: p,
            maxTs: ts,
            minTs: ts,
            algumaPendente: false,
            todasEntregues: true
          };
        }
        grupos[selb].itens.push(p);
        if(ts > grupos[selb].maxTs) grupos[selb].maxTs = ts;
        if(ts < grupos[selb].minTs){ grupos[selb].minTs = ts; grupos[selb].primeiro = p; }
        if(p.lida) {
          // marcado como entregue
        } else {
          grupos[selb].algumaPendente = true;
          grupos[selb].todasEntregues = false;
        }
        if(!p.lida) grupos[selb].todasEntregues = false;
      }
      var selbsSinteticos = Object.keys(grupos);

      // 3. Remove placeholder vazio se vamos adicionar conteúdo
      if(selbsSinteticos.length){
        tbody.querySelectorAll('td.empty').forEach(function(td){
          var tr = td.closest('tr'); if(tr) tr.remove();
        });
      }

      // 4. Adiciona linhas sintéticas (mais recente primeiro)
      if(selbsSinteticos.length){
        selbsSinteticos.sort(function(a,b){ return (grupos[b].maxTs||0) - (grupos[a].maxTs||0); });
        var html = selbsSinteticos.map(function(selb){
          var g     = grupos[selb];
          var first = g.primeiro;
          var pecasCellHtml = g.itens.map(function(p){
            var qtd = p.quantidade > 1
              ? '<span style="background:rgba(245,166,35,.2);color:var(--warn);border-radius:4px;font-size:10px;font-weight:800;padding:0 5px;margin-left:3px">x'+p.quantidade+'</span>'
              : '';
            var statusDot = p.lida
              ? '<span title="entregue" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3dd68c;margin-right:4px"></span>'
              : '<span title="pendente" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#f5a623;margin-right:4px"></span>';
            return '<div style="font-size:12px;display:flex;align-items:center;gap:4px;margin-bottom:2px">'
                + statusDot + '<span>🔩</span>'
                + '<span style="color:var(--text)' + (p.lida ? ';opacity:.7' : '') + '">'+(p.peca||'—')+'</span>'+qtd
                + '</div>';
          }).join('');

          var jaSolicitado = _ehSolicitado(selb);
          var chkStyle = jaSolicitado
            ? 'background:var(--accent2);border-color:var(--accent2);'
            : 'background:transparent;border:2px solid rgba(61,214,140,.4);';
          var rowStyle = '';
          var statusBadge = '';
          if(g.todasEntregues){
            rowStyle = 'background:rgba(61,214,140,.05)';
            statusBadge = '<span style="font-size:9px;color:var(--accent2);background:rgba(61,214,140,.15);border:1px solid rgba(61,214,140,.4);border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;font-family:var(--font);font-weight:600">entregue</span>';
          } else if(g.algumaPendente){
            rowStyle = 'background:rgba(96,165,250,.04)';
            statusBadge = '<span style="font-size:9px;color:#93c5fd;background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.4);border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;font-family:var(--font);font-weight:600">pendente</span>';
          }
          if(jaSolicitado) rowStyle += ';opacity:0.55';

          var safeSelb = String(selb).replace(/'/g, "\\'");
          return '<tr data-row-selb="'+selb+'" data-sintetica="1" style="'+rowStyle+'">'
              + '<td style="text-align:center;width:44px">'
                + '<label title="'+(jaSolicitado?'Solicitado!':'Marcar como solicitado')+'" style="cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;user-select:none">'
                  + '<input type="checkbox" '+(jaSolicitado?'checked':'')+' onchange="toggleSelbSolicitado(\''+safeSelb+'\', this)" '
                  +   'style="width:18px;height:18px;border-radius:5px;'+chkStyle+'appearance:none;-webkit-appearance:none;cursor:pointer;transition:all .15s">'
                  + '<span style="font-size:9px;color:var(--muted);font-weight:600;letter-spacing:.02em">'+(jaSolicitado?'FEITO':'PEDIDO?')+'</span>'
                + '</label>'
              + '</td>'
              + '<td style="font-family:var(--mono);font-weight:600;color:var(--accent)">'+selb+statusBadge+'</td>'
              + '<td style="font-size:12px;color:var(--muted)">'+(first.equipamento||'—')+'</td>'
              + '<td>'+(first.nome||'—')+'</td>'
              + '<td>'+(first.setor||'—')+'</td>'
              + '<td style="font-family:var(--mono);font-size:12px;color:var(--muted)">'+_fmtDataHora(g.minTs)+'</td>'
              + '<td style="font-family:var(--mono);font-size:12px;color:var(--muted)">—</td>'
              + '<td style="font-size:11px;color:var(--muted);max-width:160px">'+(first.obs||'—')+'</td>'
              + '<td>'+pecasCellHtml+'</td>'
              + '<td><span style="font-size:11px;color:var(--muted);font-style:italic">'+(g.todasEntregues?'todas entregues':(g.algumaPendente?'aguardando entrega':'—'))+'</span></td>'
            + '</tr>';
        }).join('');
        tbody.insertAdjacentHTML('beforeend', html);
      }
    } finally {
      _aplicando = false;
    }
  }

  // ── MutationObserver no tbody (capta qualquer renderização)
  function _setupObserver(){
    var tbody = document.getElementById('pecas-body');
    if(!tbody){ setTimeout(_setupObserver, 500); return; }
    var mo = new MutationObserver(function(){
      if(_aplicando) return;
      // debounce
      clearTimeout(window.__pecasAugTimer);
      window.__pecasAugTimer = setTimeout(_aplicar, 30);
    });
    mo.observe(tbody, { childList: true });
    _aplicar();
  }

  // ── Wrap window.renderPecasView (callers via window)
  function _wrap(){
    if(typeof window.renderPecasView !== 'function') return false;
    if(window.renderPecasView.__augWrapped) return true;
    var _orig = window.renderPecasView;
    var wrapped = async function(){
      var r;
      try { r = await _orig.apply(this, arguments); } catch(e){ console.error(e); }
      requestAnimationFrame(_aplicar);
      return r;
    };
    wrapped.__augWrapped = true;
    window.renderPecasView = wrapped;
    return true;
  }

  // Tenta wrap imediatamente e em poll curto (caso a função seja definida depois)
  if(!_wrap()){
    var tries = 0;
    var iv = setInterval(function(){
      if(_wrap() || ++tries > 40) clearInterval(iv);
    }, 250);
  }

  // Fallback: reaplica periodicamente quando a view está ativa
  setInterval(function(){
    var view = document.getElementById('view-pecas');
    if(view && view.classList.contains('active')) _aplicar();
  }, 2500);

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', _setupObserver);
  } else {
    _setupObserver();
  }
})();

/* === face-auth.js === */

/* ════════════════════════════════════════════════════════════════════
   FACE AUTH — Login facial complementar ao PIN
   Drop-in: basta incluir este script em index.html APÓS app.js
   --------------------------------------------------------------------
   Como funciona:
   1. Usuário entra normalmente pelo PIN na primeira vez.
   2. Após login bem-sucedido como operador (não-admin), aparece um
      convite "Ativar login facial" (uma vez por dispositivo/usuário).
   3. O rosto é capturado pela webcam, gerado um descritor 128-d com
      face-api.js e salvo em Firebase em `faceAuth/{userId}`.
   4. Na tela de login, aparece o botão "🙂 Entrar com rosto" — abre a
      câmera, compara com TODOS os descritores cadastrados e, se casar
      (distância < 0.5), chama loginAs() automaticamente.
   5. PIN continua funcionando normalmente como fallback.
   ════════════════════════════════════════════════════════════════════ */
(function(){
  'use strict';

  const MODELS_URL    = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
  const MATCH_THRESH  = 0.48;   // ligeiramente mais exigente — menos falsos positivos
  const SCAN_INTERVAL = 180;    // ms entre tentativas (era 350 — quase 2× mais rápido)
  const SCAN_TIMEOUT  = 12000;  // 12s antes de desistir

  let modelsReady   = false;
  let modelsLoading = null;
  let descriptors   = {};       // { userId: { name, pin, descriptor:Float32Array } }
  let dbReady       = false;
  let videoStream   = null;
  let scanTimer     = null;
  let scanDeadline  = 0;

  // ── Espera o app principal carregar ──────────────────────────────
  function whenReady(cb){
    if(typeof firebase !== 'undefined' && firebase.database &&
       typeof users !== 'undefined' && typeof loginAs === 'function'){
      cb();
    } else {
      setTimeout(()=>whenReady(cb), 200);
    }
  }

  // ── Carrega face-api.js sob demanda ──────────────────────────────
  function loadFaceApi(){
    if(window.faceapi) return Promise.resolve();
    return new Promise((res, rej)=>{
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
      s.onload = res;
      s.onerror = ()=>rej(new Error('Falha ao carregar face-api.js'));
      document.head.appendChild(s);
    });
  }

  async function ensureModels(){
    if(modelsReady) return;
    if(modelsLoading) return modelsLoading;
    modelsLoading = (async ()=>{
      await loadFaceApi();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODELS_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS_URL),
      ]);
      modelsReady = true;
      // Warmup: roda uma detecção em canvas vazio para aquecer o modelo
      // (a primeira inferência real fica ~3× mais rápida)
      try {
        const c = document.createElement('canvas');
        c.width = 160; c.height = 120;
        await faceapi.detectSingleFace(c, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.9 }));
      } catch(_){}
    })();
    return modelsLoading;
  }

  // ── Firebase: leitura dos descritores cadastrados ────────────────
  function subscribeDescriptors(){
    const ref = firebase.database().ref('faceAuth');
    ref.on('value', snap => {
      const val = snap.val() || {};
      descriptors = {};
      for(const [uid, rec] of Object.entries(val)){
        if(rec && Array.isArray(rec.descriptor) && rec.descriptor.length === 128){
          descriptors[uid] = {
            name: rec.name || '',
            pin:  rec.pin  || '',
            descriptor: new Float32Array(rec.descriptor),
          };
        }
      }
      dbReady = true;
      updateLoginUI();
      // Pré-carrega modelos em background assim que soubermos que há rostos cadastrados
      if(Object.keys(descriptors).length > 0){
        ensureModels().catch(()=>{});
      }
    });
  }

  async function saveDescriptor(user, descriptor){
    await firebase.database().ref('faceAuth/'+user.id).set({
      name: user.name,
      pin:  user.pin || '',
      descriptor: Array.from(descriptor),
      updatedAt: Date.now(),
    });
  }

  async function deleteDescriptor(uid){
    await firebase.database().ref('faceAuth/'+uid).remove();
  }

  // ── Câmera ───────────────────────────────────────────────────────
  async function startCamera(videoEl){
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 360 } },
      audio: false,
    });
    videoStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();
  }
  function stopCamera(){
    if(scanTimer){ clearInterval(scanTimer); scanTimer = null; }
    if(videoStream){
      videoStream.getTracks().forEach(t=>t.stop());
      videoStream = null;
    }
  }

  let consecutiveHits = 0;  // exige 2 frames consecutivos para confirmar

  // ── Comparação ───────────────────────────────────────────────────
  function bestMatch(query){
    let bestUid=null, bestDist=Infinity;
    for(const [uid, rec] of Object.entries(descriptors)){
      const d = faceapi.euclideanDistance(query, rec.descriptor);
      if(d < bestDist){ bestDist = d; bestUid = uid; }
    }
    return { uid: bestUid, dist: bestDist };
  }

  // ════════════════════════════════════════════════════════════════
  // UI: MODAL DE LOGIN FACIAL
  // ════════════════════════════════════════════════════════════════
  function buildModal(){
    if(document.getElementById('fa-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'fa-modal';
    wrap.innerHTML = `
      <div class="fa-card">
        <div class="fa-head">
          <div class="fa-title" id="fa-title">Login facial</div>
          <button class="fa-close" id="fa-close" type="button">×</button>
        </div>
        <div class="fa-video-wrap">
          <video id="fa-video" autoplay muted playsinline></video>
          <div class="fa-frame"></div>
        </div>
        <div class="fa-status" id="fa-status">Posicione seu rosto na câmera…</div>
        <div class="fa-actions" id="fa-actions"></div>
      </div>`;
    document.body.appendChild(wrap);
    document.getElementById('fa-close').onclick = closeModal;
    wrap.addEventListener('click', e => { if(e.target === wrap) closeModal(); });
  }

  function setStatus(msg, kind){
    const el = document.getElementById('fa-status');
    if(!el) return;
    el.textContent = msg;
    el.className = 'fa-status' + (kind ? ' fa-'+kind : '');
  }

  function openModal(){
    buildModal();
    consecutiveHits = 0;
    document.getElementById('fa-modal').classList.add('open');
    document.getElementById('fa-actions').innerHTML = '';
  }
  function closeModal(){
    stopCamera();
    const m = document.getElementById('fa-modal');
    if(m) m.classList.remove('open');
  }

  // ── Fluxo: RECONHECER e fazer login ──────────────────────────────
  async function runRecognition(){
    if(Object.keys(descriptors).length === 0){
      setStatus('Nenhum rosto cadastrado ainda. Faça login pelo PIN primeiro.', 'err');
      return;
    }
    openModal();
    document.getElementById('fa-title').textContent = 'Entrar com rosto';
    setStatus('Carregando modelos…');
    try {
      await ensureModels();
      const video = document.getElementById('fa-video');
      await startCamera(video);
      setStatus('Olhe para a câmera…');
      scanDeadline = Date.now() + SCAN_TIMEOUT;
      scanTimer = setInterval(async ()=>{
        if(Date.now() > scanDeadline){
          stopCamera();
          setStatus('Tempo esgotado. Tente novamente ou use o PIN.', 'err');
          return;
        }
        const det = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.45 }))
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if(!det){ consecutiveHits = 0; return; }
        const m = bestMatch(det.descriptor);
        if(m.dist < MATCH_THRESH){
          consecutiveHits++;
          if(consecutiveHits < 2) return;   // aguarda confirmação no próximo frame
          clearInterval(scanTimer); scanTimer = null;
          const user = users.find(u => u.id === m.uid);
          if(!user || !user.active){
            stopCamera();
            setStatus('Usuário não está mais ativo. Use o PIN.', 'err');
            return;
          }
          setStatus('Olá, '+user.name+' ✓', 'ok');
          stopCamera();
          setTimeout(()=>{
            closeModal();
            loginAs({ id:user.id, name:user.name, sector:user.sector, isAdmin:false });
          }, 600);
        } else {
          consecutiveHits = 0;
        }
      }, SCAN_INTERVAL);
    } catch(err){
      console.error(err);
      setStatus('Erro ao acessar câmera: '+err.message, 'err');
    }
  }

  // ── Fluxo: CADASTRAR rosto do usuário recém-logado ───────────────
  async function runEnrollment(user){
    openModal();
    document.getElementById('fa-title').textContent = 'Cadastrar rosto — '+user.name;
    setStatus('Carregando modelos…');
    try {
      await ensureModels();
      const video = document.getElementById('fa-video');
      await startCamera(video);
      setStatus('Olhe para a câmera e fique parado…');
      // Captura 5 amostras boas e tira média do descritor (mais amostras = melhor precisão)
      const samples = [];
      const deadline = Date.now() + 15000;
      while(samples.length < 5 && Date.now() < deadline){
        const det = await faceapi
          .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.55 }))
          .withFaceLandmarks(true)
          .withFaceDescriptor();
        if(det){
          samples.push(det.descriptor);
          setStatus('Captura '+samples.length+'/5 ✓');
          await new Promise(r=>setTimeout(r, 400));
        } else {
          await new Promise(r=>setTimeout(r, 200));
        }
      }
      stopCamera();
      if(samples.length < 3){
        setStatus('Não consegui capturar seu rosto. Tente novamente em melhor iluminação.', 'err');
        return;
      }
      // Média dos descritores
      const avg = new Float32Array(128);
      for(const s of samples) for(let i=0;i<128;i++) avg[i] += s[i];
      for(let i=0;i<128;i++) avg[i] /= samples.length;
      await saveDescriptor(user, avg);
      setStatus('Rosto cadastrado com sucesso!', 'ok');
      setTimeout(closeModal, 1200);
    } catch(err){
      console.error(err);
      setStatus('Erro: '+err.message, 'err');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // BOTÃO NA TELA DE LOGIN
  // ════════════════════════════════════════════════════════════════
  function injectLoginButton(){
    const pinView = document.getElementById('pin-view');
    if(!pinView || document.getElementById('fa-login-btn')) return;
    const errEl = document.getElementById('pin-error');
    const btn = document.createElement('button');
    btn.id = 'fa-login-btn';
    btn.type = 'button';
    btn.className = 'fa-login-btn';
    btn.innerHTML = '<span style="font-size:18px;line-height:1">🙂</span><span>Entrar com rosto</span>';
    btn.onclick = runRecognition;
    // Inline styles para garantir aparência correta mesmo se o CSS externo não carregar
    btn.style.cssText = [
      'display:none',
      'margin-top:18px',
      'width:100%',
      'padding:12px 16px',
      'align-items:center',
      'justify-content:center',
      'gap:10px',
      'background:linear-gradient(135deg, rgba(16,185,129,.20), rgba(16,185,129,.08))',
      'border:1px solid rgba(16,185,129,.55)',
      'color:#e8f6ef',
      'font-family:inherit',
      'font-size:14px',
      'font-weight:600',
      'border-radius:12px',
      'cursor:pointer',
      'box-shadow:0 4px 14px rgba(16,185,129,.18)',
      'transition:transform .15s ease, background .2s ease, box-shadow .2s ease',
      'letter-spacing:.02em'
    ].join(';');
    (errEl ? errEl.parentNode.insertBefore(btn, errEl.nextSibling) : pinView.appendChild(btn));

  }

  function updateLoginUI(){
    const btn = document.getElementById('fa-login-btn');
    if(!btn) return;
    const has = dbReady && Object.keys(descriptors).length > 0;
    btn.style.display = has ? 'flex' : 'none';
  }

  // ════════════════════════════════════════════════════════════════
  // CONVITE PÓS-LOGIN PARA CADASTRAR ROSTO
  // ════════════════════════════════════════════════════════════════
  function maybeOfferEnrollment(user){
    if(!user || user.isAdmin) return;
    if(descriptors[user.id]) return;                       // já cadastrado
    const dismissedKey = 'faceAuth_dismissed_'+user.id;
    if(localStorage.getItem(dismissedKey)) return;         // usuário recusou
    // Toast convidativo
    showEnrollToast(user, dismissedKey);
  }

  function showEnrollToast(user, dismissedKey){
    const old = document.getElementById('fa-toast');
    if(old) old.remove();
    const t = document.createElement('div');
    t.id = 'fa-toast';
    t.innerHTML = `
      <div class="fa-toast-icon">🙂</div>
      <div class="fa-toast-body">
        <div class="fa-toast-title">Ativar login facial?</div>
        <div class="fa-toast-msg">Próxima vez você entra sem digitar o PIN.</div>
      </div>
      <div class="fa-toast-actions">
        <button type="button" class="fa-toast-no">Agora não</button>
        <button type="button" class="fa-toast-yes">Ativar</button>
      </div>`;
    document.body.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    t.querySelector('.fa-toast-yes').onclick = ()=>{
      t.remove();
      runEnrollment(user);
    };
    t.querySelector('.fa-toast-no').onclick = ()=>{
      localStorage.setItem(dismissedKey, '1');
      t.remove();
    };
    setTimeout(()=>{ if(t.parentNode){ t.classList.remove('show'); setTimeout(()=>t.remove(), 300); } }, 12000);
  }

  // Hook em loginAs para oferecer cadastro após PIN
  function hookLoginAs(){
    const orig = window.loginAs;
    if(!orig || orig.__faceHooked) return;
    window.loginAs = function(user){
      const r = orig.apply(this, arguments);
      try { setTimeout(()=>maybeOfferEnrollment(user), 1500); } catch(e){}
      return r;
    };
    window.loginAs.__faceHooked = true;
  }

  // ════════════════════════════════════════════════════════════════
  // API PÚBLICA — para botão de "remover rosto cadastrado" no admin
  // ════════════════════════════════════════════════════════════════
  window.FaceAuth = {
    enroll: runEnrollment,
    recognize: runRecognition,
    remove: deleteDescriptor,
    list: ()=>Object.keys(descriptors),
  };

  // ── Boot ─────────────────────────────────────────────────────────
  whenReady(()=>{
    subscribeDescriptors();
    injectLoginButton();
    // Hook resiliente porque loginAs pode ser redefinido depois
    let tries = 0;
    const hookTimer = setInterval(()=>{
      hookLoginAs();
      if(window.loginAs && window.loginAs.__faceHooked) clearInterval(hookTimer);
      if(++tries > 60) clearInterval(hookTimer);
    }, 250);
  });
})();

/* === mobile-scanner.js === */

/* ════════════════════════════════════════════════════════════════
   LABTECH — Leitor de Código de Barras (Mobile)
   ─────────────────────────────────────────────────────────────────
   INSTALAÇÃO (1 passo):
     Cole este arquivo na MESMA pasta do index.html e adicione
     UMA linha no <head> do index.html (depois dos outros scripts):

       <script src="mobile-scanner.js" defer></script>

   Pronto. A biblioteca html5-qrcode é carregada automaticamente.
   No celular, cada input "Bipe o código..." ganha um botão 📷.
═══════════════════════════════════════════════════════════════════ */
(function () {
  const MOBILE_BP = 768;
  const LIB_URL = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

  const isMobile = () =>
    window.matchMedia(`(max-width: ${MOBILE_BP}px)`).matches ||
    /Mobi|Android|iPhone/i.test(navigator.userAgent);

  // ── Carrega html5-qrcode dinamicamente ───────────────────────
  let libPromise = null;
  function loadLib() {
    if (typeof Html5Qrcode !== 'undefined') return Promise.resolve();
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Falha ao carregar biblioteca do leitor.'));
      document.head.appendChild(s);
    });
    return libPromise;
  }

  // ── Detecta inputs de "bipe o código" ────────────────────────
  const isBipeInput = (el) => {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.dataset.scannerAttached === '1') return false;
    if (el.type && !['text', 'search', 'tel', 'number', ''].includes(el.type)) return false;
    const ph = (el.placeholder || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    return (
      ph.includes('bipe') ||
      ph.includes('código') ||
      ph.includes('codigo') ||
      ph.includes('barras') ||
      name.includes('barcode') || name.includes('bipe') ||
      id.includes('barcode') || id.includes('bipe') ||
      cls.includes('barcode') || cls.includes('bipe')
    );
  };

  // ── CSS injetado uma vez ────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('mobile-scanner-css')) return;
    const css = document.createElement('style');
    css.id = 'mobile-scanner-css';
    css.textContent = `
      .scan-wrap { position: relative; display: flex; align-items: stretch; gap: 6px; flex: 1; min-width: 0; }
      .scan-wrap > input { flex: 1; min-width: 0; }
      .scan-btn {
        flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        width: 44px; min-width: 44px; min-height: 38px;
        border-radius: 10px;
        background: var(--accent, #10b981);
        border: 1px solid var(--accent, #10b981);
        color: #fff; font-size: 18px; cursor: pointer;
        box-shadow: 0 0 10px rgba(16,185,129,.35);
        transition: transform .1s ease, filter .15s;
      }
      .scan-btn:hover { filter: brightness(1.1); }
      .scan-btn:active { transform: scale(.94); }

      #scan-modal {
        position: fixed; inset: 0; z-index: 99999;
        background: rgba(0,0,0,.92);
        display: none; flex-direction: column;
        align-items: center; justify-content: center;
        padding: 16px;
      }
      #scan-modal.open { display: flex; }
      #scan-modal .scan-card {
        width: 100%; max-width: 460px;
        background: var(--bg2, #0f131a);
        border: 1px solid var(--border, rgba(148,163,184,.4));
        border-radius: 16px; padding: 14px;
        box-shadow: 0 20px 60px rgba(0,0,0,.6);
      }
      #scan-modal .scan-title {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 10px; color: var(--text, #e2e8f0);
        font-family: var(--font, sans-serif); font-weight: 600;
      }
      #scan-modal .scan-close {
        background: transparent; border: 0; color: var(--muted, #94a3b8);
        font-size: 28px; line-height: 1; cursor: pointer; padding: 4px 10px;
      }
      #scan-reader { width: 100%; border-radius: 12px; overflow: hidden; background: #000; }
      #scan-reader video { width: 100% !important; height: auto !important; display: block; }
      #scan-status {
        margin-top: 10px; font-size: 12px; color: var(--muted, #94a3b8);
        text-align: center; min-height: 16px;
      }
    `;
    document.head.appendChild(css);
  }

  // ── Modal singleton ─────────────────────────────────────────
  let modal, statusEl, html5, activeInput = null;

  function ensureModal() {
    if (modal) return;
    modal = document.createElement('div');
    modal.id = 'scan-modal';
    modal.innerHTML = `
      <div class="scan-card">
        <div class="scan-title">
          <span>📷 Leitor de código</span>
          <button class="scan-close" type="button" aria-label="Fechar">×</button>
        </div>
        <div id="scan-reader"></div>
        <div id="scan-status">Aponte para o código de barras…</div>
      </div>`;
    document.body.appendChild(modal);
    statusEl = modal.querySelector('#scan-status');
    modal.querySelector('.scan-close').addEventListener('click', closeScanner);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeScanner(); });
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 880;
      g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, 120);
    } catch (_) {}
  }

  async function openScanner(input) {
    ensureModal();
    activeInput = input;
    modal.classList.add('open');
    statusEl.textContent = 'Carregando câmera…';

    try { await loadLib(); }
    catch (e) { statusEl.textContent = e.message; return; }

    html5 = new Html5Qrcode('scan-reader', { verbose: false });
    const config = {
      fps: 12,
      qrbox: (vw, vh) => {
        const m = Math.min(vw, vh);
        return { width: Math.round(m * 0.85), height: Math.round(m * 0.45) };
      },
      aspectRatio: 1.6,
    };

    html5.start({ facingMode: { exact: 'environment' } }, config, onScanSuccess)
      .catch(() => {
        html5.start({ facingMode: 'environment' }, config, onScanSuccess)
          .catch((err) => { statusEl.textContent = 'Câmera indisponível: ' + err; });
      });
  }

  function onScanSuccess(decodedText) {
    if (!activeInput) return closeScanner();
    activeInput.value = decodedText;
    activeInput.dispatchEvent(new Event('input', { bubbles: true }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    ['keydown','keypress','keyup'].forEach(t =>
      activeInput.dispatchEvent(new KeyboardEvent(t, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
      }))
    );
    if (navigator.vibrate) navigator.vibrate(80);
    beep();
    statusEl.textContent = '✓ Lido: ' + decodedText;
    setTimeout(closeScanner, 250);
  }

  function closeScanner() {
    if (html5) {
      html5.stop().catch(() => {}).finally(() => {
        try { html5.clear(); } catch (_) {}
        html5 = null;
      });
    }
    if (modal) modal.classList.remove('open');
    if (activeInput) { try { activeInput.focus(); } catch (_) {} }
    activeInput = null;
  }

  // ── Anexa botão ao input ────────────────────────────────────
  function attachTo(input) {
    if (!isBipeInput(input)) return;
    input.dataset.scannerAttached = '1';
    const parent = input.parentElement;
    if (!parent) return;

    const wrap = document.createElement('div');
    wrap.className = 'scan-wrap';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scan-btn';
    btn.title = 'Ler código de barras';
    btn.setAttribute('aria-label', 'Ler código de barras');
    btn.textContent = '📷';
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openScanner(input);
    });
    wrap.appendChild(btn);
  }

  function scanAll(root) {
    if (!isMobile()) return;
    (root || document).querySelectorAll('input').forEach(attachTo);
  }

  function observe() {
    const mo = new MutationObserver((muts) => {
      if (!isMobile()) return;
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          if (n.tagName === 'INPUT') attachTo(n);
          else if (n.querySelectorAll) n.querySelectorAll('input').forEach(attachTo);
        });
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    injectCSS();
    scanAll();
    observe();
    window.addEventListener('resize', () => scanAll(), { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* === alarme.js === */

(function () {
  'use strict';

  var FB_PATH = '/alarme_global';
  var SONS = {
    urgente : { freqs:[880,660,880,660], dur:0.18, gap:0.04, rep:3, interval:800  },
    aviso   : { freqs:[660,550],         dur:0.22, gap:0.06, rep:2, interval:1200 },
    info    : { freqs:[520,660],         dur:0.25, gap:0.08, rep:1, interval:2000 },
  };
  var CORES = {
    urgente : { bg:'#fee2e2', border:'#ef4444', text:'#7f1d1d', badge:'#ef4444', icon:'🚨' },
    aviso   : { bg:'#fef3c7', border:'#f59e0b', text:'#78350f', badge:'#f59e0b', icon:'⚠️' },
    info    : { bg:'#dbeafe', border:'#3b82f6', text:'#1e3a5f', badge:'#3b82f6', icon:'ℹ️' },
  };

  var _ctx = null, _loop = null, _state = null, _fbRef = null, _styled = false;
  var _checkInterval = null;

  /* ── AudioContext ── */
  function _audio() {
    if (!_ctx) try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e){}
    if (_ctx && _ctx.state === 'suspended') _ctx.resume().catch(function(){});
    return _ctx;
  }
  function _unlock() { _audio(); document.removeEventListener('click',_unlock,true); document.removeEventListener('touchstart',_unlock,true); }
  document.addEventListener('click',_unlock,true);
  document.addEventListener('touchstart',_unlock,true);

  /* ── Beep ── */
  function _beep(cfg) {
    var ctx = _audio(); if (!ctx) return;
    var t = ctx.currentTime + 0.05;
    cfg.freqs.forEach(function(hz){
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.setValueAtTime(hz, t);
      g.gain.setValueAtTime(0,t);
      g.gain.linearRampToValueAtTime(0.35, t+0.01);
      g.gain.linearRampToValueAtTime(0, t+cfg.dur);
      o.start(t); o.stop(t+cfg.dur+0.02);
      t += cfg.dur + cfg.gap;
    });
  }
  function _startLoop(tipo) {
    _stopLoop();
    var cfg = SONS[tipo]||SONS.aviso, rep=0;
    function ciclo(){
      if (!_state||!_state.ativa) return;
      _beep(cfg); rep++;
      var beatLen = cfg.freqs.length*(cfg.dur+cfg.gap)*1000+80;
      if (rep < cfg.rep) setTimeout(ciclo, beatLen);
      else _loop = setTimeout(function(){ rep=0; ciclo(); }, cfg.interval);
    }
    ciclo();
  }
  function _stopLoop(){ if(_loop){clearTimeout(_loop);_loop=null;} }

  /* ── Estilos ── */
  function _styles() {
    if (_styled) return; _styled = true;
    var s = document.createElement('style');
    s.textContent =
      '@keyframes alm-in{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:translateY(0)}}'+
      '@keyframes alm-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}40%{transform:translateX(6px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}'+
      '@keyframes alm-pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,0,0,.12)}50%{box-shadow:0 0 0 8px rgba(0,0,0,0)}}'+
      '#alm-banner{position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;font-family:var(--font,Outfit,sans-serif);animation:alm-in .3s ease,alm-pulse 1.8s ease-in-out infinite;border-bottom:3px solid #ef4444}'+
      '#alm-banner.shake{animation:alm-shake .4s ease}'+
      '#alm-banner .al{display:flex;align-items:center;gap:10px;flex:1;min-width:0}'+
      '#alm-banner .ai{font-size:22px;flex-shrink:0}'+
      '#alm-banner .am{font-size:14px;font-weight:600;line-height:1.35;word-break:break-word}'+
      '#alm-banner .at{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border-radius:20px;color:#fff;flex-shrink:0}'+
      '#alm-banner .aa{display:flex;align-items:center;gap:8px;flex-shrink:0}'+
      '#alm-banner .ab{border:none;border-radius:8px;font-family:inherit;font-size:12px;font-weight:700;padding:7px 14px;cursor:pointer;white-space:nowrap}'+
      '#alm-banner .ab:hover{opacity:.8}'+
      '#alm-banner .ab-f{background:rgba(0,0,0,.15)}'+
      '#alm-banner .ab-f{color:inherit}'+
      '#alm-banner .ab-e{background:#ef4444;color:#fff}'+
      '#alm-ov{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto}'+
      '#alm-p{background:var(--bg2,#1e2130);border:1px solid var(--border2,#2e3347);border-radius:16px;padding:24px;width:100%;max-width:420px;font-family:var(--font,Outfit,sans-serif);color:var(--text,#e8eaf0);margin:auto}'+
      '#alm-p h3{margin:0 0 4px;font-size:17px;font-weight:700}'+
      '#alm-p h4{margin:0 0 8px;font-size:14px;font-weight:700;color:var(--accent,#3b82f6)}'+
      '#alm-p .sub{margin:0 0 18px;font-size:12px;color:var(--muted,#6b7280)}'+
      '#alm-p label{font-size:12px;font-weight:600;color:var(--muted,#6b7280);display:block;margin-bottom:6px}'+
      '#alm-p textarea{width:100%;box-sizing:border-box;background:var(--bg3,#252a3a);border:1px solid var(--border2,#2e3347);border-radius:8px;color:var(--text,#e8eaf0);font-family:inherit;font-size:13px;padding:10px 12px;resize:vertical;min-height:72px;outline:none}'+
      '#alm-p input, #alm-p select{width:100%;box-sizing:border-box;background:var(--bg3,#252a3a);border:1px solid var(--border2,#2e3347);border-radius:8px;color:var(--text,#e8eaf0);font-family:inherit;font-size:13px;padding:8px 10px;outline:none}'+
      '#alm-p .tbtns{display:flex;gap:8px;margin:14px 0 20px}'+
      '#alm-p .tbtn{flex:1;padding:9px 8px;border-radius:9px;border:1.5px solid var(--border2,#2e3347);background:var(--bg3,#252a3a);color:var(--muted,#6b7280);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer;text-align:center;transition:all .15s}'+
      '#alm-p .tbtn.su{background:#fee2e2;border-color:#ef4444;color:#7f1d1d}'+
      '#alm-p .tbtn.sa{background:#fef3c7;border-color:#f59e0b;color:#78350f}'+
      '#alm-p .tbtn.si{background:#dbeafe;border-color:#3b82f6;color:#1e3a5f}'+
      '#alm-p .row{display:flex;gap:8px}'+
      '#alm-p .row button{flex:1;min-height:42px;font-size:13px;border-radius:9px;border:none;cursor:pointer;font-family:inherit;font-weight:700}'+
      '#alm-p .bd{background:var(--accent,#3b82f6);color:#fff}'+
      '#alm-p .bc{background:var(--bg3,#252a3a);color:var(--muted,#6b7280);border:1px solid var(--border2,#2e3347)!important}'+
      '#alm-p .benc{width:100%;margin-top:10px;min-height:40px;background:#ef4444;color:#fff;border:none;border-radius:9px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer}'+
      '#alm-p .rec-item{display:flex;align-items:center;justify-content:space-between;background:var(--bg3,#252a3a);padding:8px 12px;border-radius:8px;margin-bottom:6px;border:1px solid var(--border2,#2e3347)}'+
      '#alm-p .rec-time{font-family:monospace;font-size:14px;font-weight:700;color:var(--accent,#3b82f6)}'+
      '#alm-p .rec-msg{font-size:12px;color:var(--text,#e8eaf0);margin-left:8px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'+
      '#alm-p .rec-del{background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:0 4px;opacity:0.7}'+
      '#alm-p .rec-del:hover{opacity:1}'+
      '#alm-fab{position:fixed;bottom:24px;right:24px;z-index:9998;width:52px;height:52px;border-radius:50%;border:none;background:var(--accent,#3b82f6);color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .15s,box-shadow .15s}'+
      '#alm-fab:hover{transform:scale(1.1);box-shadow:0 6px 24px rgba(0,0,0,.45)}';
    document.head.appendChild(s);
  }

  /* ── Banner ── */
  function _rmBanner(){ var b=document.getElementById('alm-banner'); if(b)b.remove(); }
  function _showBanner(st) {
    _rmBanner(); if(!st||!st.ativa) return;
    var tipo=st.tipo||'aviso', cor=CORES[tipo]||CORES.aviso;
    var isAdmin = typeof currentUser!=='undefined' && currentUser && currentUser.isAdmin;
    var b = document.createElement('div');
    b.id='alm-banner';
    b.style.cssText='background:'+cor.bg+';border-color:'+cor.border+';color:'+cor.text;
    b.innerHTML=
      '<div class="al"><span class="ai">'+cor.icon+'</span>'+
      '<span class="am">'+_esc(st.msg||'Alarme!')+'</span></div>'+
      '<div class="aa">'+
      '<span class="at" style="background:'+cor.badge+'">'+tipo+'</span>'+
      (isAdmin
        ? '<button class="ab ab-e" onclick="Alarme.encerrar()">Encerrar</button>'
        : '<span style="font-size:11px;opacity:.7">Aguarde instrução</span>')+
      '<button class="ab ab-f" onclick="document.getElementById(\'alm-banner\').style.display=\'none\'">✕</button>'+
      '</div>';
    document.body.prepend(b);
    setTimeout(function(){
      if(b.parentNode){ b.classList.add('shake');
        setTimeout(function(){ if(b.parentNode)b.classList.remove('shake'); },450); }
    },400);
  }
  function _esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ── Aplicar estado ── */
  function _apply(st) {
    _state = st;
    var isAdmin = typeof currentUser!=='undefined' && currentUser && currentUser.isAdmin;
    
    // RESTRIÇÃO PARA ADMINS: Só toca/mostra se for admin
    if (!isAdmin) {
       _rmBanner(); _stopLoop();
       return;
    }

    if (st && st.ativa) { _styles(); _showBanner(st); _startLoop(st.tipo||'aviso'); }
    else { _rmBanner(); _stopLoop(); }
  }

  /* ── Verificação de Alarmes Recorrentes ── */
  function _checkRecurring() {
    var isAdmin = typeof currentUser!=='undefined' && currentUser && currentUser.isAdmin;
    // Só o admin (que está na tela) engatilha o alarme global recorrente.
    if (!isAdmin || !_state || !_state.recorrentes) return;

    var now = new Date();
    var hhmm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
    
    var lastTriggered = localStorage.getItem('alm_last_rec') || '';
    if (lastTriggered !== hhmm) {
       var keys = Object.keys(_state.recorrentes);
       for(var i=0; i<keys.length; i++){
          var rec = _state.recorrentes[keys[i]];
          if (rec.hora === hhmm) {
             localStorage.setItem('alm_last_rec', hhmm);
             if (_fbRef) {
                _fbRef.update({
                   msg: rec.msg || 'Alarme Automático',
                   tipo: rec.tipo || 'aviso',
                   ts: Date.now(),
                   ativa: true
                });
             }
             break; // dispara apenas 1 por minuto se houver coincidência
          }
       }
    }
  }

  /* ── Firebase listener ── */
  function _connect(tries) {
    tries = tries||0;
    if (typeof firebase!=='undefined' && firebase.database) {
      _fbRef = firebase.database().ref(FB_PATH);
      _fbRef.on('value', function(snap){ _apply(snap.val()); });
      if (!_checkInterval) _checkInterval = setInterval(_checkRecurring, 10000); // checa a cada 10s
    } else if (tries<80) {
      setTimeout(function(){ _connect(tries+1); }, 250);
    }
  }
  _connect();

  /* ── Painel admin ── */
  function _painel() {
    _styles();
    var ov = document.getElementById('alm-ov'); if(ov){ov.remove();return;}
    ov = document.createElement('div'); ov.id='alm-ov';
    var tipoSel='urgente';
    
    function render(){
      var tipos=['urgente','aviso','info'];
      
      // Monta lista de recorrentes
      var recListHtml = '';
      if (_state && _state.recorrentes) {
         var keys = Object.keys(_state.recorrentes);
         if(keys.length > 0) {
            keys.forEach(function(k){
               var r = _state.recorrentes[k];
               var badge = CORES[r.tipo||'aviso'].icon;
               recListHtml += '<div class="rec-item">'+
                              '<div><span class="rec-time">'+r.hora+'</span>'+
                              '<span class="rec-msg" title="'+_esc(r.msg)+'">'+badge+' '+_esc(r.msg)+'</span></div>'+
                              '<button class="rec-del" data-id="'+k+'" title="Remover">🗑️</button>'+
                              '</div>';
            });
         } else {
            recListHtml = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Nenhum alarme recorrente cadastrado.</div>';
         }
      } else {
         recListHtml = '<div style="font-size:12px;color:var(--muted);margin-bottom:8px">Nenhum alarme recorrente cadastrado.</div>';
      }

      ov.innerHTML=
        '<div id="alm-p">'+
        '<h3>🔔 Disparar Alarme</h3>'+
        '<p class="sub">Toca em <b>todas</b> as telas logadas como admin em tempo real.</p>'+
        '<label>Mensagem</label>'+
        '<textarea id="alm-ta" placeholder="Ex: Atenção — Verificar Setor A"></textarea>'+
        '<label>Tipo</label>'+
        '<div class="tbtns">'+
        tipos.map(function(t){
          var c=CORES[t], cls='tbtn'+(t===tipoSel?' s'+t[0]:'');
          return '<button class="'+cls+'" data-t="'+t+'">'+c.icon+' '+t+'</button>';
        }).join('')+
        '</div>'+
        '<div class="row">'+
        '<button class="bd" id="alm-disp">Disparar agora</button>'+
        '<button class="bc" id="alm-canc">Cancelar</button>'+
        '</div>'+
        (_state&&_state.ativa?'<button class="benc" id="alm-enc">⛔ Encerrar alarme ativo</button>':'')+
        
        '<hr style="border:0; border-top:1px solid var(--border2); margin:20px 0 16px">'+
        '<h4>⏰ Alarmes Recorrentes (Diários)</h4>'+
        '<div id="alm-rec-list" style="max-height:140px;overflow-y:auto;margin-bottom:12px;padding-right:4px">'+recListHtml+'</div>'+
        
        '<label>Adicionar Recorrente</label>'+
        '<div style="display:flex;gap:6px;align-items:center">'+
        '<input type="time" id="alm-rec-time" style="width:85px;flex-shrink:0">'+
        '<input type="text" id="alm-rec-msg" placeholder="Msg (ex: Pausa)" style="flex:1">'+
        '<select id="alm-rec-tipo" style="width:80px;flex-shrink:0">'+
           '<option value="urgente">🚨 Urg</option>'+
           '<option value="aviso" selected>⚠️ Avi</option>'+
           '<option value="info">ℹ️ Inf</option>'+
        '</select>'+
        '<button id="alm-rec-add" class="bd" style="width:36px;min-height:35px;border-radius:8px;font-size:18px">+</button>'+
        '</div>'+
        '</div>';
        
      ov.querySelectorAll('.tbtn').forEach(function(btn){
        btn.onclick=function(){ tipoSel=this.dataset.t; render();
          var ta=ov.querySelector('#alm-ta'); if(ta)ta.focus(); };
      });
      ov.querySelector('#alm-canc').onclick=function(){ ov.remove(); };
      ov.querySelector('#alm-disp').onclick=function(){
        var msg=(ov.querySelector('#alm-ta').value||'').trim();
        if(!msg){ov.querySelector('#alm-ta').focus();return;}
        window.Alarme.disparar(msg,tipoSel); ov.remove();
      };
      
      var enc=ov.querySelector('#alm-enc');
      if(enc) enc.onclick=function(){ window.Alarme.encerrar(); ov.remove(); };
      
      // Handlers para Recorrentes
      ov.querySelectorAll('.rec-del').forEach(function(btn){
         btn.onclick = function() {
            var id = this.dataset.id;
            if (_fbRef) _fbRef.child('recorrentes').child(id).remove();
            setTimeout(render, 300); // re-render after short delay to let firebase sync
         };
      });
      
      var btnAddRec = ov.querySelector('#alm-rec-add');
      if(btnAddRec) {
         btnAddRec.onclick = function() {
            var timeVal = ov.querySelector('#alm-rec-time').value;
            var msgVal = (ov.querySelector('#alm-rec-msg').value||'').trim();
            var tipoVal = ov.querySelector('#alm-rec-tipo').value;
            if(!timeVal || !msgVal) return;
            if (_fbRef) {
               _fbRef.child('recorrentes').push({
                  hora: timeVal,
                  msg: msgVal,
                  tipo: tipoVal
               });
            }
            setTimeout(render, 300);
         };
      }
      
      ov.onclick=function(e){ if(e.target===ov)ov.remove(); };
    }
    render();
    document.body.appendChild(ov);
    setTimeout(function(){ var ta=ov.querySelector('#alm-ta'); if(ta)ta.focus(); },60);
  }

  /* ── Adiciona o botão FAB na tela ── */
  function _addFab() {
    if(document.getElementById('alm-fab')) return;
    _styles();
    var f=document.createElement('button');
    f.id='alm-fab'; f.title='Alarme'; f.textContent='🔔';
    f.onclick=function(){ _painel(); };
    document.body.appendChild(f);
  }
  function _removeFab() {
    var f=document.getElementById('alm-fab'); if(f)f.remove();
  }

  /* ── Hook no loginAs/logout do sistema para mostrar/esconder FAB ── */
  function _hookLoginAs(tries) {
    tries = tries||0;
    if (typeof loginAs === 'function' && !window.__almHooked) {
      window.__almHooked = true;
      var _origLogin = loginAs;
      window.loginAs = function(u) {
        var r = _origLogin.apply(this, arguments);
        if (u && u.isAdmin) _addFab();
        else _removeFab();
        return r;
      };
      var _origLogout = typeof logout === 'function' ? logout : null;
      if (_origLogout) {
        window.logout = function() {
          var r = _origLogout.apply(this, arguments);
          _removeFab();
          return r;
        };
      }
      if (typeof currentUser !== 'undefined' && currentUser && currentUser.isAdmin) {
        _addFab();
      }
    } else if (!window.__almHooked && tries < 100) {
      setTimeout(function(){ _hookLoginAs(tries+1); }, 100);
    }
  }
  _hookLoginAs();

  /* ── API pública ── */
  window.Alarme = {
    disparar: function(msg,tipo){
      tipo=tipo||'aviso'; if(!SONS[tipo])tipo='aviso';
      if(!_fbRef){console.warn('[Alarme] Firebase não pronto');return;}
      _fbRef.update({msg:msg||'Alarme!',tipo:tipo,ts:Date.now(),ativa:true});
    },
    encerrar: function(){
      if(_fbRef) _fbRef.update({ativa:false,ts:Date.now()});
    },
    abrirPainel: _painel,
  };
})();


// ════════════════════════════════════════════════════════════════════════
// BIPAGEM EM MASSA — Consulta SELB no Supabase do Pietro e registra
// como Máquina A no Firebase do LabTech.
// REST direto contra a API do Supabase do Pietro (sem dependências novas).
// ════════════════════════════════════════════════════════════════════════
const PIETRO_URL = 'https://idpmrjjalhnpsxpfugph.supabase.co';
const PIETRO_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlkcG1yamphbGhucHN4cGZ1Z3BoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjU2NjcsImV4cCI6MjA5MzI0MTY2N30.L4hV7YM9yjdOOW9zBl84L-1si2DU8nBI3J1WgmW02lY';
const PIETRO_SELB_COLS = ['selb','codigo','code','numero_selb','selb_codigo','id_selb'];
const PIETRO_MODELO_COLS = ['modelo','equipamento','nome','descricao','model'];
let _pietroToken = sessionStorage.getItem('pietro_token') || null;
let _pietroSelbCol = sessionStorage.getItem('pietro_selb_col') || null;
let _biparFila = []; // [{ selb, modelo }]

function _pietroHeaders(){
  const h = { apikey: PIETRO_ANON, 'Content-Type':'application/json' };
  if(_pietroToken) h['Authorization'] = 'Bearer ' + _pietroToken;
  return h;
}

async function biparPietroLogin(){
  const email = (document.getElementById('bipar-email').value||'').trim();
  const pass  = document.getElementById('bipar-pass').value||'';
  const err   = document.getElementById('bipar-login-err');
  const btn   = document.getElementById('bipar-login-btn');
  err.textContent = '';
  if(!email || !pass){ err.textContent = 'Informe e-mail e senha.'; return; }
  btn.disabled = true; btn.textContent = 'Entrando...';
  try {
    const r = await fetch(PIETRO_URL+'/auth/v1/token?grant_type=password',{
      method:'POST', headers:{apikey:PIETRO_ANON,'Content-Type':'application/json'},
      body: JSON.stringify({ email, password: pass })
    });
    const j = await r.json();
    if(!r.ok || !j.access_token){ throw new Error(j.error_description || j.msg || 'Falha no login'); }
    _pietroToken = j.access_token;
    sessionStorage.setItem('pietro_token', _pietroToken);
    document.getElementById('bipar-login-box').style.display = 'none';
    document.getElementById('bipar-scan-box').style.display = 'flex';
    setTimeout(()=>document.getElementById('bipar-input').focus(),60);
  } catch(e){
    err.textContent = 'Erro: '+e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Entrar';
  }
}

async function _pietroFetchModelo(selb){
  // Descobre coluna SELB na 1ª chamada
  const cols = _pietroSelbCol ? [_pietroSelbCol] : PIETRO_SELB_COLS;
  for(const col of cols){
    const url = PIETRO_URL+'/rest/v1/equipamentos?'+col+'=eq.'+encodeURIComponent(selb)+'&select=*&limit=1';
    let r;
    try { r = await fetch(url,{ headers:_pietroHeaders() }); } catch(e){ continue; }
    if(r.status === 400){ continue; } // coluna não existe
    if(r.status === 401 || r.status === 403){
      _pietroToken = null; sessionStorage.removeItem('pietro_token');
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if(!r.ok) continue;
    const arr = await r.json();
    if(Array.isArray(arr)){
      if(!_pietroSelbCol){ _pietroSelbCol = col; sessionStorage.setItem('pietro_selb_col', col); }
      if(arr.length === 0) return null;
      const row = arr[0];
      for(const mc of PIETRO_MODELO_COLS){ if(row[mc]) return String(row[mc]); }
      // fallback: 1ª string não-id encontrada
      for(const [k,v] of Object.entries(row)){
        if(typeof v === 'string' && !/^id|uuid|created|updated/i.test(k)) return v;
      }
      return '—';
    }
  }
  return null;
}

function abrirModalBiparMaquinasA(){
  if(!currentUser){ alert('Faça login no LabTech primeiro.'); return; }
  _biparFila = [];
  _biparRenderLista();
  document.getElementById('bipar-input').value = '';
  document.getElementById('bipar-status').textContent = '';
  document.getElementById('bipar-login-err').textContent = '';
  document.getElementById('modal-bipar-maquinas-a').style.display = 'flex';
  if(_pietroToken){
    document.getElementById('bipar-login-box').style.display = 'none';
    document.getElementById('bipar-scan-box').style.display = 'flex';
    setTimeout(()=>document.getElementById('bipar-input').focus(),80);
  } else {
    document.getElementById('bipar-login-box').style.display = 'flex';
    document.getElementById('bipar-scan-box').style.display = 'none';
    setTimeout(()=>document.getElementById('bipar-email').focus(),80);
  }
  // ENTER no input dispara add
  const inp = document.getElementById('bipar-input');
  inp.onkeydown = (e)=>{ if(e.key==='Enter'){ e.preventDefault(); biparAddSelb(); } };
}

async function biparAddSelb(){
  const inp = document.getElementById('bipar-input');
  const status = document.getElementById('bipar-status');
  const selb = (inp.value||'').trim().toUpperCase();
  if(!selb) return;
  if(_biparFila.some(x=>x.selb===selb)){
    status.innerHTML = '<span style="color:var(--warn)">⚠ SELB '+selb+' já está na fila.</span>';
    inp.value=''; inp.focus(); return;
  }
  if(typeof _maquinasA === 'object' && Object.values(_maquinasA||{}).some(m=>m.selb===selb && m.status==='ativa')){
    status.innerHTML = '<span style="color:var(--warn)">⚠ SELB '+selb+' já está registrado como Máquina A.</span>';
    inp.value=''; inp.focus(); return;
  }
  status.innerHTML = '<span style="color:var(--muted)">🔎 Buscando '+selb+' no Pietro...</span>';
  try {
    const modelo = await _pietroFetchModelo(selb);
    if(modelo === null){
      _biparFila.push({ selb, modelo: '— não encontrado —', _notFound:true });
      status.innerHTML = '<span style="color:var(--danger)">✕ SELB '+selb+' não encontrado no Pietro.</span>';
    } else {
      _biparFila.push({ selb, modelo });
      status.innerHTML = '<span style="color:#10b981">✓ '+selb+' → '+modelo+'</span>';
    }
    _biparRenderLista();
  } catch(e){
    status.innerHTML = '<span style="color:var(--danger)">Erro: '+e.message+'</span>';
    if(/login/i.test(e.message)){
      document.getElementById('bipar-login-box').style.display = 'flex';
      document.getElementById('bipar-scan-box').style.display = 'none';
    }
  }
  inp.value=''; inp.focus();
}

function _biparRenderLista(){
  const tb = document.getElementById('bipar-lista');
  document.getElementById('bipar-count').textContent = _biparFila.length;
  if(!_biparFila.length){
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:24px 12px;font-size:12px">Nenhum SELB bipado ainda.</td></tr>';
    return;
  }
  tb.innerHTML = _biparFila.map((x,i)=>(
    '<tr>'+
      '<td style="color:var(--muted)">'+(i+1)+'</td>'+
      '<td style="font-family:var(--mono);font-weight:600">'+x.selb+'</td>'+
      '<td style="color:'+(x._notFound?'var(--danger)':'var(--text)')+'">'+x.modelo+'</td>'+
      '<td><button onclick="biparRemove('+i+')" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:16px">×</button></td>'+
    '</tr>'
  )).join('');
}

function biparRemove(i){ _biparFila.splice(i,1); _biparRenderLista(); }
function biparLimpar(){ _biparFila = []; _biparRenderLista(); document.getElementById('bipar-status').textContent=''; }

async function biparSalvarTudo(){
  const validos = _biparFila.filter(x=>!x._notFound);
  if(!validos.length){ alert('Nenhum SELB válido para salvar.'); return; }
  if(!confirm('Salvar '+validos.length+' SELB(s) como Máquina A?')) return;
  const btn = document.getElementById('bipar-salvar-btn');
  btn.disabled = true; btn.textContent = 'Salvando...';
  const status = document.getElementById('bipar-status');
  let ok = 0, fail = 0;
  for(const item of validos){
    // pula se já virou Máquina A enquanto bipava
    if(Object.values(_maquinasA||{}).some(m=>m.selb===item.selb && m.status==='ativa')){ continue; }
    const id = 'ma_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
    const registro = {
      selb: item.selb,
      equipamento: item.modelo || '—',
      setor: '—',
      observacao: 'Bipado em massa (origem: Pietro)',
      registradoPor: (currentUser && currentUser.name) || 'Operador',
      registradoEm: new Date().toISOString(),
      status: 'ativa'
    };
    try {
      await dbSet('/maquinas_a/' + id, registro);
      _maquinasA[id] = registro;
      if(typeof fluxolabRemoveSelbGlobal === 'function'){
        fluxolabRemoveSelbGlobal(item.selb).catch(()=>{});
      }
      ok++;
    } catch(e){ fail++; }
  }
  status.innerHTML = '<span style="color:#10b981">✓ '+ok+' salvo(s)</span>'+(fail?' <span style="color:var(--danger)">· '+fail+' falha(s)</span>':'');
  _biparFila = []; _biparRenderLista();
  if(typeof renderMaquinasAView === 'function') renderMaquinasAView();
  btn.disabled = false; btn.textContent = '💾 Salvar tudo como Máquina A';
  setTimeout(()=>{ closeModal('modal-bipar-maquinas-a'); }, 1200);
}
