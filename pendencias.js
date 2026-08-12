// ════════════════════════════════════════════════════════════════
// PENDÊNCIAS MISTAS / COMPLEXAS (STATE, DRAG & DROP E MULTIPLAYER REALTIME)
// Mesmo padrão da aba "Planejamento do Dia", em namespace próprio
// para não conflitar com _fluxolabPlanejamentoState.
// ════════════════════════════════════════════════════════════════
var _fluxolabPendenciasState = typeof _fluxolabPendenciasState !== 'undefined' ? _fluxolabPendenciasState : { mistas: [], complexas: [] };
var _fluxolabPendLoaded = typeof _fluxolabPendLoaded !== 'undefined' ? _fluxolabPendLoaded : false;
var _pendSyncChannel = typeof _pendSyncChannel !== 'undefined' ? _pendSyncChannel : null;
var _pendMediaSortDir = typeof _pendMediaSortDir !== 'undefined' ? _pendMediaSortDir : { mistas: null, complexas: null };
var _pendAbertoSortDir = typeof _pendAbertoSortDir !== 'undefined' ? _pendAbertoSortDir : { mistas: null, complexas: null };
var _pendActiveSortCol = typeof _pendActiveSortCol !== 'undefined' ? _pendActiveSortCol : { mistas: null, complexas: null };
var _pendExpandedRows = typeof _pendExpandedRows !== 'undefined' ? _pendExpandedRows : {};

// Mínimo de linhas: a tabela agora cresce e ENCOLHE conforme os registros.
const PEND_ROW_MIN = { mistas: 1, complexas: 1 };
const PEND_FIELDS = ['modelo', 'qtd_wms', 'sugestao', 'obs', 'pecas'];

// ─── Definição das colunas (largura, largura mínima e possibilidade de ocultar) ───
const PEND_COL_DEFS = [
  { k: 'ord',      label: 'Ord',        rz: 'ord',    w: '50px',  min: '40px' },
  { k: 'lote',     label: 'Lote',       rz: 'lote',   w: '50px',  min: '40px' },
  { k: 'modelo',   label: 'Modelo',     rz: 'mod',    w: '340px', min: '120px' },
  { k: 'chk',      label: 'Checklists', rz: 'chk-v2', w: '60px',  min: '50px' },
  { k: 'media',    label: '⏱ Dias Úteis Andamento', rz: 'media',  w: '110px', min: '80px' },
  { k: 'diasab',   label: 'Dias em Aberto', rz: 'diasab', w: '96px', min: '70px' },
  { k: 'qtd_wms',  label: 'Qtd WMS',    rz: 'qtd',    w: '72px',  min: '50px' },
  { k: 'sugestao', label: 'Sugerido',   rz: 'sug',    w: '72px',  min: '50px' },
  { k: 'doca',     label: 'DOCA',       rz: 'doca',   w: '70px',  min: '55px' },
  { k: 'lab',      label: 'LAB',        rz: 'lab',    w: '70px',  min: '55px' },
  { k: 'bolsao',   label: 'Bolsão',     rz: 'bolsao', w: '160px', min: '60px' },
  { k: 'obs',      label: 'Observação', rz: 'obs',    w: '180px', min: '70px' },
  { k: 'pecas',    label: 'Peças',      rz: 'pecas',  w: '180px', min: '70px' },
];

let _pendColMenuOpen = {};

function pendGetHiddenCols() {
  try { return JSON.parse(localStorage.getItem('fluxolabPendHiddenCols') || '{}'); }
  catch (e) { return {}; }
}
function pendIsColHidden(tableName, key) {
  const h = pendGetHiddenCols();
  return !!(h[tableName] && h[tableName][key]);
}
function pendToggleCol(tableName, key) {
  const h = pendGetHiddenCols();
  h[tableName] = h[tableName] || {};
  h[tableName][key] = !h[tableName][key];
  localStorage.setItem('fluxolabPendHiddenCols', JSON.stringify(h));
  _pendColMenuOpen[tableName] = true;
  fluxolabRenderPendencias();
}
function pendShowAllCols(tableName) {
  const h = pendGetHiddenCols();
  h[tableName] = {};
  localStorage.setItem('fluxolabPendHiddenCols', JSON.stringify(h));
  _pendColMenuOpen[tableName] = true;
  fluxolabRenderPendencias();
}
function pendNormModelo(modelo) {
  return (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modelo) : String(modelo || '').toUpperCase().replace(/\s+/g, '');
}

function pendIsListaDetalhada(tableName) {
  try {
    const o = JSON.parse(localStorage.getItem('fluxolabPendListaDetalhada') || '{}');
    return !!o[tableName];
  } catch (e) { return false; }
}

function pendToggleListaDetalhada(tableName, checked) {
  try {
    const o = JSON.parse(localStorage.getItem('fluxolabPendListaDetalhada') || '{}');
    o[tableName] = !!checked;
    localStorage.setItem('fluxolabPendListaDetalhada', JSON.stringify(o));
  } catch (e) {}
  _pendExpandedRows[tableName] = new Set();
  fluxolabRenderPendencias();
}

function pendCountModeloInTable(tableName, modelo, excludeIndex) {
  const norm = pendNormModelo(modelo);
  let n = 0;
  (_fluxolabPendenciasState[tableName] || []).forEach((r, i) => {
    if (i === excludeIndex) return;
    if (r.modelo && pendNormModelo(r.modelo) === norm) n++;
  });
  return n;
}

function pendValidateModeloQuota(tableName, modelo, excludeIndex) {
  const trimmed = String(modelo || '').trim();
  if (!trimmed) return null;
  const existing = pendCountModeloInTable(tableName, trimmed, excludeIndex);
  if (existing >= 1) {
    return `Este modelo já está na lista.\n\nNa lista detalhada, cada checklist é exibido automaticamente — não duplique a linha do modelo.`;
  }
  return null;
}

function pendGetChecklistItemStats(stats, chkIdx) {
  if (!stats || !stats.rows || !stats.rows.length) return { diasUteis: 0, diasAberto: 0 };
  const r = stats.rows[chkIdx != null ? chkIdx : 0];
  if (!r) return { diasUteis: 0, diasAberto: 0 };
  const kDias = stats.keys && stats.keys.kDias;
  const kAberto = stats.keys && stats.keys.kAberto;
  let diasUteis = 0;
  let diasAberto = 0;
  if (kDias) { const d = parseInt(r[kDias]); if (!isNaN(d)) diasUteis = d; }
  if (kAberto) { const a = parseInt(r[kAberto]); if (!isNaN(a)) diasAberto = a; }
  return { diasUteis, diasAberto, row: r };
}

// Índices dos checklists ordenados por Dias Úteis Andamento
function pendGetSortedChecklistIndices(stats, dir) {
  if (!stats || !stats.rows || !stats.rows.length) return [];
  const indices = stats.rows.map((_, i) => i);
  const desc = dir !== 'asc';
  indices.sort((a, b) => {
    const sa = pendGetChecklistItemStats(stats, a);
    const sb = pendGetChecklistItemStats(stats, b);
    const diff = desc ? (sb.diasUteis - sa.diasUteis) : (sa.diasUteis - sb.diasUteis);
    if (diff !== 0) return diff;
    const ab = desc ? (sb.diasAberto - sa.diasAberto) : (sa.diasAberto - sb.diasAberto);
    return ab !== 0 ? ab : a - b;
  });
  return indices;
}

function pendPushDetailedChecklists(display, row, idx, stats, tableName) {
  const sortDir = (_pendMediaSortDir[tableName] === 'asc') ? 'asc' : 'desc';
  const sortedIdx = pendGetSortedChecklistIndices(stats, sortDir);
  sortedIdx.forEach((chkIdx, seq) => {
    display.push({
      row, stateIdx: idx, chkIdx, chkSeq: seq + 1, virtual: seq > 0,
      itemStats: pendGetChecklistItemStats(stats, chkIdx),
      stats,
    });
  });
}

function pendBuildDisplayRows(tableName, rows) {
  const detailed = pendIsListaDetalhada(tableName);
  const display = [];
  const seenNorm = new Set();

  rows.forEach((row, idx) => {
    if (!row.modelo) {
      display.push({ row, stateIdx: idx, chkIdx: null, chkSeq: null, virtual: false, itemStats: null, stats: null });
      return;
    }
    const norm = pendNormModelo(row.modelo);
    if (detailed && seenNorm.has(norm)) return;
    if (detailed) seenNorm.add(norm);

    const stats = fluxolabPlanGetChecklistStats(row.modelo);

    if (!detailed || stats.count <= 1) {
      display.push({
        row, stateIdx: idx, chkIdx: stats.count === 1 ? 0 : null, chkSeq: stats.count === 1 ? 1 : null, virtual: false,
        itemStats: stats.count === 1 ? pendGetChecklistItemStats(stats, 0) : null,
        stats,
      });
      return;
    }

    pendPushDetailedChecklists(display, row, idx, stats, tableName);
  });

  if (detailed) {
    const empty = display.filter(d => !d.row.modelo);
    const filled = display.filter(d => d.row.modelo);
    const activeCol = _pendActiveSortCol[tableName] || 'media';
    const sortDir = activeCol === 'diasab'
      ? ((_pendAbertoSortDir[tableName] === 'asc') ? 'asc' : 'desc')
      : ((_pendMediaSortDir[tableName] === 'asc') ? 'asc' : 'desc');
    filled.sort((a, b) => {
      if (activeCol === 'diasab') {
        const da = a.itemStats ? a.itemStats.diasAberto : 0;
        const db = b.itemStats ? b.itemStats.diasAberto : 0;
        const diff = sortDir === 'asc' ? da - db : db - da;
        if (diff !== 0) return diff;
        const ua = a.itemStats ? a.itemStats.diasUteis : 0;
        const ub = b.itemStats ? b.itemStats.diasUteis : 0;
        const uDiff = sortDir === 'asc' ? ua - ub : ub - ua;
        if (uDiff !== 0) return uDiff;
      } else {
        const da = a.itemStats ? a.itemStats.diasUteis : 0;
        const db = b.itemStats ? b.itemStats.diasUteis : 0;
        const diff = sortDir === 'asc' ? da - db : db - da;
        if (diff !== 0) return diff;
        const aa = a.itemStats ? a.itemStats.diasAberto : 0;
        const ab = b.itemStats ? b.itemStats.diasAberto : 0;
        const abDiff = sortDir === 'asc' ? aa - ab : ab - aa;
        if (abDiff !== 0) return abDiff;
      }
      return (a.stateIdx - b.stateIdx) || ((a.chkSeq || 0) - (b.chkSeq || 0));
    });
    return filled.concat(empty);
  }

  return display;
}

function pendTotalChkUnico(rows) {
  const seen = new Set();
  let total = 0;
  rows.forEach(row => {
    if (!row.modelo) return;
    const norm = pendNormModelo(row.modelo);
    if (seen.has(norm)) return;
    seen.add(norm);
    total += (fluxolabPlanGetChecklistStats(row.modelo).count || 0);
  });
  return total;
}

function pendToggleColMenu(tableName) {
  _pendColMenuOpen[tableName] = !_pendColMenuOpen[tableName];
  const m = document.getElementById(`pnd-${tableName}-colmenu`);
  if (m) m.style.display = _pendColMenuOpen[tableName] ? 'block' : 'none';
}

// Remove as linhas vazias sobrando no final: mantém apenas UMA linha vazia
// após o último registro preenchido (a tabela encolhe sozinha).
function pendTrimRows(tableName, keepIndex) {
  const list = _fluxolabPendenciasState[tableName];
  if (!Array.isArray(list)) return false;
  const isEmpty = r => PEND_FIELDS.every(f => !String((r && r[f]) || '').trim());
  let last = -1;
  list.forEach((r, i) => { if (!isEmpty(r)) last = i; });
  let target = Math.max(last + 2, PEND_ROW_MIN[tableName] || 1);
  if (typeof keepIndex === 'number') target = Math.max(target, keepIndex + 2);
  target = Math.min(target, list.length);
  if (list.length > target) { list.length = target; return true; }
  return false;
}

// Carrega o estado do Supabase
async function fluxolabLoadPendencias() {
  if (typeof currentUser === 'undefined' || !currentUser) return;
  if (typeof _supa !== 'undefined') {
    try {
      const {data, error} = await _supa.from('fluxolab_state').select('data').eq('key', 'pendencias_mistas_complexas').maybeSingle();
      if (!error && data && data.data) {
        _fluxolabPendenciasState = Object.assign({ mistas: [], complexas: [] }, data.data);
      }
      if (error) console.warn('[pend] load erro:', error);
    } catch(e) { console.error('Erro ao carregar pendências:', e); }

    // Realtime — nunca bloqueia o loaded se o helper falhar
    if (!_pendSyncChannel) {
      _pendSyncChannel = true;
      try {
        if (typeof window._fluxolabStateOn === 'function') {
          window._fluxolabStateOn('pendencias_mistas_complexas', payload => {
            if (payload.new && payload.new.data) {
              fluxolabApplyRemoteSyncPend(payload.new.data);
            }
          });
        } else {
          console.warn('[pend] _fluxolabStateOn indisponível — sync realtime desligado');
        }
      } catch (e) {
        console.warn('[pend] falha ao registrar realtime:', e);
      }
    }
  }

  // A tabela acompanha a quantidade de registros: corta o excesso de linhas
  // vazias no final e garante sempre uma linha livre para digitar.
  Object.keys(PEND_ROW_MIN).forEach(t => {
    if (!Array.isArray(_fluxolabPendenciasState[t])) _fluxolabPendenciasState[t] = [];
    pendTrimRows(t);
    while (_fluxolabPendenciasState[t].length < (PEND_ROW_MIN[t] || 1)) {
      _fluxolabPendenciasState[t].push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
  });

  _fluxolabPendLoaded = true;
  try { _fluxolabPendLastSavedJSON = JSON.stringify(_fluxolabPendenciasState); } catch (e) { _fluxolabPendLastSavedJSON = null; }

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'pendencias') {
    fluxolabRenderPendencias();
  }
}

// Salva o estado no Supabase
let _fluxolabPendSaveTimer;
let _fluxolabPendLastSavedJSON = null;
let _fluxolabPendSaving = false;

async function fluxolabSavePendenciasNow() {
  if (!_fluxolabPendLoaded) return false;
  if (typeof _supa === 'undefined') return false;
  if (_fluxolabPendSaving) {
    clearTimeout(_fluxolabPendSaveTimer);
    _fluxolabPendSaveTimer = setTimeout(() => { fluxolabSavePendenciasDebounced(); }, 400);
    return false;
  }
  let snap;
  try { snap = JSON.stringify(_fluxolabPendenciasState); } catch (e) { snap = null; }
  if (snap && snap === _fluxolabPendLastSavedJSON) return true;
  _fluxolabPendSaving = true;
  try {
    const { error } = await _supa.from('fluxolab_state').upsert(
      { key: 'pendencias_mistas_complexas', data: _fluxolabPendenciasState },
      { onConflict: 'key' }
    );
    if (error) {
      console.warn('[pend] save erro:', error);
      return false;
    }
    _fluxolabPendLastSavedJSON = snap;
    return true;
  } catch (e) {
    console.warn('[pend] save falhou:', e);
    return false;
  } finally {
    _fluxolabPendSaving = false;
  }
}

function fluxolabSavePendenciasDebounced() {
  if (!_fluxolabPendLoaded) return;
  clearTimeout(_fluxolabPendSaveTimer);
  _fluxolabPendSaveTimer = setTimeout(() => { fluxolabSavePendenciasNow(); }, 900);
}

if (typeof window !== 'undefined' && !window._pendFlushBound) {
  window._pendFlushBound = true;
  window.addEventListener('beforeunload', () => {
    try { fluxolabSavePendenciasNow(); } catch (e) {}
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      try { fluxolabSavePendenciasNow(); } catch (e) {}
    }
  });
}

// Aplica as atualizações que vieram de outros usuários (Tempo Real)
function fluxolabApplyRemoteSyncPend(remoteData) {
  if (!_fluxolabPendLoaded || !remoteData) return;

  try {
    const localSnap = JSON.stringify(_fluxolabPendenciasState);
    if (_fluxolabPendLastSavedJSON != null && localSnap !== _fluxolabPendLastSavedJSON) {
      fluxolabSavePendenciasDebounced();
      return;
    }
  } catch (e) {}

  let needRender = false;


  Object.keys(PEND_ROW_MIN).forEach(t => {
    if (!remoteData[t]) return;

    for (let i = 0; i < remoteData[t].length; i++) {
      if (!_fluxolabPendenciasState[t][i]) _fluxolabPendenciasState[t][i] = { modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' };

      const remoteRow = remoteData[t][i];
      const localRow = _fluxolabPendenciasState[t][i];

      PEND_FIELDS.forEach(f => {
        const val = remoteRow[f] || '';
        localRow[f] = val; // Atualiza a memória local

        // Atualiza a tela discretamente, APENAS se o usuário não estiver digitando neste campo agora
        const inpId = `pnd-${t}-r${i}-${f}`;
        const inpElem = document.getElementById(inpId);
        if (inpElem && document.activeElement !== inpElem) {
          inpElem.value = val;

          // Se for modelo, precisa recalcular Checklists/Bolsões visualmente
          if (f === 'modelo') {
            needRender = true;
          }
        }
      });
    }
    pendUpdateHeaderTotals(t);
    // Se o outro usuário removeu/adicionou linhas, ajusta a quantidade aqui também
    if (remoteData[t].length !== _fluxolabPendenciasState[t].length) {
      _fluxolabPendenciasState[t].length = remoteData[t].length;
      needRender = true;
    }
  });
  if (needRender) {
    const activeId = document.activeElement ? document.activeElement.id : null;
    if (!activeId || activeId.indexOf('pnd-') !== 0) fluxolabRenderPendencias();
  }
  if (typeof updateActiveUsersInTables === 'function') updateActiveUsersInTables();
  try { _fluxolabPendLastSavedJSON = JSON.stringify(_fluxolabPendenciasState); } catch (e) {}
}

// Recalcula e atualiza os totais de DOCA/LAB/Checklists exibidos no cabeçalho da tabela
function pendUpdateHeaderTotals(tableName) {
  const rows = _fluxolabPendenciasState[tableName] || [];
  let totalDoca = 0, totalLab = 0;
  rows.forEach(row => {
    if (!row.modelo) return;
    const statsBol = fluxolabPlanGetBolsaoStats(row.modelo);
    totalDoca += statsBol.doca || 0;
    totalLab += statsBol.lab || 0;
  });
  const totalChk = pendTotalChkUnico(rows);
  const elDoca = document.getElementById(`pnd-${tableName}-doca-total`);
  const elLab = document.getElementById(`pnd-${tableName}-lab-total`);
  const elChk = document.getElementById(`pnd-${tableName}-chk-total`);
  if (elDoca) elDoca.innerText = `(${totalDoca})`;
  if (elLab) elLab.innerText = `(${totalLab})`;
  if (elChk) elChk.innerText = `Total Checklists: ${totalChk}`;
}

// Atualização local pelo usuário atual
function fluxolabUpdateRowElemPend(elem, tableName, field) {
  const tr = elem.closest('tr');
  if (!tr || tr.dataset.pndVirtual === '1') return;
  const index = parseInt(tr.dataset.pndIdx, 10);
  if (isNaN(index)) return;

  if (!_fluxolabPendenciasState[tableName]) return;
  if (!_fluxolabPendenciasState[tableName][index]) return;

  const oldValue = _fluxolabPendenciasState[tableName][index][field] || '';
  const value = elem.value;

  if (field === 'modelo') {
    const err = pendValidateModeloQuota(tableName, value, index);
    if (err) {
      elem.value = oldValue;
      alert(err);
      return;
    }
  }

  _fluxolabPendenciasState[tableName][index][field] = value;

  const isLastRow = index === _fluxolabPendenciasState[tableName].length - 1;
  const rowHasData = _fluxolabPendenciasState[tableName][index].modelo.trim() !== '' ||
                     _fluxolabPendenciasState[tableName][index].qtd_wms.trim() !== '' ||
                     _fluxolabPendenciasState[tableName][index].sugestao.trim() !== '' ||
                     _fluxolabPendenciasState[tableName][index].obs.trim() !== '' ||
                     _fluxolabPendenciasState[tableName][index].pecas.trim() !== '';

  // FIX (bug "campo de texto apaga enquanto digita no FluxoLAB > Pendências"):
  // Antes, ao completar a última linha (ou esvaziar uma), a tabela inteira era
  // reconstruída 10ms depois, num timer fixo. Se o usuário já tivesse saído do
  // campo (Tab/Enter) e começado a digitar no PRÓXIMO campo dentro desses
  // 10ms — bem comum ao preencher rapidamente — o rebuild destruía esse campo
  // no meio da digitação e recriava com o valor antigo (vazio), porque a
  // tecla digitada ainda não tinha sido salva no estado. Parecia que o campo
  // "se atualizava sozinho e apagava". Agora: se o usuário ainda estiver com
  // o foco em algum campo desta mesma tabela, adia o rebuild e tenta de novo
  // mais adiante, em vez de reconstruir por baixo dele; só força depois de
  // ~5s para não deixar a tabela permanentemente desatualizada.
  const reRender = () => {
    fluxolabSavePendenciasDebounced();
    const attempt = (retriesLeft) => {
      const active = document.activeElement;
      const stillEditingThisTable = active && active.id && active.id.indexOf(`pnd-${tableName}-`) === 0;
      if (stillEditingThisTable && retriesLeft > 0) {
        setTimeout(() => attempt(retriesLeft - 1), 250);
        return;
      }
      const activeId = active ? active.id : null;
      fluxolabRenderPendencias();
      if (activeId) {
        const el = document.getElementById(activeId);
        if (el) el.focus();
      }
    };
    setTimeout(() => attempt(20), 10);
  };

  if (isLastRow && rowHasData) {
    _fluxolabPendenciasState[tableName].push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    reRender();
    return;
  }

  // Linha esvaziada: a tabela encolhe removendo as linhas vazias do final
  if (!rowHasData && pendTrimRows(tableName, index)) {
    reRender();
    return;
  }

  fluxolabSavePendenciasDebounced();


  if (field === 'modelo') {
    pendUpdateHeaderTotals(tableName);
    if (typeof updateActiveUsersInTables === 'function') updateActiveUsersInTables();
    const activeId = `pnd-${tableName}-r${index}-modelo`;
    fluxolabRenderPendencias();
    const inp = document.getElementById(activeId);
    if (inp) {
      inp.focus();
      try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch(e){}
    }
    return;
  }
}

function fluxolabClearPendTable(tableName) {
  const label = tableName === 'mistas' ? 'Pendências Mistas' : 'Complexas';
  if (confirm(`Tem certeza que deseja limpar a lista ${label}? Os ajustes de tamanho da tabela não serão perdidos.`)) {
    _fluxolabPendenciasState[tableName] = [{ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' }];
    fluxolabSavePendenciasDebounced();
    fluxolabRenderPendencias();
  }
}

// HTML da célula Checklists — clicável quando há mais de um checklist
function pendChkCellHtml(stats, tableName, idx, isFilled) {
  if (!isFilled) return '';
  if (!stats || !stats.count) return '-';
  if (stats.count <= 1) return String(stats.count);
  const isExpanded = (_pendExpandedRows[tableName] || new Set()).has(idx);
  return `<span onclick="pendToggleExpand('${tableName}',${idx})" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:3px" title="Clique para expandir os ${stats.count} checklists">
    ${stats.count}
    <span id="pnd-${tableName}-r${idx}-expand-arr" style="font-size:10px;color:var(--muted);display:inline-block;transition:transform .2s;${isExpanded ? 'transform:rotate(180deg)' : ''}">▾</span>
  </span>`;
}

// Texto/HTML da célula "Dias em Aberto" (maior valor entre os checklists do modelo)
function pendDiasAbertoHtml(stats) {
  if (!stats || !stats.count || !stats.maxAberto) return '-';
  const dias = stats.maxAberto;
  const color = dias >= 30 ? '#ef4444' : dias >= 15 ? '#f59e0b' : dias >= 7 ? '#facc15' : '#4ade80';
  return `<span style="font-size:18px;font-weight:900;color:${color};font-family:var(--mono);line-height:1">${dias}d</span>`;
}

// Texto/HTML da coluna "Dias Úteis Andamento"
function pendDiasUteisHtml(stats) {
  if (!stats || !stats.count) return '-';
  const max = stats.maxDiasUteis || stats.media || 0;
  if (!max && !stats.media) return '-';
  const color = max >= 20 ? '#ef4444' : max >= 10 ? '#f59e0b' : max >= 4 ? '#facc15' : 'var(--text)';
  return `<span style="font-size:18px;font-weight:900;color:${color};font-family:var(--mono);line-height:1">${max}d</span>`;
}

function pendDiasUteisItemHtml(itemStats) {
  if (!itemStats) return '-';
  const dias = itemStats.diasUteis;
  if (dias == null || isNaN(dias)) return '-';
  const color = dias >= 20 ? '#ef4444' : dias >= 10 ? '#f59e0b' : dias >= 4 ? '#facc15' : 'var(--text)';
  return `<span style="font-size:18px;font-weight:900;color:${color};font-family:var(--mono);line-height:1">${dias}d</span>`;
}

function pendDiasAbertoItemHtml(itemStats) {
  if (!itemStats || !itemStats.diasAberto) return '-';
  const dias = itemStats.diasAberto;
  const color = dias >= 30 ? '#ef4444' : dias >= 15 ? '#f59e0b' : dias >= 7 ? '#facc15' : '#4ade80';
  return `<span style="font-size:18px;font-weight:900;color:${color};font-family:var(--mono);line-height:1">${dias}d</span>`;
}

function pendRenderChecklistDetalhes(stats) {
  if (!stats || !stats.rows || !stats.rows.length) {
    return '<div style="padding:10px 14px;color:var(--muted);font-size:12px">Nenhum checklist encontrado.</div>';
  }
  const sample = stats.rows[0];
  const fk = (label, ...alts) => {
    if (typeof _fluxolabFindKey !== 'function') return null;
    return _fluxolabFindKey(sample, label) || alts.map(a => _fluxolabFindKey(sample, a)).find(Boolean) || null;
  };
  const kAndamento = fk('Andamento');
  const kPedido = fk('Pedido');
  const kDiasUteis = (stats.keys && stats.keys.kDias) || fk('Dias Úteis Andamento', 'Dias Uteis Andamento', 'Dias Úteis');
  const kDiasAb = (stats.keys && stats.keys.kAberto) || fk('Dias Aberto', 'Dias em Aberto', 'Dias Abertos');
  const kStatus = fk('Status Checklist', 'Status');
  const kObs = fk('Obs', 'Observação');

  const headers = [
    ['Andamento', kAndamento],
    ['Pedido', kPedido],
    ['Dias Úteis', kDiasUteis],
    ['Dias Aberto', kDiasAb],
    ['Status', kStatus],
    ['Obs', kObs],
  ].filter(([, key]) => key);

  const ths = headers.map(([h]) =>
    `<th style="padding:6px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--muted);border-bottom:1px solid var(--border2);white-space:nowrap">${h}</th>`
  ).join('');

  const trs = stats.rows.map(r => {
    const tds = headers.map(([, key]) => {
      let val = '—';
      if (key && (key === kDiasUteis || key === kDiasAb)) {
        const n = parseFloat(String(r[key] || '').replace(',', '.'));
        val = isNaN(n) ? '—' : String(Number.isInteger(n) ? n : n.toFixed(1).replace('.', ','));
      } else if (key && r[key] != null && String(r[key]).trim() !== '') {
        val = esc(r[key]);
      }
      return `<td style="padding:6px 10px;font-size:12px;color:var(--text);border-bottom:1px solid var(--border);vertical-align:top">${val}</td>`;
    }).join('');
    return `<tr>${tds}</tr>`;
  }).join('');

  return `<div style="background:rgba(0,0,0,.25);padding:8px 12px 12px;border-top:1px dashed var(--border2)">
    <div style="font-size:10px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${stats.rows.length} checklist(s) deste modelo</div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;min-width:640px">
        <thead><tr style="background:rgba(0,0,0,.2)">${ths}</tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
  </div>`;
}

function pendToggleExpand(tableName, idx) {
  if (!_pendExpandedRows[tableName]) _pendExpandedRows[tableName] = new Set();
  const detId = `pnd-${tableName}-det-${idx}`;
  const det = document.getElementById(detId);
  const arr = document.getElementById(`pnd-${tableName}-r${idx}-expand-arr`);
  if (!det) return;
  const open = det.style.display !== 'none';
  det.style.display = open ? 'none' : '';
  if (arr) {
    arr.style.display = 'inline-block';
    arr.style.transition = 'transform .2s';
    arr.style.transform = open ? '' : 'rotate(180deg)';
  }
  if (open) _pendExpandedRows[tableName].delete(idx);
  else _pendExpandedRows[tableName].add(idx);
}

// Ordena a tabela pela coluna "Dias em Aberto" (clique alterna maior→menor / menor→maior)
function fluxolabSortPendByDiasAberto(tableName) {
  const list = _fluxolabPendenciasState[tableName];
  if (!list || !list.length) return;

  const currentDir = _pendAbertoSortDir[tableName];
  const nextDir = currentDir === 'desc' ? 'asc' : 'desc';
  _pendAbertoSortDir[tableName] = nextDir;
  _pendActiveSortCol[tableName] = 'diasab';

  if (pendIsListaDetalhada(tableName)) {
    fluxolabRenderPendencias();
    return;
  }

  const filled = [];
  const empty = [];
  list.forEach(row => {
    if (row.modelo) {
      filled.push({ row, dias: fluxolabPlanGetChecklistStats(row.modelo).maxAberto || 0 });
    } else {
      empty.push(row);
    }
  });

  filled.sort((a, b) => nextDir === 'desc' ? (b.dias - a.dias) : (a.dias - b.dias));

  _fluxolabPendenciasState[tableName] = filled.map(x => x.row).concat(empty);

  fluxolabSavePendenciasDebounced();
  fluxolabRenderPendencias();
}

// Ordena a tabela pela coluna "Média Dias" (clique alterna maior→menor / menor→maior)
function fluxolabSortPendByMedia(tableName) {
  const list = _fluxolabPendenciasState[tableName];
  if (!list || !list.length) return;

  const currentDir = _pendMediaSortDir[tableName];
  const nextDir = currentDir === 'desc' ? 'asc' : 'desc';
  _pendMediaSortDir[tableName] = nextDir;
  _pendActiveSortCol[tableName] = 'media';

  if (pendIsListaDetalhada(tableName)) {
    fluxolabRenderPendencias();
    return;
  }

  // Separa linhas preenchidas das vazias — vazias permanecem sempre no final
  const filled = [];
  const empty = [];
  list.forEach(row => {
    if (row.modelo) {
      filled.push({ row, media: (fluxolabPlanGetChecklistStats(row.modelo).maxDiasUteis || fluxolabPlanGetChecklistStats(row.modelo).media || 0) });
    } else {
      empty.push(row);
    }
  });

  filled.sort((a, b) => nextDir === 'desc' ? (b.media - a.media) : (a.media - b.media));

  _fluxolabPendenciasState[tableName] = filled.map(x => x.row).concat(empty);

  fluxolabSavePendenciasDebounced();
  fluxolabRenderPendencias();
}

// DRAG & DROP
let _pendDraggedTr = null;
let _pendDraggedTableName = null;

function pendDragStartTr(e, tableName) {
  _pendDraggedTr = e.currentTarget;
  _pendDraggedTableName = tableName;
  e.dataTransfer.effectAllowed = 'move';
  setTimeout(() => _pendDraggedTr.style.opacity = '0.4', 0);
}
function pendDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.borderTop = '2px solid var(--accent)';
}
function pendDragLeave(e) {
  e.currentTarget.style.borderTop = '';
}
function pendDropTr(e, tableName) {
  e.preventDefault();
  const dropTr = e.currentTarget;
  dropTr.style.borderTop = '';

  if (_pendDraggedTableName !== tableName || !_pendDraggedTr || _pendDraggedTr === dropTr) return;
  if (_pendDraggedTr.dataset.pndVirtual === '1' || dropTr.dataset.pndVirtual === '1') return;

  const oldIdx = parseInt(_pendDraggedTr.dataset.pndIdx, 10);
  const newIdx = parseInt(dropTr.dataset.pndIdx, 10);
  if (isNaN(oldIdx) || isNaN(newIdx) || oldIdx === newIdx) return;

  const list = _fluxolabPendenciasState[tableName];
  const item = list.splice(oldIdx, 1)[0];
  list.splice(newIdx, 0, item);
  fluxolabSavePendenciasDebounced();
  fluxolabRenderPendencias();
}
function pendDragEnd(e) {
  e.target.style.opacity = '1';
  e.target.setAttribute('draggable', 'false');
}

// ─── Larguras de coluna: alça na borda (sem CSS resize — evitava “puxar de volta”) ───
let _pendResizeObserver = null;
let _pendColDrag = null; // { id, startX, startW, minW }
let _pendRenderQueued = false;
const PEND_SIZES_VER = 3; // bump quando o formato/comportamento de larguras mudar

function pendMigrateColSizes() {
  try {
    const ver = parseInt(localStorage.getItem('fluxolabPendSizesVer') || '0', 10) || 0;
    if (ver >= PEND_SIZES_VER) return;
    const saved = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}');
    Object.keys(saved).forEach(k => {
      if (/^ph-pnd-/.test(k)) delete saved[k];
    });
    localStorage.setItem('fluxolabPendSizes', JSON.stringify(saved));
    localStorage.setItem('fluxolabPendSizesVer', String(PEND_SIZES_VER));
  } catch (e) {
    try { localStorage.setItem('fluxolabPendSizesVer', String(PEND_SIZES_VER)); } catch (e2) {}
  }
}

function pendGetSavedSizes() {
  pendMigrateColSizes();
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}'); } catch (e) { saved = {}; }
  let changed = false;
  Object.keys(saved).forEach(id => {
    if (!/^ph-pnd-/.test(id)) return; // textareas usam outros ids
    const n = parseInt(saved[id], 10);
    const def = PEND_COL_DEFS.find(c => id.endsWith('-' + c.rz));
    const min = def ? (parseInt(def.min, 10) || 40) : 40;
    const fallback = def ? (parseInt(def.w, 10) || 80) : 80;
    if (!n || n < min || n > 1200) {
      saved[id] = fallback + 'px';
      changed = true;
    }
  });
  if (changed) {
    try { localStorage.setItem('fluxolabPendSizes', JSON.stringify(saved)); } catch (e) {}
  }
  return saved;
}

function pendSetSavedSize(id, wPx) {
  const saved = pendGetSavedSizes();
  saved[id] = wPx;
  try { localStorage.setItem('fluxolabPendSizes', JSON.stringify(saved)); } catch (e) {}
}

function pendApplyColWidth(resizerId, wPx) {
  const colEl = Array.from(document.querySelectorAll('col[data-rz]')).find(c => c.getAttribute('data-rz') === resizerId);
  if (colEl) colEl.style.width = wPx;
  const th = document.querySelector(`th[data-rz="${resizerId}"]`);
  if (th) {
    th.style.width = wPx;
    th.style.minWidth = wPx;
    th.style.maxWidth = wPx;
  }
  const label = document.getElementById(resizerId);
  if (label) label.style.width = '100%';
  const tbl = (colEl && colEl.closest('table')) || (th && th.closest('table'));
  if (tbl) {
    let total = 0;
    tbl.querySelectorAll('colgroup col').forEach(c => {
      if (c.style.display === 'none') return;
      const cw = parseInt(c.style.width, 10);
      if (cw) total += cw;
    });
    if (total) tbl.style.width = total + 'px';
  }
}

function pendColDragStart(e, resizerId, minPx) {
  e.preventDefault();
  e.stopPropagation();
  const colEl = Array.from(document.querySelectorAll('col[data-rz]')).find(c => c.getAttribute('data-rz') === resizerId);
  const startW = (colEl && parseInt(colEl.style.width, 10)) || minPx || 40;
  _pendColDrag = {
    id: resizerId,
    startX: e.clientX,
    startW,
    minW: minPx || 40,
  };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
}

function pendColDragMove(e) {
  if (!_pendColDrag) return;
  const dx = e.clientX - _pendColDrag.startX;
  const w = Math.max(_pendColDrag.minW, Math.min(1200, Math.round(_pendColDrag.startW + dx)));
  pendApplyColWidth(_pendColDrag.id, w + 'px');
}

function pendColDragEnd() {
  if (!_pendColDrag) return;
  const colEl = Array.from(document.querySelectorAll('col[data-rz]')).find(c => c.getAttribute('data-rz') === _pendColDrag.id);
  const w = (colEl && parseInt(colEl.style.width, 10)) || _pendColDrag.startW;
  pendSetSavedSize(_pendColDrag.id, w + 'px');
  _pendColDrag = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  if (_pendRenderQueued) {
    _pendRenderQueued = false;
    fluxolabRenderPendencias();
  }
}

if (typeof window !== 'undefined' && !window._pendColDragBound) {
  window._pendColDragBound = true;
  window.addEventListener('mousemove', pendColDragMove);
  window.addEventListener('mouseup', pendColDragEnd);
  window.addEventListener('blur', pendColDragEnd);
}

/** Só textareas (altura). Colunas usam alça dedicada. */
function pendInitResizeObserver() {
  if (_pendResizeObserver) _pendResizeObserver.disconnect();
  _pendResizeObserver = new ResizeObserver(entries => {
    let savedSizes = null;
    let changed = false;
    for (const entry of entries) {
      if (!entry.target.id) continue;
      if (!entry.target.classList.contains('pend-textarea')) continue;
      if (!savedSizes) {
        try { savedSizes = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}'); } catch (e) { savedSizes = {}; }
      }
      const h = Math.round(entry.contentRect.height || entry.target.offsetHeight || 0);
      if (h > 0) {
        savedSizes[entry.target.id] = h + 'px';
        changed = true;
      }
    }
    if (changed && savedSizes) {
      try { localStorage.setItem('fluxolabPendSizes', JSON.stringify(savedSizes)); } catch (e) {}
    }
  });
  document.querySelectorAll('.pend-textarea').forEach(el => _pendResizeObserver.observe(el));
}

function pendResetColWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}');
    Object.keys(saved).forEach(k => {
      if (/^ph-pnd-/.test(k)) delete saved[k];
    });
    localStorage.setItem('fluxolabPendSizes', JSON.stringify(saved));
    localStorage.setItem('fluxolabPendSizesVer', String(PEND_SIZES_VER));
  } catch (e) {
    try { localStorage.removeItem('fluxolabPendSizes'); } catch (e2) {}
  }
  fluxolabRenderPendencias();
}

// Badge visual ao lado do modelo: indica se existe checklist importado para ele
function pendBadgeHtml(count, filled) {
  if (!filled) return '';
  if (count > 0) {
    return `<span style="background:rgba(74,222,128,0.15);color:#4ade80;font-size:9px;font-weight:800;padding:3px 7px;border-radius:10px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em">✓ CHECKLIST</span>`;
  }
  return `<span style="background:rgba(248,113,113,0.15);color:#f87171;font-size:9px;font-weight:800;padding:3px 7px;border-radius:10px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em">✗ SEM CHECKLIST</span>`;
}

// Monta os "pills" da coluna Bolsão: em qual(is) bolsão(ões) específico(s)
// (Complexa, Linha 3, Doca 1 etc.) o modelo está fisicamente agora.
function pendBolsaoLocaisHtml(modeloName) {
  if (typeof fluxolabPlanGetBolsaoLocais !== 'function') return '<span style="color:var(--muted)">-</span>';
  const locais = fluxolabPlanGetBolsaoLocais(modeloName);
  if (!locais.length) return '<span style="color:var(--muted)">-</span>';
  return locais.map(l =>
    `<span style="display:inline-block;background:${l.color}18;color:${l.color};border:1px solid ${l.color}40;font-size:13px;font-weight:800;padding:3px 9px;border-radius:8px;white-space:nowrap;margin:2px">${esc(l.label)}${l.count > 1 ? ` (${l.count})` : ''}</span>`
  ).join(' ');
}

// Badge visual ao lado do modelo: mostra o(s) operador(es) que estão AGORA
// com aquele modelo em andamento (rodando = verde) ou pausado (amarelo).
// Lê o estado global (users/wstate/getEquipName) já usado pelo resto do app.
// Chamada: (1) após render/re-render das tabelas, (2) sempre que o campo
// modelo é editado localmente, (3) a partir de updateSummary() em app.js —
// que já é disparado em todo start/pause/resume/finish, local ou remoto.
function updateActiveUsersInTables() {
  if (typeof users === 'undefined' || typeof wstate === 'undefined' || typeof getEquipName !== 'function') return;

  const badges = document.querySelectorAll('.active-users-badge[data-modelo]');
  if (!badges.length) return;

  // Agrupa operadores ativos por modelo (normalizado em maiúsculas), uma única
  // varredura de users/wstate para todas as linhas visíveis.
  const porModelo = {};
  users.forEach(u => {
    if (!u || u.hidden) return;
    const s = wstate[u.id];
    if (!s || (s.status !== 'running' && s.status !== 'paused')) return;
    const modelo = s.selb ? getEquipName(s.selb) : '';
    if (!modelo) return;
    const key = modelo.trim().toUpperCase();
    if (!porModelo[key]) porModelo[key] = [];
    porModelo[key].push({ name: u.name || 'Operador', status: s.status });
  });

  badges.forEach(badge => {
    const modeloKey = (badge.dataset.modelo || '').trim().toUpperCase();
    const ops = modeloKey ? porModelo[modeloKey] : null;
    if (!ops || !ops.length) { badge.innerHTML = ''; return; }

    const cor = '#00e5ff'; // azul fluorescente — mesmo tom para running e paused
    badge.innerHTML = ops.map(op => {
      const statusLabel = op.status === 'running' ? 'running' : 'paused';
      const primeiroNome = (op.name || 'Operador').trim().split(' ')[0] || 'Operador';
      return `<span title="${esc(op.name)} (${statusLabel})" style="display:inline-flex;align-items:center;gap:5px;background:${cor}22;border:1px solid ${cor}77;color:${cor};font-size:13px;font-weight:800;padding:3px 9px;border-radius:10px;white-space:nowrap;margin-left:4px;text-shadow:0 0 6px ${cor}90">` +
        `<span style="width:8px;height:8px;border-radius:50%;background:${cor};box-shadow:0 0 6px ${cor},0 0 2px ${cor};flex-shrink:0"></span>${esc(primeiroNome)}</span>`;
    }).join('');
  });
}

// Helpers de cálculo — reaproveita as funções já existentes em planejamento.js
// (fluxolabPlanGetChecklistStats / fluxolabPlanGetBolsaoStats)

function fluxolabRenderPendTable(title, tableName, titleColor, themeColor) {
  const rows = _fluxolabPendenciasState[tableName] || [];
  const savedSizes = pendGetSavedSizes();

  // Totais atuais de DOCA, LAB e Checklists (soma de todas as linhas preenchidas)
  let totalDoca = 0, totalLab = 0;
  rows.forEach(row => {
    if (!row.modelo) return;
    const statsBol = fluxolabPlanGetBolsaoStats(row.modelo);
    totalDoca += statsBol.doca || 0;
    totalLab += statsBol.lab || 0;
  });
  const totalChk = pendTotalChkUnico(rows);

  // ── Colunas visíveis / larguras ──
  const hid = k => (pendIsColHidden(tableName, k) ? ';display:none' : '');
  const colId = c => `ph-pnd-${tableName}-${c.rz}`;
  const colW = c => savedSizes[colId(c)] || c.w;
  const visibleCols = PEND_COL_DEFS.filter(c => !pendIsColHidden(tableName, c.k));
  const totalW = visibleCols.reduce((s, c) => s + (parseInt(colW(c), 10) || 0), 0);

  // table-layout:fixed => a largura definida no cabeçalho MANDA na coluna
  // (o conteúdo do Bolsão quebra a linha em vez de esticar a tabela).
  const tableStyle = `width:${totalW}px;table-layout:fixed;border-collapse:separate;border-spacing:0;font-family:var(--font);font-size:14px;text-align:center;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.2);border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3)`;
  const thStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4);overflow:visible';
  const tdStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;vertical-align:middle;overflow:hidden';
  const tdLastStyle = tdStyle;

  const resizableHeader = (content, id, defWidth, minWidth, color) => {
    const minPx = parseInt(minWidth, 10) || 40;
    return `<div style="position:relative;width:100%;height:100%;min-height:36px;box-sizing:border-box">
      <div id="${id}" class="pend-header-label" style="padding:12px 10px 12px 6px;color:${color || 'var(--muted)'};font-size:11px;text-transform:uppercase;letter-spacing:0.05em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${content}</div>
      <div class="pend-col-grip" title="Arraste para ajustar largura" onmousedown="pendColDragStart(event,'${id}',${minPx})"
           style="position:absolute;top:0;right:-2px;width:12px;height:100%;cursor:col-resize;z-index:5;background:linear-gradient(90deg,transparent 40%,rgba(255,255,255,.18) 100%)"></div>
    </div>`;
  };

  const activeSortCol = _pendActiveSortCol[tableName] || 'media';
  const mediaSortDir = _pendMediaSortDir[tableName] || null;
  const mediaSortArrow = activeSortCol === 'media' ? (mediaSortDir === 'desc' ? ' ↓' : (mediaSortDir === 'asc' ? ' ↑' : '')) : '';
  const mediaHeaderContent = `<span onclick="fluxolabSortPendByMedia('${tableName}')" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:2px" title="Ordenar por Dias Úteis Andamento (maior → menor)">⏱ Dias Úteis Andamento${mediaSortArrow}</span>`;

  const abertoSortDir = _pendAbertoSortDir[tableName] || null;
  const abertoSortArrow = activeSortCol === 'diasab' ? (abertoSortDir === 'desc' ? ' ↓' : (abertoSortDir === 'asc' ? ' ↑' : '')) : '';
  const abertoHeaderContent = `<span onclick="fluxolabSortPendByDiasAberto('${tableName}')" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:2px" title="Ordenar por Dias em Aberto (maior → menor)">Dias em Aberto${abertoSortArrow}</span>`;

  const docaHeaderContent = `DOCA <span id="pnd-${tableName}-doca-total" style="font-weight:900">(${totalDoca})</span>`;
  const labHeaderContent = `LAB <span id="pnd-${tableName}-lab-total" style="font-weight:900">(${totalLab})</span>`;

  const headerContent = {
    ord: 'Ord', lote: 'Lote', modelo: 'MODELO', chk: 'Checklists',
    media: mediaHeaderContent, diasab: abertoHeaderContent, qtd_wms: 'Qtd WMS', sugestao: 'Sugerido',
    doca: docaHeaderContent, lab: labHeaderContent, bolsao: 'Bolsão',
    obs: 'Observação', pecas: 'Peças',
  };
  const headerColor = { modelo: 'var(--text)', doca: '#22d3ee', lab: '#a78bfa', diasab: '#fbbf24' };

  const colgroupHtml = PEND_COL_DEFS.map(c =>
    `<col data-rz="${colId(c)}" style="width:${colW(c)}${hid(c.k)}">`
  ).join('');

  const theadColsHtml = PEND_COL_DEFS.map(c =>
    `<th data-rz="${colId(c)}" style="${thStyle};width:${colW(c)};min-width:${colW(c)};max-width:${colW(c)};position:relative${hid(c.k)}">${resizableHeader(headerContent[c.k], colId(c), c.w, c.min, headerColor[c.k])}</th>`
  ).join('');

  // Menu "Colunas" — permite ocultar/exibir qualquer coluna
  const colMenuDropdownHtml = `
    <div id="pnd-${tableName}-colmenu" style="display:${_pendColMenuOpen[tableName] ? 'block' : 'none'};position:absolute;right:0;top:30px;z-index:50;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,0.55);padding:8px;min-width:190px;text-align:left">
      ${PEND_COL_DEFS.map(c => `
        <label style="display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;color:var(--text)">
          <input type="checkbox" ${pendIsColHidden(tableName, c.k) ? '' : 'checked'} onchange="pendToggleCol('${tableName}','${c.k}')" style="width:14px;height:14px;accent-color:var(--accent);cursor:pointer" />
          <span>${c.label}</span>
        </label>`).join('')}
      <button onclick="pendShowAllCols('${tableName}')" style="width:100%;margin-top:6px;background:var(--bg3);color:var(--muted);border:1px solid var(--border2);border-radius:6px;padding:5px;font-size:10px;font-weight:800;cursor:pointer;text-transform:uppercase">Mostrar todas</button>
    </div>`;

  const displayList = pendBuildDisplayRows(tableName, rows);
  const listaDetalhada = pendIsListaDetalhada(tableName);
  const regCount = displayList.filter(d => d.row.modelo).length;

  let html = `
    <div style="margin-bottom:32px;overflow-x:auto;padding-bottom:14px">
      <table style="${tableStyle}">
        <colgroup>${colgroupHtml}</colgroup>
        <thead>
          <tr>
            <th colspan="${PEND_COL_DEFS.length}" style="background:rgba(255,255,255,0.03);color:${titleColor};padding:14px;font-size:14px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid var(--border2);text-shadow:0 0 12px ${titleColor}50;position:relative;overflow:visible">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${titleColor};margin-right:8px;box-shadow:0 0 8px ${titleColor}"></span>
              ${title}
              <span style="font-size:10px;color:var(--muted);font-weight:700;margin-left:8px;text-transform:none;letter-spacing:normal">(${regCount} ${listaDetalhada ? 'linhas' : 'registros'})</span>
              <span id="pnd-${tableName}-chk-total" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);background:rgba(74,222,128,0.12);color:#4ade80;border:1px solid rgba(74,222,128,0.35);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:none;text-shadow:none">Total Checklists: ${totalChk}</span>
              <label style="position:absolute;right:168px;top:10px;z-index:55;display:inline-flex;align-items:center;gap:6px;background:var(--bg3);border:1px solid ${listaDetalhada ? 'rgba(79,142,247,.5)' : 'var(--border2)'};border-radius:6px;padding:4px 10px;font-size:10px;font-weight:800;color:${listaDetalhada ? 'var(--accent)' : 'var(--muted)'};cursor:pointer;text-transform:uppercase;letter-spacing:0.04em;user-select:none">
                <input type="checkbox" ${listaDetalhada ? 'checked' : ''} onchange="pendToggleListaDetalhada('${tableName}', this.checked)" style="width:13px;height:13px;accent-color:var(--accent);cursor:pointer" />
                Ver lista detalhada
              </label>
              <span style="position:absolute;right:82px;top:10px;z-index:55">
                <button onclick="pendToggleColMenu('${tableName}')" style="background:var(--bg3);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:4px 10px;font-size:10px;font-weight:800;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em">⚙ Colunas</button>
                ${colMenuDropdownHtml}
              </span>
              <button onclick="fluxolabClearPendTable('${tableName}')" style="position:absolute;right:14px;top:10px;background:var(--danger);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:800;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em">Limpar</button>
            </th>
          </tr>
          <tr>
            ${theadColsHtml}
          </tr>
        </thead>
        <tbody>
  `;


  displayList.forEach((disp, dispIdx) => {
    const row = disp.row;
    const idx = disp.stateIdx;
    const statsChk = disp.stats || (row.modelo ? fluxolabPlanGetChecklistStats(row.modelo) : { count: 0, media: 0 });
    const statsBol = row.modelo ? fluxolabPlanGetBolsaoStats(row.modelo) : { doca: 0, lab: 0 };
    const urgQtd = (row.modelo && typeof _fluxolabModeloUrgenteQtd === 'function') ? _fluxolabModeloUrgenteQtd(row.modelo) : 0;
    const urgBadgeHtml = (urgQtd && typeof _fluxolabUrgBadge === 'function') ? _fluxolabUrgBadge(urgQtd) : '';

    const isVirtual = !!disp.virtual;
    const isDetailed = listaDetalhada && disp.chkIdx != null;
    const rowBg = dispIdx % 2 === 0 ? (urgQtd ? 'rgba(239,68,68,0.07)' : 'rgba(255,255,255,0.015)') : (urgQtd ? 'rgba(239,68,68,0.04)' : 'transparent');
    const isFilled = !!row.modelo;
    const canExpand = !listaDetalhada && isFilled && statsChk.count > 1;
    const isExpanded = canExpand && (_pendExpandedRows[tableName] || new Set()).has(idx);
    const visibleColCount = PEND_COL_DEFS.filter(c => !pendIsColHidden(tableName, c.k)).length;

    const inpBase = 'width:100%;height:100%;min-height:36px;border:none;background:transparent;text-align:center;font-weight:800;outline:none;font-family:var(--font);font-size:18px;color:var(--text);transition:all .2s;display:block';
    const inpFocus = 'this.style.background="rgba(255,255,255,0.05)"';
    const inpBlur = 'this.style.background="transparent"';
    const dragHandle = isVirtual ? '' : 'cursor:grab;';

    const idObs = `pnda-${tableName}-r${idx}-obs`;
    const hObs = savedSizes[idObs] || '36px';
    const idPecas = `pnda-${tableName}-r${idx}-pecas`;
    const hPecas = savedSizes[idPecas] || '36px';
    const rowBorderLeft = urgQtd ? 'border-left:3px solid rgba(239,68,68,0.8);' : '';
    const virtualBg = isVirtual ? 'opacity:.78;' : '';

    const chkHtml = !isFilled ? '' : (
      isDetailed ? `<span style="font-size:11px;font-weight:800;color:var(--muted)">${disp.chkSeq}/${statsChk.count}</span>` :
      pendChkCellHtml(statsChk, tableName, idx, true)
    );
    const mediaHtml = !isFilled ? '' : (
      isDetailed ? pendDiasUteisItemHtml(disp.itemStats) : pendDiasUteisHtml(statsChk)
    );
    const diasAbHtml = !isFilled ? '' : (
      isDetailed ? pendDiasAbertoItemHtml(disp.itemStats) : pendDiasAbertoHtml(statsChk)
    );

    const modeloCell = isVirtual
      ? `<div style="padding:0 8px 0 12px;text-align:left;font-weight:800;font-size:14px;color:${themeColor};opacity:.88">
           ${esc(row.modelo)}
           <span style="font-size:10px;color:var(--muted);margin-left:6px;font-weight:700">· checklist ${disp.chkSeq}/${statsChk.count}</span>
         </div>`
      : `<div style="display:flex;align-items:center;gap:6px;height:100%;padding:0 8px 0 12px">
           <input id="pnd-${tableName}-r${idx}-modelo" type="text" list="modelos-lista" placeholder="Digite..." value="${row.modelo || ''}"
                  onfocus="${inpFocus}" onblur="${inpBlur}"
                  onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'modelo')"
                  style="flex:1;min-width:0;height:100%;min-height:36px;border:none;background:transparent;text-align:left;font-weight:800;outline:none;font-family:var(--font);font-size:15px;color:${themeColor};transition:all .2s;padding:0" />
           <span id="pnd-${tableName}-r${idx}-badge" style="display:flex;align-items:center;gap:4px">${pendBadgeHtml(statsChk.count, isFilled)}${urgBadgeHtml}</span>
           <span class="active-users-badge" id="pnd-${tableName}-r${idx}-active-users" data-modelo="${row.modelo || ''}" style="display:flex;align-items:center"></span>
         </div>`;

    const editFields = isVirtual
      ? `<td style="${tdStyle};color:var(--muted);font-size:14px${hid('qtd_wms')}">—</td>
         <td style="${tdStyle};color:var(--muted);font-size:14px${hid('sugestao')}">—</td>`
      : `<td style="${tdStyle};background:rgba(255,255,255,0.02)${hid('qtd_wms')}">
           <input id="pnd-${tableName}-r${idx}-qtd_wms" type="text" value="${row.qtd_wms || ''}"
                  onfocus="${inpFocus}" onblur="${inpBlur}"
                  onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'qtd_wms')"
                  style="${inpBase};min-width:0;box-sizing:border-box" />
         </td>
         <td style="${tdStyle};background:rgba(255,255,255,0.02)${hid('sugestao')}">
           <input id="pnd-${tableName}-r${idx}-sugestao" type="text" value="${row.sugestao || ''}"
                  onfocus="${inpFocus}" onblur="${inpBlur}"
                  onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'sugestao')"
                  style="${inpBase};min-width:0;box-sizing:border-box;color:var(--accent)" />
         </td>`;

    const obsPecas = isVirtual
      ? `<td style="${tdStyle};color:var(--muted);font-size:14px${hid('obs')}">—</td>
         <td style="${tdLastStyle};color:var(--muted);font-size:14px${hid('pecas')}">—</td>`
      : `<td style="${tdStyle};padding:4px${hid('obs')}">
           <textarea id="pnd-${tableName}-r${idx}-obs" class="pend-textarea" rows="1" placeholder="..."
                  onfocus="${inpFocus}" onblur="${inpBlur}"
                  onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'obs')"
                  style="${inpBase};height:${hObs};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical;max-width:100%">${esc(row.obs || '')}</textarea>
         </td>
         <td style="${tdLastStyle};padding:4px${hid('pecas')}">
           <textarea id="pnd-${tableName}-r${idx}-pecas" class="pend-textarea" rows="1" placeholder="..."
                  onfocus="${inpFocus}" onblur="${inpBlur}"
                  onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'pecas')"
                  style="${inpBase};height:${hPecas};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical;max-width:100%">${esc(row.pecas || '')}</textarea>
         </td>`;

    const dragAttrs = isVirtual ? '' : `
          ondragstart="pendDragStartTr(event, '${tableName}')"
          ondragover="pendDragOver(event)"
          ondragleave="pendDragLeave(event)"
          ondrop="pendDropTr(event, '${tableName}')"
          ondragend="pendDragEnd(event)"`;

    const dragTd = isVirtual ? '' : `
            onmousedown="this.parentNode.setAttribute('draggable','true')"
            onmouseup="this.parentNode.setAttribute('draggable','false')"
            onmouseleave="this.parentNode.setAttribute('draggable','false')"`;

    html += `
      <tr data-pnd-idx="${idx}" data-pnd-virtual="${isVirtual ? '1' : '0'}"
          style="background:${rowBg};transition:background .2s;${rowBorderLeft}${virtualBg}"
          ${dragAttrs}
          onmouseover="this.style.background='rgba(255,255,255,0.04)'"
          onmouseout="this.style.background='${rowBg}'">

        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px;${dragHandle}${hid('ord')}"
            title="${isVirtual ? '' : 'Arraste para reordenar'}"${dragTd}>
          ${isVirtual ? '' : '<span style="opacity:0.4;margin-right:4px">≡</span>'}${dispIdx + 1}º
        </td>
        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px${hid('lote')}">${dispIdx + 1}</td>

        <td style="${tdStyle}${hid('modelo')}">${modeloCell}</td>

        <td id="pnd-${tableName}-r${idx}-chk" class="chk-cell" style="${tdStyle};color:${!isFilled ? 'var(--muted)' : (statsChk.count > 0 ? '#4ade80' : '#f87171')};font-weight:900;font-size:18px${hid('chk')}">
          ${chkHtml}
        </td>
        <td id="pnd-${tableName}-r${idx}-media" class="media-cell" title="${isDetailed ? 'Dias Úteis Andamento deste checklist' : 'Maior valor de Dias Úteis Andamento entre os checklists deste modelo'}" style="${tdStyle};font-weight:900;font-size:18px${hid('media')}">
          ${mediaHtml}
        </td>

        <td id="pnd-${tableName}-r${idx}-diasab" class="diasab-cell" title="${isDetailed ? 'Dias em Aberto deste checklist' : 'Maior tempo em aberto entre os checklists deste modelo'}" style="${tdStyle};font-weight:900;font-size:18px${hid('diasab')}">
          ${diasAbHtml}
        </td>

        ${editFields}

        <td id="pnd-${tableName}-r${idx}-doca" class="doca-cell" style="${tdStyle};background:rgba(34,211,238,0.05);color:#22d3ee;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(34,211,238,0.4)${hid('doca')}">
          ${isFilled && !isVirtual ? (statsBol.doca || '-') : (isFilled && isVirtual ? '—' : '')}
        </td>
        <td id="pnd-${tableName}-r${idx}-lab" class="lab-cell" style="${tdStyle};background:rgba(167,139,250,0.05);color:#a78bfa;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(167,139,250,0.4)${hid('lab')}">
          ${isFilled && !isVirtual ? (statsBol.lab || '-') : (isFilled && isVirtual ? '—' : '')}
        </td>

        <td id="pnd-${tableName}-r${idx}-bolsao" class="bolsao-cell" style="${tdStyle};padding:4px 6px;white-space:normal;word-break:break-word${hid('bolsao')}">
          ${isFilled && !isVirtual ? pendBolsaoLocaisHtml(row.modelo) : ''}
        </td>

        ${obsPecas}

      </tr>
    `;

    if (canExpand) {
      html += `
      <tr id="pnd-${tableName}-det-${idx}" style="display:${isExpanded ? '' : 'none'}">
        <td colspan="${visibleColCount}" style="padding:0;border-bottom:1px solid var(--border2)">
          ${pendRenderChecklistDetalhes(statsChk)}
        </td>
      </tr>`;
    }
  });

  html += `
        </tbody>
      </table>
    </div>
  `;
  return html;
}

function fluxolabRenderPendencias() {
  if (_pendColDrag) {
    _pendRenderQueued = true;
    return;
  }
  const panel = document.getElementById('fluxolab-tab-pendencias-panel');
  if (!panel) return;

  // Reaproveita a mesma datalist de modelos usada no Planejamento do Dia,
  // recriando aqui para o caso desta aba ser renderizada primeiro.
  let modelosUnicos = Array.from(new Set(Object.values(typeof equipamentos !== 'undefined' ? equipamentos : {}).filter(Boolean)));
  modelosUnicos.sort((a,b) => a.localeCompare(b));

  let dataListHtml = '<datalist id="modelos-lista">';
  modelosUnicos.forEach(m => dataListHtml += `<option value="${m}">`);
  dataListHtml += '</datalist>';

  let html = dataListHtml;

  html += `
    <div style="margin-bottom:24px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="background:var(--bg3);padding:10px;border-radius:12px;border:1px solid var(--border2);display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 2px 10px rgba(0,0,0,0.3)">
          <span style="font-size:24px;line-height:1">🧩</span>
        </div>
        <div>
          <h2 style="font-size:22px;font-weight:900;color:var(--text);margin:0;letter-spacing:-0.02em">Pendências Mistas & Complexas <span style="font-size:10px;background:#4ade8022;color:#4ade80;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase">Online</span></h2>
          <p style="font-size:13px;color:var(--muted);margin:4px 0 0">Modo Multiplayer: Qualquer alteração feita por você ou por outros usuários atualiza a tela em tempo real sem conflitos. Arraste a borda direita do cabeçalho para ajustar largura.</p>
        </div>
      </div>
      <button type="button" onclick="pendResetColWidths()" style="background:var(--bg3);color:var(--muted);border:1px solid var(--border2);border-radius:8px;padding:8px 12px;font-size:11px;font-weight:800;cursor:pointer;font-family:var(--font)">↺ Restaurar larguras</button>
    </div>
  `;

  html += fluxolabRenderPendTable('PENDÊNCIAS MISTAS', 'mistas', '#fbbf24', '#fbbf24');
  html += fluxolabRenderPendTable('COMPLEXAS', 'complexas', '#f472b6', '#f472b6');

  panel.innerHTML = html;
  pendInitResizeObserver();
  if (typeof updateActiveUsersInTables === 'function') updateActiveUsersInTables();
}

setTimeout(fluxolabLoadPendencias, 1500);
