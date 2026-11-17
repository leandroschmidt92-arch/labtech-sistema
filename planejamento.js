// ════════════════════════════════════════════════════════════════
// PLANEJAMENTO DO DIA (STATE, DRAG & DROP E MULTIPLAYER REALTIME)
// ════════════════════════════════════════════════════════════════
let _fluxolabPlanejamentoState = { tabela1: [], tabela2: [], tabela3: [] };
let _fluxolabPlanLoaded = false;
let _planSyncChannel = null;
let _planMediaSortDir = { tabela1: null, tabela2: null, tabela3: null }; // null | 'desc' | 'asc'

// Quantidade mínima de linhas de cada tabela. Todas as tabelas são expansíveis:
// começam enxutas e mantêm sempre 1 linha vazia extra no final após a última
// linha preenchida, crescendo conforme novos modelos são digitados e retraindo
// automaticamente quando linhas são removidas/esvaziadas.
const FLUXOLAB_PLAN_MIN_ROWS = { tabela1: 1, tabela2: 1, tabela3: 1 };
const FLUXOLAB_PLAN_TABLE_LABELS = {
  tabela1: 'PROGRAMAÇÃO ENTRADA EM LOTE LABORATÓRIO',
  tabela2: 'PROJETOS',
  tabela3: 'PRIORIDADE DE SAÍDA'
};

// Uma linha "tem dado" se qualquer campo dela foi preenchido
function fluxolabPlanRowHasData(row) {
  return !!(row && (
    String(row.modelo || '').trim() !== '' ||
    String(row.chk_manual || '').trim() !== '' ||
    String(row.qtd_wms || '').trim() !== '' ||
    String(row.sugestao || '').trim() !== '' ||
    String(row.obs || '').trim() !== '' ||
    String(row.pecas || '').trim() !== ''
  ));
}

// Quantidade efetiva de checklists da linha (usa chk_manual quando definido, senão o total do modelo)
function fluxolabGetRowChkCount(row, statsChk) {
  if (!row || !String(row.modelo || '').trim()) return 0;
  const manual = String(row.chk_manual != null ? row.chk_manual : '').trim();
  if (manual !== '') {
    const n = parseInt(manual, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  const st = statsChk || fluxolabPlanGetChecklistStats(row.modelo);
  return st.count || 0;
}

// Retorna a quantia excedente se a soma das linhas manuais do modelo ultrapassar o total de checklists
function fluxolabGetChkExcess(tableName, rowIdx) {
  const list = _fluxolabPlanejamentoState[tableName];
  if (!Array.isArray(list) || !list[rowIdx]) return 0;
  const row = list[rowIdx];
  const mVal = String(row.modelo || '').trim();
  if (!mVal || row.chk_auto_rem || String(row.chk_manual != null ? row.chk_manual : '').trim() === '') return 0;

  const statsChk = fluxolabPlanGetChecklistStats(mVal);
  const totalModel = statsChk.count || 0;
  const normTarget = (typeof _fluxolabNormModel === 'function')
    ? _fluxolabNormModel(mVal)
    : mVal.toUpperCase().replace(/\s+/g, '');

  let sumManual = 0;
  list.forEach(r => {
    if (!r || r.chk_auto_rem || String(r.chk_manual != null ? r.chk_manual : '').trim() === '') return;
    const rm = String(r.modelo || '').trim();
    if (!rm) return;
    const nm = (typeof _fluxolabNormModel === 'function')
      ? _fluxolabNormModel(rm)
      : rm.toUpperCase().replace(/\s+/g, '');
    if (nm === normTarget) {
      sumManual += fluxolabGetRowChkCount(r, statsChk);
    }
  });

  return sumManual > totalModel ? (sumManual - totalModel) : 0;
}

// Atualiza visualmente o aviso vermelho de excedente em todas as linhas de um modelo na tabela
function fluxolabSyncChkExcessForModel(tableName, modeloName) {
  const list = _fluxolabPlanejamentoState[tableName];
  const mVal = String(modeloName || '').trim();
  if (!Array.isArray(list) || !mVal) return;
  const normTarget = (typeof _fluxolabNormModel === 'function')
    ? _fluxolabNormModel(mVal)
    : mVal.toUpperCase().replace(/\s+/g, '');
  const statsChk = fluxolabPlanGetChecklistStats(mVal);

  list.forEach((r, i) => {
    if (!r || !String(r.modelo || '').trim()) return;
    const nm = (typeof _fluxolabNormModel === 'function')
      ? _fluxolabNormModel(r.modelo)
      : String(r.modelo).toUpperCase().replace(/\s+/g, '');
    if (nm !== normTarget) return;

    const excedente = fluxolabGetChkExcess(tableName, i);
    const inpChk = document.getElementById(`plan-${tableName}-r${i}-chk_manual`);
    const excEl = document.getElementById(`plan-${tableName}-r${i}-chk-exc`);
    if (inpChk) {
      const eff = fluxolabGetRowChkCount(r, statsChk);
      inpChk.classList.toggle('plan-chk-exceeded', excedente > 0);
      inpChk.style.color = excedente > 0 ? '#f87171' : (eff > 0 ? '#4ade80' : '#f87171');
    }
    if (excEl) {
      if (excedente > 0) {
        excEl.innerText = `+${excedente} excedente`;
        excEl.style.display = 'block';
        excEl.title = `Quantidade excedente: +${excedente} acima do total do modelo (${statsChk.count || 0})`;
      } else {
        excEl.innerText = '';
        excEl.style.display = 'none';
      }
    }
  });
}

// Sincroniza o input da coluna Checklists (valor, cor, readonly e tooltip)
function fluxolabSyncChkInputElem(inpChk, rowObj, statsChk, excedente) {
  if (!inpChk) return;
  const mVal = rowObj && rowObj.modelo ? String(rowObj.modelo).trim() : '';
  const st = statsChk || (mVal ? fluxolabPlanGetChecklistStats(mVal) : { count: 0 });
  const hasMan = rowObj && String(rowObj.chk_manual != null ? rowObj.chk_manual : '').trim() !== '';
  inpChk.value = mVal ? (hasMan ? rowObj.chk_manual : (st.count || '-')) : '';
  const eff = fluxolabGetRowChkCount(rowObj, st);
  const exc = Number(excedente || 0);
  inpChk.classList.toggle('plan-chk-exceeded', exc > 0);
  inpChk.style.color = !mVal ? 'var(--muted)' : (exc > 0 ? '#f87171' : (eff > 0 ? '#4ade80' : '#f87171'));
  inpChk.readOnly = !mVal;
  inpChk.style.cursor = !mVal ? 'default' : 'text';
  inpChk.title = mVal ? `Clique para definir a quantidade de checklists manualmente (total do modelo: ${st.count || 0})` : '';
}

// Ajusta a tabela removendo linhas vazias extras do final ou adicionando a
// linha vazia final, respeitando o mínimo configurado (FLUXOLAB_PLAN_MIN_ROWS)
// e mantendo sempre 1 linha vazia extra após a última linha preenchida
// (para o usuário continuar digitando e expandir a tabela).
// Retorna true se o tamanho da lista foi alterado.
function fluxolabCompactPlanTable(tableName) {
  if (!Array.isArray(_fluxolabPlanejamentoState[tableName])) {
    _fluxolabPlanejamentoState[tableName] = [];
  }
  const list = _fluxolabPlanejamentoState[tableName];
  const minRows = FLUXOLAB_PLAN_MIN_ROWS[tableName] || 1;

  let lastFilledIdx = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (fluxolabPlanRowHasData(list[i])) { lastFilledIdx = i; break; }
  }

  const desiredLength = Math.max(minRows, lastFilledIdx + 2);
  if (list.length > desiredLength) {
    _fluxolabPlanejamentoState[tableName] = list.slice(0, desiredLength);
    return true;
  }
  if (list.length < desiredLength) {
    while (list.length < desiredLength) {
      list.push({ modelo: '', chk_manual: '', chk_auto_rem: false, qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
    return true;
  }
  return false;
}

// Re-renderiza a tabela sem apagar o campo em que o usuário ainda está
// digitando (adia enquanto o foco estiver dentro da mesma tabela).
function fluxolabScheduleRerender(tableName, retriesLeft) {
  if (retriesLeft === undefined) retriesLeft = 20;
  const active = document.activeElement;
  const stillEditingThisTable = active && active.id && active.id.indexOf(`plan-${tableName}-`) === 0;
  if (stillEditingThisTable && retriesLeft > 0) {
    setTimeout(() => fluxolabScheduleRerender(tableName, retriesLeft - 1), 250);
    return;
  }
  const activeId = active ? active.id : null;
  fluxolabRenderPlanejamento();
  if (activeId) {
    const el = document.getElementById(activeId);
    if (el) el.focus();
  }
}

const PLAN_DIRTY_BACKUP_LS_KEY = 'fluxolabPlanDirtyBackup_v1';
let _fluxolabPlanDirty = false;
let _fluxolabPlanInFlightJSON = null;
let _fluxolabPlanSaveQueued = false;

function _planClient() {
  return (typeof _supaAuthed === 'function') ? _supaAuthed() : (typeof _supa !== 'undefined' ? _supa : null);
}
function _planCanWrite() {
  if (typeof currentUser === 'undefined' || !currentUser) return false;
  if (currentUser.sector === 'VISUALIZAÇÃO') return false;
  const opView = document.getElementById('view-operador');
  if (opView && opView.classList.contains('active') && !currentUser.isAdmin) return false;
  return true;
}
function _planMarkLocalDirty() {
  if (!_planCanWrite()) return;
  _fluxolabPlanDirty = true;
  try {
    localStorage.setItem(PLAN_DIRTY_BACKUP_LS_KEY, JSON.stringify({
      ts: Date.now(),
      state: _fluxolabPlanejamentoState
    }));
  } catch (e) {}
}
function _planClearLocalDirty() {
  _fluxolabPlanDirty = false;
  try { localStorage.removeItem(PLAN_DIRTY_BACKUP_LS_KEY); } catch (e) {}
}

// Carrega o estado do Supabase
async function fluxolabLoadPlanejamento() {
  if (typeof currentUser === 'undefined' || !currentUser) return;
  const client = _planClient();
  let restoredFromDirtyBackup = false;
  if (client) {
    try {
      const {data, error} = await client.from('fluxolab_state').select('data').eq('key', 'planejamento_lote_dia').maybeSingle();
      if (!error && data && data.data) {
        _fluxolabPlanejamentoState = Object.assign({ tabela1: [], tabela2: [], tabela3: [] }, data.data);
      }
      if (error) console.warn('[plan] load erro:', error);
    } catch(e) { console.error('Erro ao carregar planejamento:', e); }

    try {
      const dirtyRaw = localStorage.getItem(PLAN_DIRTY_BACKUP_LS_KEY);
      if (dirtyRaw && _planCanWrite()) {
        const parsed = JSON.parse(dirtyRaw);
        if (parsed && parsed.state && parsed.ts && (Date.now() - parsed.ts < 120000)) {
          _fluxolabPlanejamentoState = Object.assign({ tabela1: [], tabela2: [], tabela3: [] }, parsed.state);
          restoredFromDirtyBackup = true;
        } else {
          localStorage.removeItem(PLAN_DIRTY_BACKUP_LS_KEY);
        }
      }
    } catch (e) {}
    
    // Configura o sincronismo em tempo real (Multiplayer) — nunca bloqueia o loaded
    if (!_planSyncChannel) {
      _planSyncChannel = true;
      try {
        if (typeof window._fluxolabStateOn === 'function') {
          window._fluxolabStateOn('planejamento_lote_dia', payload => {
            if (payload.new && payload.new.data) {
              fluxolabApplyRemoteSync(payload.new.data);
            }
          });
        } else {
          console.warn('[plan] _fluxolabStateOn indisponível — sync realtime desligado');
        }
      } catch (e) {
        console.warn('[plan] falha ao registrar realtime:', e);
      }
    }
  }
  
  // Garantir linhas mínimas
  ['tabela1', 'tabela2', 'tabela3'].forEach(t => {
    if (!Array.isArray(_fluxolabPlanejamentoState[t])) _fluxolabPlanejamentoState[t] = [];
    const minRows = FLUXOLAB_PLAN_MIN_ROWS[t] || 5;
    while (_fluxolabPlanejamentoState[t].length < minRows) {
      _fluxolabPlanejamentoState[t].push({ modelo: '', chk_manual: '', chk_auto_rem: false, qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
    fluxolabCompactPlanTable(t);
  });
  
  _fluxolabPlanLoaded = true;
  if (!restoredFromDirtyBackup) {
    try { _fluxolabPlanLastSavedJSON = JSON.stringify(_fluxolabPlanejamentoState); } catch (e) { _fluxolabPlanLastSavedJSON = null; }
  } else {
    _fluxolabPlanLastSavedJSON = null;
    fluxolabSavePlanejamentoNow(true);
  }
  
  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'planejamento') {
    fluxolabRenderPlanejamento();
  }
}

// Salva o estado no Supabase
const FLUXOLAB_SAVE_DEBOUNCE_MS = 800;
let _fluxolabPlanSaveTimer;
let _fluxolabPlanLastSavedJSON = null;
let _fluxolabPlanSaving = false;

async function fluxolabSavePlanejamentoNow(force) {
  if (!_fluxolabPlanLoaded) return false;
  if (!_planCanWrite()) return false;
  const client = _planClient();
  if (!client) return false;
  clearTimeout(_fluxolabPlanSaveTimer);
  if (_fluxolabPlanSaving) {
    _fluxolabPlanSaveQueued = true;
    return false;
  }
  let snap;
  try { snap = JSON.stringify(_fluxolabPlanejamentoState); } catch (e) { snap = null; }
  if (!force && snap && snap === _fluxolabPlanLastSavedJSON) {
    _planClearLocalDirty();
    return true;
  }
  _fluxolabPlanSaving = true;
  _fluxolabPlanInFlightJSON = snap;
  try {
    let { error } = await client.from('fluxolab_state').upsert(
      { key: 'planejamento_lote_dia', data: _fluxolabPlanejamentoState, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
    if (error) {
      const retry = await client.from('fluxolab_state').upsert(
        { key: 'planejamento_lote_dia', data: _fluxolabPlanejamentoState },
        { onConflict: 'key' }
      );
      error = retry.error;
    }
    if (error) {
      console.warn('[plan] save erro:', error);
      return false;
    }
    _fluxolabPlanLastSavedJSON = snap;
    const currentSnap = JSON.stringify(_fluxolabPlanejamentoState);
    if (currentSnap === snap) {
      _planClearLocalDirty();
    } else {
      _fluxolabPlanSaveQueued = true;
    }
    return true;
  } catch (e) {
    console.warn('[plan] save falhou:', e);
    return false;
  } finally {
    _fluxolabPlanSaving = false;
    _fluxolabPlanInFlightJSON = null;
    if (_fluxolabPlanSaveQueued) {
      _fluxolabPlanSaveQueued = false;
      setTimeout(() => { fluxolabSavePlanejamentoNow(true); }, 50);
    }
  }
}

function fluxolabSavePlanejamentoDebounced() {
  if (!_fluxolabPlanLoaded || !_planCanWrite()) return;
  _planMarkLocalDirty();
  clearTimeout(_fluxolabPlanSaveTimer);
  _fluxolabPlanSaveTimer = setTimeout(() => { fluxolabSavePlanejamentoNow(); }, FLUXOLAB_SAVE_DEBOUNCE_MS);
}

// Garante flush ao sair / ocultar a página
if (typeof window !== 'undefined' && !window._planFlushBound) {
  window._planFlushBound = true;
  window.addEventListener('beforeunload', () => {
    try {
      if (_fluxolabPlanLoaded && _fluxolabPlanDirty) {
        fluxolabSavePlanejamentoNow(true);
      }
    } catch (e) {}
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { if (_fluxolabPlanDirty) fluxolabSavePlanejamentoNow(true); } catch (e) {}
    }
  });
}

// Aplica as atualizações que vieram de outros usuários (Tempo Real)
function fluxolabApplyRemoteSync(remoteData) {
  if (!_fluxolabPlanLoaded || !remoteData) return;

  try {
    const remoteSnap = JSON.stringify(Object.assign({ tabela1: [], tabela2: [], tabela3: [] }, remoteData));
    if (remoteSnap === _fluxolabPlanLastSavedJSON || remoteSnap === _fluxolabPlanInFlightJSON) return;
    if (_fluxolabPlanDirty || _fluxolabPlanSaving) return;
  } catch (e) {}
  
  ['tabela1', 'tabela2', 'tabela3'].forEach(t => {
    if (!remoteData[t]) return;
    
    // Se outro usuário removeu ou adicionou linhas, sincroniza o tamanho da tabela local
    if (_fluxolabPlanejamentoState[t].length > remoteData[t].length) {
      _fluxolabPlanejamentoState[t].length = remoteData[t].length;
      if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'planejamento') {
        fluxolabScheduleRerender(t);
      }
    } else if (_fluxolabPlanejamentoState[t].length < remoteData[t].length) {
      if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'planejamento') {
        fluxolabScheduleRerender(t);
      }
    }
    
    for (let i = 0; i < remoteData[t].length; i++) {
      if (!_fluxolabPlanejamentoState[t][i]) _fluxolabPlanejamentoState[t][i] = { modelo: '', chk_manual: '', chk_auto_rem: false, qtd_wms: '', sugestao: '', obs: '', pecas: '' };
      
      const remoteRow = remoteData[t][i];
      const localRow = _fluxolabPlanejamentoState[t][i];
      localRow.chk_auto_rem = !!remoteRow.chk_auto_rem;
      
      ['modelo', 'chk_manual', 'qtd_wms', 'sugestao', 'obs', 'pecas'].forEach(f => {
        const val = remoteRow[f] || '';
        localRow[f] = val; // Atualiza a memória local
        
        // Atualiza a tela discretamente, APENAS se o usuário não estiver digitando neste campo agora
        const inpId = `plan-${t}-r${i}-${f}`;
        const inpElem = document.getElementById(inpId);
        if (inpElem && document.activeElement !== inpElem) {
          if (f === 'chk_manual') {
            fluxolabSyncChkInputElem(inpElem, localRow);
          } else {
            inpElem.value = val;
          }
          
          // Se for modelo, precisa recalcular Checklists/Bolsões visualmente
          if (f === 'modelo') {
            const statsChk = val ? fluxolabPlanGetChecklistStats(val) : { count: 0, media: 0, urgencias: 0, trocas: 0, urgenciasTT: 0 };
            const statsBol = val ? fluxolabPlanGetBolsaoStats(val) : { doca: 0, lab: 0, qual: 0 };
            
            const inpChk = document.getElementById(`plan-${t}-r${i}-chk_manual`);
            const cellMedia = document.getElementById(`plan-${t}-r${i}-media`);
            const cellDoca = document.getElementById(`plan-${t}-r${i}-doca`);
            const cellLab = document.getElementById(`plan-${t}-r${i}-lab`);
            const cellQual = document.getElementById(`plan-${t}-r${i}-qual`);
            const cellBadge = document.getElementById(`plan-${t}-r${i}-badge`);
            
            if (inpChk && document.activeElement !== inpChk) {
              fluxolabSyncChkInputElem(inpChk, localRow, statsChk);
            }
            if (cellMedia) { cellMedia.innerText = val ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
            if (cellDoca) cellDoca.innerText = val ? (statsBol.doca || '-') : '';
            if (cellLab) cellLab.innerText = val ? (statsBol.lab || '-') : '';
            if (cellQual) cellQual.innerText = val ? (statsBol.qual || '-') : '';
            if (cellBadge) cellBadge.innerHTML = planBadgeHtml(statsChk.count, !!val, statsChk.urgencias, statsChk.trocas, statsChk.urgenciasTT);
          }
        }
      });
    }
    for (let i = 0; i < remoteData[t].length; i++) {
      const lr = _fluxolabPlanejamentoState[t][i];
      if (lr && lr.modelo) fluxolabSyncChkExcessForModel(t, lr.modelo);
    }
    if (fluxolabCompactPlanTable(t)) {
      if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'planejamento') {
        fluxolabScheduleRerender(t);
      }
    }
    fluxolabUpdateTotalChk(t);
  });

  try { _fluxolabPlanLastSavedJSON = JSON.stringify(_fluxolabPlanejamentoState); } catch (e) {}
}

// Atualização local pelo usuário atual
function fluxolabUpdateRowElem(elem, tableName, field) {
  const tr = elem.closest('tr');
  if (!tr) return;
  const tbody = tr.parentNode;
  const index = Array.from(tbody.children).indexOf(tr);
  
  if (!_fluxolabPlanejamentoState[tableName]) return;
  if (!_fluxolabPlanejamentoState[tableName][index]) return;
  
  const value = elem.value;
  const prevValue = _fluxolabPlanejamentoState[tableName][index][field] || '';
  _fluxolabPlanejamentoState[tableName][index][field] = value;
  if (field === 'modelo' && prevValue !== value) {
    _fluxolabPlanejamentoState[tableName][index].chk_manual = '';
    _fluxolabPlanejamentoState[tableName][index].chk_auto_rem = false;
  }
  
  const isLastRow = index === _fluxolabPlanejamentoState[tableName].length - 1;
  const rowHasData = fluxolabPlanRowHasData(_fluxolabPlanejamentoState[tableName][index]);

  if (isLastRow && rowHasData) {
    // Tabela EXPANDE: última linha foi preenchida, adiciona uma nova linha
    // vazia no final imediatamente no estado e no DOM sem perder o foco do campo atual.
    const newIdx = _fluxolabPlanejamentoState[tableName].length;
    const newRow = { modelo: '', chk_manual: '', chk_auto_rem: false, qtd_wms: '', sugestao: '', obs: '', pecas: '' };
    _fluxolabPlanejamentoState[tableName].push(newRow);
    try {
      const savedSizes = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
      const themeColor = tableName === 'tabela1' ? '#22d3ee' : (tableName === 'tabela2' ? '#a78bfa' : '#fb923c');
      tbody.insertAdjacentHTML('beforeend', fluxolabBuildPlanRowHtml(tableName, newRow, newIdx, themeColor, savedSizes));
    } catch (e) {
      setTimeout(() => fluxolabScheduleRerender(tableName), 10);
    }
  }
  
  fluxolabSavePlanejamentoDebounced();
  
  // Tabela RETRAI: se ao editar este campo a linha ficou vazia (ex.: usuário
  // apagou o modelo), remove linhas vazias sobrando no final, sem nunca
  // descer abaixo do mínimo configurado (FLUXOLAB_PLAN_MIN_ROWS).
  if (!rowHasData) {
    const compacted = fluxolabCompactPlanTable(tableName);
    if (compacted) {
      setTimeout(() => fluxolabScheduleRerender(tableName), 10);
    }
  }
  
  if (field === 'modelo') {
    const statsChk = value ? fluxolabPlanGetChecklistStats(value) : { count: 0, media: 0, urgencias: 0, trocas: 0, urgenciasTT: 0 };
    const statsBol = value ? fluxolabPlanGetBolsaoStats(value) : { doca: 0, lab: 0, qual: 0 };
    const rowObj = _fluxolabPlanejamentoState[tableName][index];
    
    const inpChk = document.getElementById(`plan-${tableName}-r${index}-chk_manual`);
    const cellMedia = document.getElementById(`plan-${tableName}-r${index}-media`);
    const cellDoca = document.getElementById(`plan-${tableName}-r${index}-doca`);
    const cellLab = document.getElementById(`plan-${tableName}-r${index}-lab`);
    const cellQual = document.getElementById(`plan-${tableName}-r${index}-qual`);
    const cellBadge = document.getElementById(`plan-${tableName}-r${index}-badge`);
    
    fluxolabSyncChkInputElem(inpChk, rowObj, statsChk);
    if (cellMedia) { cellMedia.innerText = value ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
    if (cellDoca) cellDoca.innerText = value ? (statsBol.doca || '-') : '';
    if (cellLab) cellLab.innerText = value ? (statsBol.lab || '-') : '';
    if (cellQual) cellQual.innerText = value ? (statsBol.qual || '-') : '';
    if (cellBadge) cellBadge.innerHTML = planBadgeHtml(statsChk.count, !!value, statsChk.urgencias, statsChk.trocas, statsChk.urgenciasTT);
    fluxolabUpdateTotalChk(tableName);
  }
}

let _planChkCommitTimers = {};

// Edição manual da coluna Checklists (durante digitação)
function fluxolabUpdateRowChkInput(elem, tableName) {
  const tr = elem.closest('tr');
  if (!tr) return;
  const tbody = tr.parentNode;
  const index = Array.from(tbody.children).indexOf(tr);
  if (!_fluxolabPlanejamentoState[tableName] || !_fluxolabPlanejamentoState[tableName][index]) return;

  const row = _fluxolabPlanejamentoState[tableName][index];
  const cleaned = String(elem.value || '').replace(/[^\d]/g, '');
  if (elem.value !== cleaned) elem.value = cleaned;
  row.chk_manual = cleaned;
  row.chk_auto_rem = false;

  const statsChk = row.modelo ? fluxolabPlanGetChecklistStats(row.modelo) : { count: 0 };
  const eff = fluxolabGetRowChkCount(row, statsChk);
  const exc = fluxolabGetChkExcess(tableName, index);
  elem.classList.toggle('plan-chk-exceeded', exc > 0);
  elem.style.color = !row.modelo ? 'var(--muted)' : (exc > 0 ? '#f87171' : (eff > 0 ? '#4ade80' : '#f87171'));

  fluxolabSyncChkExcessForModel(tableName, row.modelo);
  fluxolabUpdateTotalChk(tableName);
  fluxolabSavePlanejamentoDebounced();

  const timerKey = `${tableName}:${index}`;
  clearTimeout(_planChkCommitTimers[timerKey]);
  if (cleaned !== '') {
    _planChkCommitTimers[timerKey] = setTimeout(() => {
      fluxolabCommitRowChkByIndex(tableName, index, true);
    }, 500);
  }
}

// Confirmação da quantia manual de Checklists (ao sair do campo ou pressionar Enter)
function fluxolabCommitRowChk(elem, tableName) {
  const tr = elem.closest('tr');
  if (!tr) return;
  const tbody = tr.parentNode;
  const index = Array.from(tbody.children).indexOf(tr);
  clearTimeout(_planChkCommitTimers[`${tableName}:${index}`]);
  fluxolabCommitRowChkByIndex(tableName, index, false);
}

// Calcula o restante que faltou para completar o total do modelo e insere/atualiza
// automaticamente na última linha da tabela.
function fluxolabCommitRowChkByIndex(tableName, index, fromDebounce) {
  const list = _fluxolabPlanejamentoState[tableName];
  if (!Array.isArray(list) || !list[index]) return;

  const row = list[index];
  const elem = document.getElementById(`plan-${tableName}-r${index}-chk_manual`);
  const modeloTxt = String(row.modelo || '').trim();
  if (!modeloTxt) {
    row.chk_manual = '';
    row.chk_auto_rem = false;
    if (elem) elem.value = '';
    return;
  }

  const statsChk = fluxolabPlanGetChecklistStats(modeloTxt);
  const totalModel = statsChk.count || 0;
  const raw = String(row.chk_manual != null ? row.chk_manual : '').trim();

  if (fromDebounce && raw === '') return;

  const normTarget = (typeof _fluxolabNormModel === 'function')
    ? _fluxolabNormModel(modeloTxt)
    : modeloTxt.toUpperCase().replace(/\s+/g, '');

  const sameIndices = [];
  list.forEach((r, i) => {
    if (!r || !String(r.modelo || '').trim()) return;
    const nm = (typeof _fluxolabNormModel === 'function')
      ? _fluxolabNormModel(r.modelo)
      : String(r.modelo).toUpperCase().replace(/\s+/g, '');
    if (nm === normTarget) sameIndices.push(i);
  });

  // Linha de restante criada automaticamente para este modelo (se já existir e não for a linha atual)
  let autoRemIdx = -1;
  for (let k = sameIndices.length - 1; k >= 0; k--) {
    const i = sameIndices[k];
    if (i !== index && list[i] && list[i].chk_auto_rem) {
      autoRemIdx = i;
      break;
    }
  }

  const val = raw !== '' ? parseInt(raw, 10) : NaN;

  const rowHasOtherFields = (r) => !!(r && (
    String(r.qtd_wms || '').trim() !== '' ||
    String(r.sugestao || '').trim() !== '' ||
    String(r.obs || '').trim() !== '' ||
    String(r.pecas || '').trim() !== ''
  ));

  const rerenderPreservingFocus = () => {
    const run = () => {
      const activeEl = document.activeElement;
      const activeId = activeEl && activeEl.id ? activeEl.id : null;
      const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
      const selEnd = activeEl && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;
      fluxolabRenderPlanejamento();
      if (activeId) {
        const restored = document.getElementById(activeId);
        if (restored) {
          restored.focus();
          if (selStart !== null && typeof restored.setSelectionRange === 'function') {
            try { restored.setSelectionRange(selStart, selEnd); } catch (e) {}
          }
        }
      }
    };
    if (fromDebounce) run();
    else setTimeout(run, 10);
  };

  // Soma apenas as linhas do modelo que tiveram definição manual (ignora linhas antigas não divididas e a linha auto_rem)
  const manualIndices = sameIndices.filter(i => {
    const r = list[i];
    return r && !r.chk_auto_rem && String(r.chk_manual != null ? r.chk_manual : '').trim() !== '';
  });

  // Se o campo foi esvaziado ou zerado, restaura o valor automático (ou o restante)
  if (isNaN(val) || val <= 0) {
    row.chk_manual = '';
    row.chk_auto_rem = false;
    const otherManual = manualIndices.filter(i => i !== index);
    if (otherManual.length === 0) {
      if (elem) fluxolabSyncChkInputElem(elem, row, statsChk);
      if (autoRemIdx >= 0 && !rowHasOtherFields(list[autoRemIdx])) {
        list.splice(autoRemIdx, 1);
        fluxolabCompactPlanTable(tableName);
        fluxolabSavePlanejamentoNow();
        rerenderPreservingFocus();
        return;
      }
    } else {
      const sumManual = otherManual.reduce((s, i) => s + fluxolabGetRowChkCount(list[i], statsChk), 0);
      const faltante = Math.max(0, totalModel - sumManual);
      if (autoRemIdx >= 0) {
        if (faltante > 0) {
          list[autoRemIdx].chk_manual = String(faltante);
          const remEl = document.getElementById(`plan-${tableName}-r${autoRemIdx}-chk_manual`);
          if (remEl) fluxolabSyncChkInputElem(remEl, list[autoRemIdx], statsChk);
        } else if (!rowHasOtherFields(list[autoRemIdx])) {
          list.splice(autoRemIdx, 1);
          fluxolabCompactPlanTable(tableName);
          fluxolabSavePlanejamentoNow();
          rerenderPreservingFocus();
          return;
        }
      }
      if (elem) fluxolabSyncChkInputElem(elem, row, statsChk, fluxolabGetChkExcess(tableName, index));
    }
    fluxolabSyncChkExcessForModel(tableName, modeloTxt);
    fluxolabUpdateTotalChk(tableName);
    fluxolabSavePlanejamentoDebounced();
    return;
  }

  row.chk_auto_rem = false;

  // Se é a única definição manual e o valor digitado já é igual ao total do modelo, volta ao automático sem criar linha extra
  if (manualIndices.length === 1 && manualIndices[0] === index && val === totalModel) {
    row.chk_manual = '';
    if (elem) fluxolabSyncChkInputElem(elem, row, statsChk, 0);
    if (autoRemIdx >= 0 && !rowHasOtherFields(list[autoRemIdx])) {
      list.splice(autoRemIdx, 1);
      fluxolabCompactPlanTable(tableName);
      fluxolabSavePlanejamentoNow();
      rerenderPreservingFocus();
      return;
    }
    fluxolabSyncChkExcessForModel(tableName, modeloTxt);
    fluxolabUpdateTotalChk(tableName);
    fluxolabSavePlanejamentoDebounced();
    return;
  }

  if (totalModel > 0 || val > 0) {
    const sumManual = manualIndices.reduce((s, i) => s + fluxolabGetRowChkCount(list[i], statsChk), 0);
    const faltante = totalModel - sumManual;

    if (faltante > 0) {
      if (autoRemIdx >= 0) {
        // Já existe uma linha automática de restante para este modelo: atualiza a quantia faltante nela
        list[autoRemIdx].chk_manual = String(faltante);
        const remEl = document.getElementById(`plan-${tableName}-r${autoRemIdx}-chk_manual`);
        if (remEl) fluxolabSyncChkInputElem(remEl, list[autoRemIdx], statsChk, 0);
        fluxolabSyncChkExcessForModel(tableName, modeloTxt);
        fluxolabUpdateTotalChk(tableName);
        fluxolabSavePlanejamentoNow();
        return;
      } else {
        // Insere automaticamente na última linha preenchida da tabela com a quantia faltante
        let lastFilledIdx = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (fluxolabPlanRowHasData(list[i])) { lastFilledIdx = i; break; }
        }
        const insertPos = lastFilledIdx + 1;
        const remainderRow = {
          modelo: row.modelo,
          chk_manual: String(faltante),
          chk_auto_rem: true,
          qtd_wms: '',
          sugestao: '',
          obs: '',
          pecas: ''
        };
        if (insertPos < list.length && !fluxolabPlanRowHasData(list[insertPos])) {
          list[insertPos] = remainderRow;
        } else {
          list.splice(insertPos, 0, remainderRow);
        }
        fluxolabCompactPlanTable(tableName);
        fluxolabSavePlanejamentoNow();
        rerenderPreservingFocus();
        return;
      }
    } else if (autoRemIdx >= 0) {
      if (!rowHasOtherFields(list[autoRemIdx])) {
        list.splice(autoRemIdx, 1);
        fluxolabCompactPlanTable(tableName);
        fluxolabSavePlanejamentoNow();
        rerenderPreservingFocus();
        return;
      } else {
        list[autoRemIdx].chk_manual = '0';
        const remEl = document.getElementById(`plan-${tableName}-r${autoRemIdx}-chk_manual`);
        if (remEl) fluxolabSyncChkInputElem(remEl, list[autoRemIdx], statsChk, 0);
        fluxolabSyncChkExcessForModel(tableName, modeloTxt);
        fluxolabUpdateTotalChk(tableName);
        fluxolabSavePlanejamentoNow();
        return;
      }
    }
  }

  fluxolabSyncChkExcessForModel(tableName, modeloTxt);
  fluxolabUpdateTotalChk(tableName);
  fluxolabSavePlanejamentoDebounced();
}

function fluxolabClearPlanTable(tableName) {
  const label = FLUXOLAB_PLAN_TABLE_LABELS[tableName] || tableName;
  if (confirm(`Tem certeza que deseja limpar a tabela "${label}"? Os ajustes de tamanho das colunas não serão perdidos.`)) {
    // Ao limpar tudo, não sobra nenhum modelo adicionado, então a tabela
    // retrai direto para o mínimo configurado.
    const minRows = FLUXOLAB_PLAN_MIN_ROWS[tableName] || 1;
    _fluxolabPlanejamentoState[tableName] = [];
    for (let i = 0; i < minRows; i++) {
      _fluxolabPlanejamentoState[tableName].push({ modelo: '', chk_manual: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
    _planMarkLocalDirty();
    fluxolabSavePlanejamentoNow(true);
    fluxolabRenderPlanejamento();
  }
}

function fluxolabRemovePlanRow(tableName, idx) {
  const list = _fluxolabPlanejamentoState[tableName];
  if (!Array.isArray(list) || idx < 0 || idx >= list.length) return;
  const row = list[idx] || {};
  const modeloTxt = String(row.modelo || '').trim();
  const msg = modeloTxt
    ? `Tem certeza que deseja remover a ${idx + 1}ª linha (${modeloTxt})?`
    : `Tem certeza que deseja remover a ${idx + 1}ª linha?`;
  if (!confirm(msg)) return;

  list.splice(idx, 1);

  const minRows = FLUXOLAB_PLAN_MIN_ROWS[tableName] || 1;
  while (list.length < minRows) {
    list.push({ modelo: '', chk_manual: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
  }
  fluxolabCompactPlanTable(tableName);
  _planMarkLocalDirty();
  fluxolabSavePlanejamentoNow(true);
  fluxolabRenderPlanejamento();
}

// Ordena a tabela pela coluna "Média Dias" (clique alterna maior→menor / menor→maior)
function fluxolabSortPlanByMedia(tableName) {
  const list = _fluxolabPlanejamentoState[tableName];
  if (!list || !list.length) return;

  const currentDir = _planMediaSortDir[tableName];
  const nextDir = currentDir === 'desc' ? 'asc' : 'desc';
  _planMediaSortDir[tableName] = nextDir;

  // Separa linhas preenchidas das vazias — vazias permanecem sempre no final
  const filled = [];
  const empty = [];
  list.forEach(row => {
    if (row.modelo) {
      filled.push({ row, media: fluxolabPlanGetChecklistStats(row.modelo).media || 0 });
    } else {
      empty.push(row);
    }
  });

  filled.sort((a, b) => nextDir === 'desc' ? (b.media - a.media) : (a.media - b.media));

  _fluxolabPlanejamentoState[tableName] = filled.map(x => x.row).concat(empty);

  fluxolabSavePlanejamentoDebounced();
  fluxolabRenderPlanejamento();
}

// DRAG & DROP
let _planDraggedTr = null;
let _planDraggedTableName = null;

function planDragStartTr(e, tableName) {
  _planDraggedTr = e.currentTarget;
  _planDraggedTableName = tableName;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => _planDraggedTr.style.opacity = '0.4', 0);
}
function planDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.borderTop = '2px solid var(--accent)';
}
function planDragLeave(e) {
  e.currentTarget.style.borderTop = '';
}
function planDropTr(e, tableName) {
  e.preventDefault();
  const dropTr = e.currentTarget;
  dropTr.style.borderTop = '';
  
  if (_planDraggedTableName === tableName && _planDraggedTr && _planDraggedTr !== dropTr) {
    const tbody = dropTr.parentNode;
    const oldIdx = Array.from(tbody.children).indexOf(_planDraggedTr);
    let newIdx = Array.from(tbody.children).indexOf(dropTr);
    
    if (newIdx > oldIdx) dropTr.after(_planDraggedTr);
    else dropTr.before(_planDraggedTr);
    
    // Atualizar HTML visual
    Array.from(tbody.children).forEach((tr, i) => {
      tr.cells[0].innerHTML = `<span style="opacity:0.4;margin-right:4px">≡</span>${i + 1}º`;
      tr.cells[1].innerHTML = `${i + 1}`;
      
      // Update IDs to match new order so realtime sync targets the correct row
      ['modelo','chk_manual','qtd_wms','sugestao','obs','pecas'].forEach(f => {
        const inp = tr.querySelector(`[id$="-${f}"]`);
        if (inp) inp.id = `plan-${tableName}-r${i}-${f}`;
      });
      ['chk','chk-exc','media','doca','lab','qual','badge'].forEach(f => {
        const cell = tr.querySelector(`[id$="-${f}"]`);
        if (cell) cell.id = `plan-${tableName}-r${i}-${f}`;
      });
      const delBtn = tr.querySelector('.plan-row-del-btn');
      if (delBtn) delBtn.setAttribute('onclick', `fluxolabRemovePlanRow('${tableName}', ${i})`);
    });
    
    const finalIdx = Array.from(tbody.children).indexOf(_planDraggedTr);
    const list = _fluxolabPlanejamentoState[tableName];
    const item = list.splice(oldIdx, 1)[0];
    list.splice(finalIdx, 0, item);
    if (fluxolabCompactPlanTable(tableName)) {
      fluxolabRenderPlanejamento();
    }
    
    fluxolabSavePlanejamentoDebounced();
  }
}
function planDragEnd(e) {
  e.target.style.opacity = '1';
  e.target.setAttribute('draggable', 'false');
}

// Salvamento de Larguras e Alturas no LocalStorage (otimizado: sem ResizeObserver em centenas de textareas)
let _planResizeObserver = null;
function planInitResizeObserver() {
  if (_planResizeObserver) _planResizeObserver.disconnect();
  
  _planResizeObserver = new ResizeObserver(entries => {
    let savedSizes = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
    let changed = false;
    for (let entry of entries) {
      if (entry.target.id && entry.target.classList.contains('plan-header-resizer')) {
        if (entry.target.style.width && savedSizes[entry.target.id] !== entry.target.style.width) {
          savedSizes[entry.target.id] = entry.target.style.width;
          changed = true;
        }
      }
    }
    if (changed) localStorage.setItem('fluxolabPlanSizes', JSON.stringify(savedSizes));
  });
  
  document.querySelectorAll('.plan-header-resizer').forEach(el => _planResizeObserver.observe(el));
}
if (typeof window !== 'undefined' && !window._planTextareaMouseupBound) {
  window._planTextareaMouseupBound = true;
  window.addEventListener('mouseup', e => {
    const t = e.target;
    if (t && t.id && t.classList && t.classList.contains('plan-textarea') && t.style.height) {
      try {
        const saved = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
        if (saved[t.id] !== t.style.height) {
          saved[t.id] = t.style.height;
          localStorage.setItem('fluxolabPlanSizes', JSON.stringify(saved));
        }
      } catch (_e) {}
    }
  });
}

// Datalist compartilhada única no DOM (evita recriar milhares de <option> a cada render)
let _modelosDatalistLastCount = -1;
function _fluxolabEnsureModelosDatalist() {
  try {
    const eqObj = typeof equipamentos !== 'undefined' && equipamentos ? equipamentos : {};
    const keysCount = Object.keys(eqObj).length;
    let dl = document.getElementById('modelos-lista');
    if (dl && _modelosDatalistLastCount === keysCount) return;
    _modelosDatalistLastCount = keysCount;
    const modelosUnicos = Array.from(new Set(Object.values(eqObj).filter(Boolean)));
    modelosUnicos.sort((a, b) => a.localeCompare(b));
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'modelos-lista';
      document.body.appendChild(dl);
    }
    dl.innerHTML = modelosUnicos.map(m => `<option value="${String(m).replace(/"/g, '&quot;')}">`).join('');
  } catch (e) {}
}
window._fluxolabEnsureModelosDatalist = _fluxolabEnsureModelosDatalist;

// Badge visual ao lado do modelo: indica se existe checklist importado para ele
// e exibe badges pequenos só com o número (quantidade) de Urgências (vermelho), Trocas Técnicas (amarelo/laranja)
// e o badge pequeno compacto "Urgência TT" (do tamanho de ✓ CHECKLIST)
function planBadgeHtml(count, filled, urgencias, trocas, urgenciasTT) {
  if (!filled) return '';
  let html = '';
  const nUrg = Number(urgencias || 0);
  const nTroca = Number(trocas || 0);
  const nUrgTT = Number(urgenciasTT || 0);
  if (nTroca > 0) {
    html += `<span title="Troca Técnica" style="background:rgba(234,179,8,0.20);color:#fde047;border:1px solid rgba(234,179,8,0.55);font-size:13px;font-weight:900;padding:3px 10px;border-radius:12px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em;line-height:1.2">TT${nTroca > 1 ? ' (' + nTroca + ')' : ''}</span>`;
  }
  if (nUrgTT > 0) {
    html += `<span title="Urgência TT" style="background:rgba(249,115,22,0.20);color:#fb923c;border:1px solid rgba(249,115,22,0.55);font-size:13px;font-weight:900;padding:3px 10px;border-radius:12px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em;line-height:1.2">URG.TT${nUrgTT > 1 ? ' (' + nUrgTT + ')' : ''}</span>`;
  }
  if (nUrg > 0) {
    html += `<span title="Urgência" style="background:rgba(239,68,68,0.20);color:#f87171;border:1px solid rgba(239,68,68,0.55);font-size:13px;font-weight:900;padding:3px 10px;border-radius:12px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em;line-height:1.2">URG.${nUrg > 1 ? ' (' + nUrg + ')' : ''}</span>`;
  }
  if (count > 0) {
    html += `<span style="background:rgba(74,222,128,0.15);color:#4ade80;font-size:13px;font-weight:900;padding:2px 8px;border-radius:10px;white-space:nowrap;flex-shrink:0;line-height:1.2" title="Possui checklist">✓</span>`;
  } else {
    html += `<span style="background:rgba(248,113,113,0.15);color:#f87171;font-size:9px;font-weight:800;padding:3px 7px;border-radius:10px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em">✗ SEM CHECKLIST</span>`;
  }
  return html;
}

// Helpers de cálculo (usa índice O(1) pré-computado em app.js)
function fluxolabPlanGetChecklistStats(modeloName) {
  if (typeof window._fluxolabGetChecklistStatsFast === 'function') {
    return window._fluxolabGetChecklistStatsFast(modeloName);
  }
  if (!modeloName || typeof _fluxolabChecklistsImported === 'undefined' || !_fluxolabChecklistsImported.length) return { count: 0, media: 0, mediaAberto: 0, maxAberto: 0, urgencias: 0, trocas: 0, urgenciasTT: 0 };
  const sample = _fluxolabChecklistsImported[0];
  const kModelo = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Descrição Equipamento') || _fluxolabFindKey(sample, 'Descricao Equipamento') || _fluxolabFindKey(sample, 'Modelo') || _fluxolabFindKey(sample, 'Equipamento')) : null;
  const kDias = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Dias Úteis Andamento') || _fluxolabFindKey(sample, 'Dias Uteis Andamento') || _fluxolabFindKey(sample, 'Dias Úteis') || _fluxolabFindKey(sample, 'Dias Uteis')) : null;
  
  // Coluna "Dias Aberto" da planilha de checklists importada (coluna F)
  const kAberto = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Dias Aberto') || _fluxolabFindKey(sample, 'Dias em Aberto') || _fluxolabFindKey(sample, 'Dias Abertos')) : null;
  const kPedido = (typeof _fluxolabFindKey === 'function') ? _fluxolabFindKey(sample, 'Pedido') : null;
  const kStatus = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Status Checklist') || _fluxolabFindKey(sample, 'Status')) : null;
  let kTipo = (typeof _fluxolabFindKey === 'function') ? _fluxolabFindKey(sample, 'Tipo') : null;
  if (!kTipo) {
    const kSt = Object.keys(sample).find(k => k.trim().toLowerCase() === 'status');
    if (kSt && kSt !== kStatus) kTipo = kSt;
  }

  if (!kModelo) return { count: 0, media: 0, mediaAberto: 0, maxAberto: 0, urgencias: 0, trocas: 0, urgenciasTT: 0 };
  
  const normAlvo = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modeloName) : modeloName.toUpperCase().replace(/\s+/g,'');
  
  let count = 0;
  let somaDias = 0;
  let somaAberto = 0;
  let countAberto = 0;
  let maxAberto = 0;
  let maxDiasUteis = 0;
  let minDiasUteis = Infinity;
  let urgencias = 0;
  let trocas = 0;
  let urgenciasTT = 0;
  const rows = [];
  for (const r of _fluxolabChecklistsImported) {
    const rowM = r[kModelo] || '';
    const rm = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(rowM) : rowM.toUpperCase().replace(/\s+/g,'');
    if (rm === normAlvo) {
      count++;
      rows.push(r);
      const _st = (typeof _fluxolabRowStatusUrg === 'function') ? _fluxolabRowStatusUrg(r) : '';
      if (_st === 'TT') urgenciasTT++;
      else if (_st === 'URG') urgencias++;
      if (typeof _fluxolabRowEhTT === 'function' && _fluxolabRowEhTT(r, kTipo)) trocas++;
      if (kDias) {
        let d = parseInt(r[kDias]);
        if (!isNaN(d)) {
          somaDias += d;
          if (d > maxDiasUteis) maxDiasUteis = d;
          if (d < minDiasUteis) minDiasUteis = d;
        }
      }
      if (kAberto) {
        let a = parseInt(r[kAberto]);
        if (!isNaN(a)) {
          somaAberto += a;
          countAberto++;
          if (a > maxAberto) maxAberto = a;
        }
      }
    }
  }
  return {
    count,
    media: count > 0 ? Math.round(somaDias / count) : 0,
    mediaAberto: countAberto > 0 ? Math.round(somaAberto / countAberto) : 0,
    maxAberto,
    maxDiasUteis,
    minDiasUteis: minDiasUteis === Infinity ? 0 : minDiasUteis,
    urgencias,
    trocas,
    urgenciasTT,
    rows,
    keys: { kModelo, kDias, kAberto, kPedido, kTipo },
  };
}

// ── Índice O(1) de Bolsões por Modelo (evita varrer _fluxolabData a cada célula) ──
let _fluxolabBolsaoIdxCache = null;
let _fluxolabBolsaoIdxSig = '';
const _EMPTY_BOLSAO_STATS = Object.freeze({ doca: 0, lab: 0, qual: 0 });
const _EMPTY_BOLSAO_LOCAIS = Object.freeze([]);

function _fluxolabGetBolsaoMasterIndex() {
  if (typeof _fluxolabData === 'undefined' || !_fluxolabData) return null;
  let sig = '';
  const entries = Object.entries(_fluxolabData);
  for (let i = 0; i < entries.length; i++) {
    const bKey = entries[i][0];
    const items = entries[i][1];
    if (!items) continue;
    const ks = Object.keys(items);
    sig += bKey + ':' + ks.length + (ks.length ? ':' + ks[0] + ':' + ks[ks.length - 1] : '') + ';';
  }
  if (_fluxolabBolsaoIdxCache && _fluxolabBolsaoIdxSig === sig && _fluxolabBolsaoIdxCache.dataRef === _fluxolabData) {
    return _fluxolabBolsaoIdxCache;
  }

  const byModel = new Map();
  const bolsaoDefs = {};
  if (typeof FLUXOLAB_BOLSOES !== 'undefined' && Array.isArray(FLUXOLAB_BOLSOES)) {
    for (let i = 0; i < FLUXOLAB_BOLSOES.length; i++) {
      bolsaoDefs[FLUXOLAB_BOLSOES[i].key] = FLUXOLAB_BOLSOES[i];
    }
  }

  for (let i = 0; i < entries.length; i++) {
    const bolsao = entries[i][0];
    const items = entries[i][1];
    if (!items) continue;
    const vals = Object.values(items);
    for (let j = 0; j < vals.length; j++) {
      const v = vals[j];
      if (!v) continue;
      const code = String(v.selb || '').trim();
      const _eqStored = v.equipamento && v.equipamento !== 'DESCONHECIDO' ? v.equipamento : '';
      const m = _eqStored || (typeof getEquipName === 'function' ? getEquipName(code) : '') || '';
      if (!m) continue;
      const normM = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(m) : m.toUpperCase().replace(/\s+/g, '');
      if (!normM) continue;

      let entry = byModel.get(normM);
      if (!entry) {
        entry = { doca: 0, lab: 0, qual: 0, porBolsao: {}, locais: null };
        byModel.set(normM, entry);
      }
      entry.porBolsao[bolsao] = (entry.porBolsao[bolsao] || 0) + 1;
      if (bolsao === 'DOCA_1') {
        entry.doca++;
      } else if (bolsao === 'QUALIDADE') {
        entry.qual++;
        entry.lab++;
      } else if (bolsao !== 'RETORNO_ESTOQUE' && bolsao !== 'LIBERADAS' && bolsao !== 'SCRAP') {
        entry.lab++;
      }
    }
  }

  for (const [, entry] of byModel) {
    entry.locais = Object.entries(entry.porBolsao).map(([key, count]) => {
      const def = bolsaoDefs[key] || null;
      return { key, label: def ? def.label : key, color: def ? def.color : 'var(--muted)', count };
    }).sort((a, b) => b.count - a.count);
  }

  _fluxolabBolsaoIdxSig = sig;
  _fluxolabBolsaoIdxCache = { dataRef: _fluxolabData, byModel };
  return _fluxolabBolsaoIdxCache;
}

function fluxolabPlanGetBolsaoStats(modeloName) {
  if (!modeloName || typeof _fluxolabData === 'undefined' || !_fluxolabData) return _EMPTY_BOLSAO_STATS;
  const master = _fluxolabGetBolsaoMasterIndex();
  if (!master) return _EMPTY_BOLSAO_STATS;
  const normAlvo = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modeloName) : modeloName.toUpperCase().replace(/\s+/g,'');
  return master.byModel.get(normAlvo) || _EMPTY_BOLSAO_STATS;
}

// Retorna EM QUAL(IS) bolsão(ões) específico(s) o modelo está fisicamente agora
// (ex.: "Complexa", "Linha 3"), diferente de fluxolabPlanGetBolsaoStats que só
// soma totais de Doca/Lab. Usado pela coluna "Bolsão" das tabelas de Pendências.
function fluxolabPlanGetBolsaoLocais(modeloName) {
  if (!modeloName || typeof _fluxolabData === 'undefined' || !_fluxolabData) return _EMPTY_BOLSAO_LOCAIS;
  const master = _fluxolabGetBolsaoMasterIndex();
  if (!master) return _EMPTY_BOLSAO_LOCAIS;
  const normAlvo = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modeloName) : modeloName.toUpperCase().replace(/\s+/g,'');
  const entry = master.byModel.get(normAlvo);
  return entry ? entry.locais : _EMPTY_BOLSAO_LOCAIS;
}

// Soma os checklists de todos os modelos preenchidos numa tabela (Ord, Lote, etc. não contam)
function fluxolabCalcTotalChk(tableName) {
  const rows = _fluxolabPlanejamentoState[tableName] || [];
  return rows.reduce((sum, row) => {
    if (!row.modelo) return sum;
    const stats = fluxolabPlanGetChecklistStats(row.modelo);
    return sum + fluxolabGetRowChkCount(row, stats);
  }, 0);
}

// Atualiza só o badge do total na tela, sem redesenhar a tabela inteira
function fluxolabUpdateTotalChk(tableName) {
  const el = document.getElementById(`plan-total-chk-${tableName}`);
  if (el) el.innerText = `Total Checklists: ${fluxolabCalcTotalChk(tableName)}`;
}

function fluxolabBuildPlanRowHtml(tableName, row, idx, themeColor, savedSizes) {
  const tdStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;vertical-align:middle';
  const tdLastStyle = 'border-bottom:1px solid var(--border2);padding:0;vertical-align:middle';

  const statsChk = row.modelo ? fluxolabPlanGetChecklistStats(row.modelo) : { count: 0, media: 0, urgencias: 0, trocas: 0, urgenciasTT: 0 };
  const statsBol = row.modelo ? fluxolabPlanGetBolsaoStats(row.modelo) : { doca: 0, lab: 0, qual: 0 };
  
  const rowBg = idx % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent';
  const isFilled = row.modelo ? true : false;
  
  const inpBase = 'width:100%;height:100%;min-height:36px;border:none;background:transparent;text-align:center;font-weight:800;outline:none;font-family:var(--font);font-size:18px;color:var(--text);transition:all .2s;display:block';
  const inpFocus = 'this.style.background="rgba(255,255,255,0.05)"';
  const inpBlur = 'this.style.background="transparent"';
  const dragHandle = `cursor:grab;`;
  
  const idObs = `pta-${tableName}-r${idx}-obs`;
  const hObs = savedSizes[idObs] || '36px';
  
  const idPecas = `pta-${tableName}-r${idx}-pecas`;
  const hPecas = savedSizes[idPecas] || '36px';
  
  const hasManualChk = String(row.chk_manual != null ? row.chk_manual : '').trim() !== '';
  const effChk = fluxolabGetRowChkCount(row, statsChk);
  const excedente = isFilled ? fluxolabGetChkExcess(tableName, idx) : 0;
  const chkDisplayVal = !isFilled ? '' : (hasManualChk ? row.chk_manual : (statsChk.count || '-'));
  const chkColor = !isFilled ? 'var(--muted)' : (excedente > 0 ? '#f87171' : (effChk > 0 ? '#4ade80' : '#f87171'));
  
  return `
      <tr style="background:${rowBg};transition:background .2s" 
          ondragstart="planDragStartTr(event, '${tableName}')" 
          ondragover="planDragOver(event)" 
          ondragleave="planDragLeave(event)"
          ondrop="planDropTr(event, '${tableName}')" 
          ondragend="planDragEnd(event)"
          onmouseover="this.style.background='rgba(255,255,255,0.04)'" 
          onmouseout="this.style.background='${rowBg}'">
          
        <td style="${tdStyle};color:var(--muted);font-weight:700;font-size:13px;${dragHandle}" 
            title="Arraste para reordenar"
            onmousedown="this.parentNode.setAttribute('draggable','true')"
            onmouseup="this.parentNode.setAttribute('draggable','false')"
            onmouseleave="this.parentNode.setAttribute('draggable','false')">
          <span style="opacity:0.4;margin-right:4px">≡</span>${idx + 1}º
        </td>
        <td style="${tdStyle};color:var(--muted);font-weight:700;font-size:13px">${idx + 1}</td>
        
        <td style="${tdStyle}">
          <div style="display:flex;align-items:center;gap:6px;height:100%;padding:0 8px 0 12px">
            <input id="plan-${tableName}-r${idx}-modelo" type="text" placeholder="Digite..." value="${row.modelo || ''}" 
                   onfocus="if(!this.getAttribute('list'))this.setAttribute('list','modelos-lista');${inpFocus}" onblur="${inpBlur}" 
                   oninput="fluxolabUpdateRowElem(this, '${tableName}', 'modelo')"
                   onchange="fluxolabUpdateRowElem(this, '${tableName}', 'modelo')" 
                   style="flex:1;min-width:0;height:100%;min-height:36px;border:none;background:transparent;text-align:left;font-weight:800;outline:none;font-family:var(--font);font-size:15px;color:${themeColor};padding:0" />
            <span id="plan-${tableName}-r${idx}-badge" style="display:flex;align-items:center;gap:4px">${planBadgeHtml(statsChk.count, isFilled, statsChk.urgencias, statsChk.trocas, statsChk.urgenciasTT)}</span>
          </div>
        </td>
        
        <td id="plan-${tableName}-r${idx}-chk" class="chk-cell" style="${tdStyle};overflow:hidden">
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center">
            <input id="plan-${tableName}-r${idx}-chk_manual" type="text" inputmode="numeric" value="${chkDisplayVal}"
                   class="${excedente > 0 ? 'plan-chk-exceeded' : ''}"
                   ${!isFilled ? 'readonly' : ''}
                   title="${isFilled ? 'Clique para definir a quantidade de checklists manualmente (total do modelo: ' + (statsChk.count || 0) + ')' : ''}"
                   onfocus="this.style.background='rgba(255,255,255,0.05)';this._justFocused=true;if(this.value&&this.value!=='-')this.select();setTimeout(()=>{this._justFocused=false;},250)"
                   onmouseup="if(this._justFocused){this._justFocused=false;return false;}"
                   onblur="${inpBlur};fluxolabCommitRowChk(this, '${tableName}')"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"
                   oninput="fluxolabUpdateRowChkInput(this, '${tableName}')"
                   style="${inpBase};font-weight:900;color:${chkColor};min-width:0;box-sizing:border-box;${!isFilled ? 'cursor:default' : 'cursor:text'}" />
            <div id="plan-${tableName}-r${idx}-chk-exc" class="plan-chk-exc" title="${excedente > 0 ? 'Quantidade excedente: +' + excedente + ' acima do total do modelo (' + (statsChk.count || 0) + ')' : ''}" style="display:${excedente > 0 ? 'block' : 'none'};font-size:10px;font-weight:900;color:#f87171;line-height:1.1;padding:0 4px 4px;white-space:nowrap">${excedente > 0 ? '+' + excedente + ' excedente' : ''}</div>
          </div>
        </td>
        <td id="plan-${tableName}-r${idx}-media" class="media-cell" style="${tdStyle};color:${statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'};font-weight:900;font-size:18px">
          ${isFilled ? (statsChk.media || '-') : ''}
        </td>
        
        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="plan-${tableName}-r${idx}-qtd_wms" type="text" value="${row.qtd_wms || ''}" 
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 oninput="fluxolabUpdateRowElem(this, '${tableName}', 'qtd_wms')"
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'qtd_wms')" 
                 style="${inpBase};min-width:0;box-sizing:border-box" />
        </td>
        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="plan-${tableName}-r${idx}-sugestao" type="text" value="${row.sugestao || ''}" 
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 oninput="fluxolabUpdateRowElem(this, '${tableName}', 'sugestao')"
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'sugestao')" 
                 style="${inpBase};min-width:0;box-sizing:border-box;color:var(--accent)" />
        </td>
        
        <td id="plan-${tableName}-r${idx}-doca" class="doca-cell" style="${tdStyle};background:rgba(34,211,238,0.05);color:#22d3ee;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(34,211,238,0.4)">
          ${isFilled ? (statsBol.doca || '-') : ''}
        </td>
        <td id="plan-${tableName}-r${idx}-lab" class="lab-cell" style="${tdStyle};background:rgba(167,139,250,0.05);color:#a78bfa;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(167,139,250,0.4)">
          ${isFilled ? (statsBol.lab || '-') : ''}
        </td>
        <td id="plan-${tableName}-r${idx}-qual" class="qual-cell" style="${tdStyle};background:rgba(245,166,35,0.05);color:#f5a623;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(245,166,35,0.4)">
          ${isFilled ? (statsBol.qual || '-') : ''}
        </td>
        
        <td style="${tdStyle};padding:4px">
          <textarea id="plan-${tableName}-r${idx}-obs" class="plan-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 oninput="fluxolabUpdateRowElem(this, '${tableName}', 'obs')"
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'obs')" 
                 style="${inpBase};height:${hObs};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical">${esc(row.obs || '')}</textarea>
        </td>
        <td style="${tdStyle};padding:4px">
          <textarea id="plan-${tableName}-r${idx}-pecas" class="plan-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 oninput="fluxolabUpdateRowElem(this, '${tableName}', 'pecas')"
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'pecas')" 
                 style="${inpBase};height:${hPecas};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical">${esc(row.pecas || '')}</textarea>
        </td>
        <td style="${tdLastStyle};width:42px;min-width:42px;max-width:42px;padding:4px;text-align:center">
          <button type="button" class="plan-row-del-btn" onclick="fluxolabRemovePlanRow('${tableName}', ${idx})" title="Remover linha"
            style="width:26px;height:26px;border-radius:6px;border:1px solid rgba(242,87,87,0.35);background:rgba(242,87,87,0.10);color:var(--danger);font-size:12px;font-weight:900;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1;transition:all .15s"
            onmouseover="this.style.background='var(--danger)';this.style.color='#fff'"
            onmouseout="this.style.background='rgba(242,87,87,0.10)';this.style.color='var(--danger)'">✕</button>
        </td>
      </tr>
  `;
}

function fluxolabRenderPlanTable(title, tableName, titleColor, themeColor) {
  fluxolabCompactPlanTable(tableName);
  const rows = _fluxolabPlanejamentoState[tableName] || [];
  const savedSizes = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
  
  const tableStyle = 'width:max-content;border-collapse:separate;border-spacing:0;font-family:var(--font);font-size:14px;text-align:center;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.2);border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3)';
  const thStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  const thLastStyle = 'border-bottom:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  
  const resizableHeader = (content, id, defWidth, minWidth, color) => {
    const savedW = savedSizes[id] || defWidth;
    return `<div id="${id}" class="plan-header-resizer" style="resize:horizontal;overflow:hidden;width:${savedW};min-width:${minWidth};padding:12px 6px;margin:0 auto;color:${color || 'var(--muted)'};font-size:11px;text-transform:uppercase;letter-spacing:0.05em">${content}</div>`;
  };
  
  const mediaSortDir = _planMediaSortDir[tableName] || null;
  const mediaSortArrow = mediaSortDir === 'desc' ? ' ↓' : (mediaSortDir === 'asc' ? ' ↑' : '');
  const mediaHeaderContent = `<span onclick="fluxolabSortPlanByMedia('${tableName}')" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:2px" title="Ordenar por Média Dias (maior → menor)">Média Dias${mediaSortArrow}</span>`;
  
  let html = `
    <div style="margin-bottom:32px;overflow-x:auto;padding-bottom:14px">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th colspan="13" style="background:rgba(255,255,255,0.03);color:${titleColor};padding:14px;font-size:14px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid var(--border2);text-shadow:0 0 12px ${titleColor}50;position:relative">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${titleColor};margin-right:8px;box-shadow:0 0 8px ${titleColor}"></span>
              ${title}
              <span id="plan-total-chk-${tableName}" style="position:absolute;right:100px;top:50%;transform:translateY(-50%);background:rgba(74,222,128,0.12);color:#4ade80;border:1px solid rgba(74,222,128,0.35);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:none;text-shadow:none">Total Checklists: ${fluxolabCalcTotalChk(tableName)}</span>
              <button onclick="fluxolabClearPlanTable('${tableName}')" style="position:absolute;right:14px;top:10px;background:var(--danger);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:800;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em">Limpar</button>
            </th>
          </tr>
          <tr>
            <th style="${thStyle}">${resizableHeader('Ord', `ph-${tableName}-ord`, '50px', '40px')}</th>
            <th style="${thStyle}">${resizableHeader('Lote', `ph-${tableName}-lote`, '50px', '40px')}</th>
            <th style="${thStyle}">${resizableHeader('MODELO', `ph-${tableName}-mod`, '340px', '120px', 'var(--text)')}</th>
            <th style="${thStyle}">${resizableHeader('Checklists', `ph-${tableName}-chk`, '80px', '60px')}</th>
            <th style="${thStyle}">${resizableHeader(mediaHeaderContent, `ph-${tableName}-media`, '80px', '60px')}</th>
            <th style="${thStyle};width:72px;min-width:72px;max-width:72px"><div style="padding:12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Qtd WMS</div></th>
            <th style="${thStyle};width:72px;min-width:72px;max-width:72px"><div style="padding:12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Baixar estoque</div></th>
            <th style="${thStyle}">${resizableHeader('DOCA', `ph-${tableName}-doca`, '60px', '50px', '#22d3ee')}</th>
            <th style="${thStyle}">${resizableHeader('LAB', `ph-${tableName}-lab`, '60px', '50px', '#a78bfa')}</th>
            <th style="${thStyle}">${resizableHeader('QUAL.', `ph-${tableName}-qual`, '60px', '50px', '#f5a623')}</th>
            <th style="${thStyle}">${resizableHeader('Observação', `ph-${tableName}-obs`, '180px', '80px')}</th>
            <th style="${thStyle}">${resizableHeader('Peças', `ph-${tableName}-pecas`, '180px', '80px')}</th>
            <th style="${thLastStyle};width:42px;min-width:42px;max-width:42px"><div style="padding:12px 4px;color:var(--muted);font-size:11px" title="Remover linha">✕</div></th>
          </tr>
        </thead>
        <tbody>
  `;
  
  rows.forEach((row, idx) => {
    html += fluxolabBuildPlanRowHtml(tableName, row, idx, themeColor, savedSizes);
  });
  
  html += `
        </tbody>
      </table>
    </div>
  `;
  return html;
}

// ── Fundo da tabela: escuro (padrão) ou branco com fontes pretas ────────────
// Preferência salva no navegador. Só afeta a aparência (classe .plan-light no painel).
function planIsLightBg(){
  try { return localStorage.getItem('plan_light_bg') === '1'; } catch(e){ return false; }
}
function _planInjectLightCss(){
  if (document.getElementById('plan-light-css')) return;
  const st = document.createElement('style');
  st.id = 'plan-light-css';
  st.textContent = `
    .plan-light table{background:#fff !important;border-color:#cbd5e1 !important;box-shadow:0 4px 18px rgba(0,0,0,.12) !important}
    .plan-light table th,.plan-light table td{background:#fff !important;border-color:#cbd5e1 !important}
    .plan-light table thead tr:first-child th{background:#f1f5f9 !important}
    .plan-light table thead tr:nth-child(2) th{background:#e2e8f0 !important}
    .plan-light table tbody tr:hover td{background:#f8fafc !important}
    .plan-light table,.plan-light table *{color:#000 !important;text-shadow:none !important}
    .plan-light table textarea,.plan-light table input:not([type=checkbox]),.plan-light table select{background:#fff !important;color:#000 !important}
    .plan-light table ::placeholder{color:#64748b !important;opacity:1}
    .plan-light table button,.plan-light table label{background:#f1f5f9 !important;border-color:#94a3b8 !important}
    .plan-light table button[onclick^="fluxolabClearPlanTable"]{background:#dc2626 !important;color:#fff !important;border-color:#dc2626 !important}
    .plan-light table button.plan-row-del-btn{background:#fef2f2 !important;color:#dc2626 !important;border-color:#fca5a5 !important}
    .plan-light table button.plan-row-del-btn:hover{background:#dc2626 !important;color:#fff !important}
    .plan-light table .plan-chk-exc,.plan-light table input.plan-chk-exceeded{color:#dc2626 !important}
    .plan-light table [id$="-colmenu"]{background:#fff !important;border-color:#94a3b8 !important;box-shadow:0 12px 32px rgba(0,0,0,.25) !important}
  `;
  document.head.appendChild(st);
}
function planToggleLightBg(){
  try { localStorage.setItem('plan_light_bg', planIsLightBg() ? '0' : '1'); } catch(e){}
  fluxolabRenderPlanejamento();
}
window.planToggleLightBg = planToggleLightBg;

function fluxolabRenderPlanejamento() {
  const panel = document.getElementById('fluxolab-tab-planejamento-panel');
  if (!panel) return;
  _planInjectLightCss();
  panel.classList.toggle('plan-light', planIsLightBg());
  _fluxolabEnsureModelosDatalist();
  
  let html = '';
  
  html += `
    <div style="margin-bottom:24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="background:var(--bg3);padding:10px;border-radius:12px;border:1px solid var(--border2);display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 2px 10px rgba(0,0,0,0.3)">
          <span style="font-size:24px;line-height:1">🌐</span>
        </div>
        <div>
          <h2 style="font-size:22px;font-weight:900;color:var(--text);margin:0;letter-spacing:-0.02em">Planejamento do Dia <span style="font-size:10px;background:#4ade8022;color:#4ade80;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase">Online</span></h2>
          <p style="font-size:13px;color:var(--muted);margin:4px 0 0">Modo Multiplayer: Qualquer alteração feita por você ou por outros usuários atualiza a tela em tempo real sem conflitos.</p>
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <div style="display:inline-flex;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border2);border-radius:8px;padding:6px 12px;font-size:11px;color:var(--muted)">
          <span style="display:inline-flex;align-items:center;gap:5px"><span style="background:rgba(234,179,8,0.20);color:#fde047;border:1px solid rgba(234,179,8,0.55);font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px">TT</span> Troca Técnica</span>
          <span style="width:1px;height:14px;background:var(--border2)"></span>
          <span style="display:inline-flex;align-items:center;gap:5px"><span style="background:rgba(249,115,22,0.20);color:#fb923c;border:1px solid rgba(249,115,22,0.55);font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px">URG.TT</span> Urgência TT</span>
          <span style="width:1px;height:14px;background:var(--border2)"></span>
          <span style="display:inline-flex;align-items:center;gap:5px"><span style="background:rgba(239,68,68,0.20);color:#f87171;border:1px solid rgba(239,68,68,0.55);font-size:9px;font-weight:800;padding:2px 7px;border-radius:10px">URG.</span> Urgência</span>
        </div>
        <button type="button" onclick="planToggleLightBg()" title="Alterna o fundo da tabela entre escuro e branco (fontes pretas)" style="background:var(--bg3);color:var(--muted);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;font-size:11px;font-weight:800;cursor:pointer;font-family:var(--font)">${planIsLightBg() ? '🌙 Fundo escuro' : '☀️ Fundo branco'}</button>
      </div>
    </div>
  `;
  
  html += fluxolabRenderPlanTable('PROGRAMAÇÃO ENTRADA EM LOTE LABORATÓRIO', 'tabela1', '#22d3ee', '#22d3ee');
  html += fluxolabRenderPlanTable('PROJETOS', 'tabela2', '#a78bfa', '#a78bfa');
  html += fluxolabRenderPlanTable('PRIORIDADE DE SAÍDA', 'tabela3', '#fb923c', '#fb923c');
  
  panel.innerHTML = html;
  planInitResizeObserver();
}
// OTIMIZAÇÃO EGRESS/REALTIME: Planejamento carrega sob demanda ao abrir a aba FluxoLAB → Planejamento.


