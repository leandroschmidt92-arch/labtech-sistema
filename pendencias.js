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

// Mínimo de linhas: a tabela agora cresce e ENCOLHE conforme os registros.
const PEND_ROW_MIN = { mistas: 1, complexas: 1 };
const PEND_FIELDS = ['modelo', 'qtd_wms', 'sugestao', 'obs', 'pecas'];

// ─── Definição das colunas (largura, largura mínima e possibilidade de ocultar) ───
const PEND_COL_DEFS = [
  { k: 'ord',      label: 'Ord',        rz: 'ord',    w: '50px',  min: '40px' },
  { k: 'lote',     label: 'Lote',       rz: 'lote',   w: '50px',  min: '40px' },
  { k: 'modelo',   label: 'Modelo',     rz: 'mod',    w: '340px', min: '120px' },
  { k: 'chk',      label: 'Checklists', rz: 'chk-v2', w: '60px',  min: '50px' },
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
    } catch(e) { console.error('Erro ao carregar pendências:', e); }

    // Configura o sincronismo em tempo real (Multiplayer)
    if (!_pendSyncChannel) {
      _pendSyncChannel = _supa.channel('pendencias_sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fluxolab_state', filter: "key=eq.pendencias_mistas_complexas" }, payload => {
          if (payload.new && payload.new.data) {
            fluxolabApplyRemoteSyncPend(payload.new.data);
          }
        }).subscribe();
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

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'pendencias') {
    fluxolabRenderPendencias();
  }
}

// Salva o estado no Supabase
// OTIMIZAÇÃO: debounce de 5s + dedupe por snapshot + guarda contra concorrência.
let _fluxolabPendSaveTimer;
let _fluxolabPendLastSavedJSON = null;
let _fluxolabPendSaving = false;
function fluxolabSavePendenciasDebounced() {
  if (!_fluxolabPendLoaded) return;
  clearTimeout(_fluxolabPendSaveTimer);
  _fluxolabPendSaveTimer = setTimeout(async () => {
    if (typeof _supa === 'undefined') return;
    if (_fluxolabPendSaving) {
      _fluxolabPendSaveTimer = setTimeout(fluxolabSavePendenciasDebounced, 1000);
      return;
    }
    let snap;
    try { snap = JSON.stringify(_fluxolabPendenciasState); } catch(e){ snap = null; }
    if (snap && snap === _fluxolabPendLastSavedJSON) return;
    _fluxolabPendSaving = true;
    try {
      const { error } = await _supa.from('fluxolab_state').upsert(
        { key: 'pendencias_mistas_complexas', data: _fluxolabPendenciasState },
        { onConflict: 'key' }
      );
      if (!error) _fluxolabPendLastSavedJSON = snap;
    } catch(e) { console.warn('[pend] save falhou:', e); }
    finally { _fluxolabPendSaving = false; }
  }, 5000);
}

// Aplica as atualizações que vieram de outros usuários (Tempo Real)
function fluxolabApplyRemoteSyncPend(remoteData) {
  if (!_fluxolabPendLoaded) return;
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
            const statsChk = val ? fluxolabPlanGetChecklistStats(val) : { count: 0, media: 0 };
            const statsBol = val ? fluxolabPlanGetBolsaoStats(val) : { doca: 0, lab: 0 };

            const cellChk = document.getElementById(`pnd-${t}-r${i}-chk`);
            const cellDoca = document.getElementById(`pnd-${t}-r${i}-doca`);
            const cellLab = document.getElementById(`pnd-${t}-r${i}-lab`);
            const cellBolsao = document.getElementById(`pnd-${t}-r${i}-bolsao`);
            const cellBadge = document.getElementById(`pnd-${t}-r${i}-badge`);

            if (cellChk) { cellChk.innerText = val ? (statsChk.count || '-') : ''; cellChk.style.color = !val ? 'var(--muted)' : (statsChk.count > 0 ? '#4ade80' : '#f87171'); }
            const cellAberto = document.getElementById(`pnd-${t}-r${i}-diasab`);
            if (cellAberto) { cellAberto.innerHTML = val ? pendDiasAbertoHtml(statsChk) : ''; cellAberto.style.color = statsChk.maxAberto > 0 ? '#fbbf24' : 'var(--muted)'; }
            if (cellDoca) cellDoca.innerText = val ? (statsBol.doca || '-') : '';
            if (cellLab) cellLab.innerText = val ? (statsBol.lab || '-') : '';
            if (cellBolsao) cellBolsao.innerHTML = val ? pendBolsaoLocaisHtml(val) : '';
            if (cellBadge) cellBadge.innerHTML = pendBadgeHtml(statsChk.count, !!val);
            const activeBadge = document.getElementById(`pnd-${t}-r${i}-active-users`);
            if (activeBadge) activeBadge.dataset.modelo = val || '';
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
}

// Recalcula e atualiza os totais de DOCA/LAB/Checklists exibidos no cabeçalho da tabela
function pendUpdateHeaderTotals(tableName) {
  const rows = _fluxolabPendenciasState[tableName] || [];
  let totalDoca = 0, totalLab = 0, totalChk = 0;
  rows.forEach(row => {
    if (!row.modelo) return;
    const statsBol = fluxolabPlanGetBolsaoStats(row.modelo);
    totalDoca += statsBol.doca || 0;
    totalLab += statsBol.lab || 0;
    totalChk += (fluxolabPlanGetChecklistStats(row.modelo).count || 0);
  });
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
  if (!tr) return;
  const tbody = tr.parentNode;
  const index = Array.from(tbody.children).indexOf(tr);

  if (!_fluxolabPendenciasState[tableName]) return;
  if (!_fluxolabPendenciasState[tableName][index]) return;

  const value = elem.value;
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
    const statsChk = value ? fluxolabPlanGetChecklistStats(value) : { count: 0, media: 0 };
    const statsBol = value ? fluxolabPlanGetBolsaoStats(value) : { doca: 0, lab: 0 };

    const cellChk = document.getElementById(`pnd-${tableName}-r${index}-chk`);
    const cellDoca = document.getElementById(`pnd-${tableName}-r${index}-doca`);
    const cellLab = document.getElementById(`pnd-${tableName}-r${index}-lab`);
    const cellBolsao = document.getElementById(`pnd-${tableName}-r${index}-bolsao`);
    const cellBadge = document.getElementById(`pnd-${tableName}-r${index}-badge`);
    const activeBadge = document.getElementById(`pnd-${tableName}-r${index}-active-users`);

    if (cellChk) { cellChk.innerText = value ? (statsChk.count || '-') : ''; cellChk.style.color = !value ? 'var(--muted)' : (statsChk.count > 0 ? '#4ade80' : '#f87171'); }
    const cellAberto = document.getElementById(`pnd-${tableName}-r${index}-diasab`);
    if (cellAberto) { cellAberto.innerHTML = value ? pendDiasAbertoHtml(statsChk) : ''; cellAberto.style.color = statsChk.maxAberto > 0 ? '#fbbf24' : 'var(--muted)'; }
    if (cellDoca) cellDoca.innerText = value ? (statsBol.doca || '-') : '';
    if (cellLab) cellLab.innerText = value ? (statsBol.lab || '-') : '';
    if (cellBolsao) cellBolsao.innerHTML = value ? pendBolsaoLocaisHtml(value) : '';
    if (cellBadge) cellBadge.innerHTML = pendBadgeHtml(statsChk.count, !!value);
    if (activeBadge) activeBadge.dataset.modelo = value || '';
    pendUpdateHeaderTotals(tableName);
    if (typeof updateActiveUsersInTables === 'function') updateActiveUsersInTables();
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

// Texto/HTML da célula "Dias em Aberto" (maior valor entre os checklists do modelo)
function pendDiasAbertoHtml(stats) {
  if (!stats || !stats.count || !stats.maxAberto) return '-';
  return `${stats.maxAberto}`;
}

// Ordena a tabela pela coluna "Dias em Aberto" (clique alterna maior→menor / menor→maior)
function fluxolabSortPendByDiasAberto(tableName) {
  const list = _fluxolabPendenciasState[tableName];
  if (!list || !list.length) return;

  const currentDir = _pendAbertoSortDir[tableName];
  const nextDir = currentDir === 'desc' ? 'asc' : 'desc';
  _pendAbertoSortDir[tableName] = nextDir;

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

  if (_pendDraggedTableName === tableName && _pendDraggedTr && _pendDraggedTr !== dropTr) {
    const tbody = dropTr.parentNode;
    const oldIdx = Array.from(tbody.children).indexOf(_pendDraggedTr);
    let newIdx = Array.from(tbody.children).indexOf(dropTr);

    if (newIdx > oldIdx) dropTr.after(_pendDraggedTr);
    else dropTr.before(_pendDraggedTr);

    // Atualizar HTML visual
    Array.from(tbody.children).forEach((tr, i) => {
      tr.cells[0].innerHTML = `<span style="opacity:0.4;margin-right:4px">≡</span>${i + 1}º`;
      tr.cells[1].innerHTML = `${i + 1}`;

      // Update IDs to match new order so realtime sync targets the correct row
      PEND_FIELDS.forEach(f => {
        const inp = tr.querySelector(`[id$="-${f}"]`);
        if (inp) inp.id = `pnd-${tableName}-r${i}-${f}`;
      });
      ['chk','diasab','doca','lab','badge'].forEach(f => {
        const cell = tr.querySelector(`[id$="-${f}"]`);
        if (cell) cell.id = `pnd-${tableName}-r${i}-${f}`;
      });
    });

    const finalIdx = Array.from(tbody.children).indexOf(_pendDraggedTr);
    const list = _fluxolabPendenciasState[tableName];
    const item = list.splice(oldIdx, 1)[0];
    list.splice(finalIdx, 0, item);

    fluxolabSavePendenciasDebounced();
  }
}
function pendDragEnd(e) {
  e.target.style.opacity = '1';
  e.target.setAttribute('draggable', 'false');
}

// Salvamento de Larguras e Alturas no LocalStorage
let _pendResizeObserver = null;
function pendInitResizeObserver() {
  if (_pendResizeObserver) _pendResizeObserver.disconnect();

  _pendResizeObserver = new ResizeObserver(entries => {
    let savedSizes = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}');
    let changed = false;
    for (let entry of entries) {
      if (entry.target.id) {
        if (entry.target.classList.contains('pend-header-resizer')) {
          savedSizes[entry.target.id] = entry.target.style.width;
          changed = true;
          // Aplica a largura na coluna imediatamente (<col>), sem esperar re-render
          const col = document.querySelector(`col[data-rz="${entry.target.id}"]`);
          if (col && entry.target.style.width) {
            col.style.width = entry.target.style.width;
            const tbl = col.closest('table');
            if (tbl) {
              let total = 0;
              tbl.querySelectorAll('colgroup col').forEach(c => {
                if (c.style.display === 'none') return;
                total += parseInt(c.style.width, 10) || 0;
              });
              if (total) tbl.style.width = total + 'px';
            }
          }
        } else if (entry.target.tagName.toLowerCase() === 'textarea') {
          savedSizes[entry.target.id] = entry.target.style.height;
          changed = true;
        }
      }
    }
    if (changed) localStorage.setItem('fluxolabPendSizes', JSON.stringify(savedSizes));
  });

  document.querySelectorAll('.pend-header-resizer, .pend-textarea').forEach(el => _pendResizeObserver.observe(el));
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
  const savedSizes = JSON.parse(localStorage.getItem('fluxolabPendSizes') || '{}');

  // Totais atuais de DOCA, LAB e Checklists (soma de todas as linhas preenchidas)
  let totalDoca = 0, totalLab = 0, totalChk = 0;
  rows.forEach(row => {
    if (!row.modelo) return;
    const statsBol = fluxolabPlanGetBolsaoStats(row.modelo);
    totalDoca += statsBol.doca || 0;
    totalLab += statsBol.lab || 0;
    totalChk += (fluxolabPlanGetChecklistStats(row.modelo).count || 0);
  });

  // ── Colunas visíveis / larguras ──
  const hid = k => (pendIsColHidden(tableName, k) ? ';display:none' : '');
  const colId = c => `ph-pnd-${tableName}-${c.rz}`;
  const colW = c => savedSizes[colId(c)] || c.w;
  const visibleCols = PEND_COL_DEFS.filter(c => !pendIsColHidden(tableName, c.k));
  const totalW = visibleCols.reduce((s, c) => s + (parseInt(colW(c), 10) || 0), 0);

  // table-layout:fixed => a largura definida no cabeçalho MANDA na coluna
  // (o conteúdo do Bolsão quebra a linha em vez de esticar a tabela).
  const tableStyle = `width:${totalW}px;table-layout:fixed;border-collapse:separate;border-spacing:0;font-family:var(--font);font-size:14px;text-align:center;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.2);border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3)`;
  const thStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4);overflow:hidden';
  const tdStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;vertical-align:middle;overflow:hidden';
  const tdLastStyle = tdStyle;

  const resizableHeader = (content, id, defWidth, minWidth, color) => {
    const savedW = savedSizes[id] || defWidth;
    return `<div id="${id}" class="pend-header-resizer" style="resize:horizontal;overflow:hidden;width:${savedW};min-width:${minWidth};max-width:100%;padding:12px 6px;margin:0 auto;color:${color || 'var(--muted)'};font-size:11px;text-transform:uppercase;letter-spacing:0.05em">${content}</div>`;
  };

  const abertoSortDir = _pendAbertoSortDir[tableName] || null;
  const abertoSortArrow = abertoSortDir === 'desc' ? ' ↓' : (abertoSortDir === 'asc' ? ' ↑' : '');
  const abertoHeaderContent = `<span onclick="fluxolabSortPendByDiasAberto('${tableName}')" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:2px" title="Dias em aberto (coluna Dias Aberto da planilha de checklists). Ordenar maior → menor">Dias em Aberto${abertoSortArrow}</span>`;

  const docaHeaderContent = `DOCA <span id="pnd-${tableName}-doca-total" style="font-weight:900">(${totalDoca})</span>`;
  const labHeaderContent = `LAB <span id="pnd-${tableName}-lab-total" style="font-weight:900">(${totalLab})</span>`;

  const headerContent = {
    ord: 'Ord', lote: 'Lote', modelo: 'MODELO', chk: 'Checklists',
    diasab: abertoHeaderContent, qtd_wms: 'Qtd WMS', sugestao: 'Sugerido',
    doca: docaHeaderContent, lab: labHeaderContent, bolsao: 'Bolsão',
    obs: 'Observação', pecas: 'Peças',
  };
  const headerColor = { modelo: 'var(--text)', doca: '#22d3ee', lab: '#a78bfa', diasab: '#fbbf24' };

  const colgroupHtml = PEND_COL_DEFS.map(c =>
    `<col data-rz="${colId(c)}" style="width:${colW(c)}${hid(c.k)}">`
  ).join('');

  const theadColsHtml = PEND_COL_DEFS.map(c =>
    `<th style="${thStyle}${hid(c.k)}">${resizableHeader(headerContent[c.k], colId(c), c.w, c.min, headerColor[c.k])}</th>`
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

  let html = `
    <div style="margin-bottom:32px;overflow-x:auto;padding-bottom:14px">
      <table style="${tableStyle}">
        <colgroup>${colgroupHtml}</colgroup>
        <thead>
          <tr>
            <th colspan="${PEND_COL_DEFS.length}" style="background:rgba(255,255,255,0.03);color:${titleColor};padding:14px;font-size:14px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid var(--border2);text-shadow:0 0 12px ${titleColor}50;position:relative;overflow:visible">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${titleColor};margin-right:8px;box-shadow:0 0 8px ${titleColor}"></span>
              ${title}
              <span style="font-size:10px;color:var(--muted);font-weight:700;margin-left:8px;text-transform:none;letter-spacing:normal">(${rows.length} registros)</span>
              <span id="pnd-${tableName}-chk-total" style="position:absolute;left:14px;top:50%;transform:translateY(-50%);background:rgba(74,222,128,0.12);color:#4ade80;border:1px solid rgba(74,222,128,0.35);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:none;text-shadow:none">Total Checklists: ${totalChk}</span>
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


  rows.forEach((row, idx) => {
    const statsChk = row.modelo ? fluxolabPlanGetChecklistStats(row.modelo) : { count: 0, media: 0 };
    const statsBol = row.modelo ? fluxolabPlanGetBolsaoStats(row.modelo) : { doca: 0, lab: 0 };

    const rowBg = idx % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent';
    const isFilled = row.modelo ? true : false;

    const inpBase = 'width:100%;height:100%;min-height:36px;border:none;background:transparent;text-align:center;font-weight:800;outline:none;font-family:var(--font);font-size:18px;color:var(--text);transition:all .2s;display:block';
    const inpFocus = 'this.style.background="rgba(255,255,255,0.05)"';
    const inpBlur = 'this.style.background="transparent"';
    const dragHandle = `cursor:grab;`;

    const idObs = `pnda-${tableName}-r${idx}-obs`;
    const hObs = savedSizes[idObs] || '36px';

    const idPecas = `pnda-${tableName}-r${idx}-pecas`;
    const hPecas = savedSizes[idPecas] || '36px';

    html += `
      <tr style="background:${rowBg};transition:background .2s"
          ondragstart="pendDragStartTr(event, '${tableName}')"
          ondragover="pendDragOver(event)"
          ondragleave="pendDragLeave(event)"
          ondrop="pendDropTr(event, '${tableName}')"
          ondragend="pendDragEnd(event)"
          onmouseover="this.style.background='rgba(255,255,255,0.04)'"
          onmouseout="this.style.background='${rowBg}'">

        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px;${dragHandle}${hid('ord')}"
            title="Arraste para reordenar"
            onmousedown="this.parentNode.setAttribute('draggable','true')"
            onmouseup="this.parentNode.setAttribute('draggable','false')"
            onmouseleave="this.parentNode.setAttribute('draggable','false')">
          <span style="opacity:0.4;margin-right:4px">≡</span>${idx + 1}º
        </td>
        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px${hid('lote')}">${idx + 1}</td>

        <td style="${tdStyle}${hid('modelo')}">
          <div style="display:flex;align-items:center;gap:6px;height:100%;padding:0 8px 0 12px">
            <input id="pnd-${tableName}-r${idx}-modelo" type="text" list="modelos-lista" placeholder="Digite..." value="${row.modelo || ''}"
                   onfocus="${inpFocus}" onblur="${inpBlur}"
                   onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'modelo')"
                   style="flex:1;min-width:0;height:100%;min-height:36px;border:none;background:transparent;text-align:left;font-weight:800;outline:none;font-family:var(--font);font-size:15px;color:${themeColor};transition:all .2s;padding:0" />
            <span id="pnd-${tableName}-r${idx}-badge" style="display:flex;align-items:center">${pendBadgeHtml(statsChk.count, isFilled)}</span>
            <span class="active-users-badge" id="pnd-${tableName}-r${idx}-active-users" data-modelo="${row.modelo || ''}" style="display:flex;align-items:center"></span>
          </div>
        </td>

        <td id="pnd-${tableName}-r${idx}-chk" class="chk-cell" style="${tdStyle};color:${!isFilled ? 'var(--muted)' : (statsChk.count > 0 ? '#4ade80' : '#f87171')};font-weight:900;font-size:18px${hid('chk')}">
          ${isFilled ? (statsChk.count || '-') : ''}
        </td>

        <td id="pnd-${tableName}-r${idx}-diasab" class="diasab-cell" title="Maior tempo em aberto entre os checklists deste modelo" style="${tdStyle};color:${statsChk.maxAberto > 0 ? '#fbbf24' : 'var(--muted)'};font-weight:900;font-size:18px${hid('diasab')}">
          ${isFilled ? pendDiasAbertoHtml(statsChk) : ''}
        </td>

        <td style="${tdStyle};background:rgba(255,255,255,0.02)${hid('qtd_wms')}">
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
        </td>

        <td id="pnd-${tableName}-r${idx}-doca" class="doca-cell" style="${tdStyle};background:rgba(34,211,238,0.05);color:#22d3ee;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(34,211,238,0.4)${hid('doca')}">
          ${isFilled ? (statsBol.doca || '-') : ''}
        </td>
        <td id="pnd-${tableName}-r${idx}-lab" class="lab-cell" style="${tdStyle};background:rgba(167,139,250,0.05);color:#a78bfa;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(167,139,250,0.4)${hid('lab')}">
          ${isFilled ? (statsBol.lab || '-') : ''}
        </td>

        <td id="pnd-${tableName}-r${idx}-bolsao" class="bolsao-cell" style="${tdStyle};padding:4px 6px;white-space:normal;word-break:break-word${hid('bolsao')}">
          ${isFilled ? pendBolsaoLocaisHtml(row.modelo) : ''}
        </td>

        <td style="${tdStyle};padding:4px${hid('obs')}">
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
        </td>

      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;
  return html;
}

function fluxolabRenderPendencias() {
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
    <div style="margin-bottom:24px;display:flex;align-items:center;gap:14px">
      <div style="background:var(--bg3);padding:10px;border-radius:12px;border:1px solid var(--border2);display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 2px 10px rgba(0,0,0,0.3)">
        <span style="font-size:24px;line-height:1">🧩</span>
      </div>
      <div>
        <h2 style="font-size:22px;font-weight:900;color:var(--text);margin:0;letter-spacing:-0.02em">Pendências Mistas & Complexas <span style="font-size:10px;background:#4ade8022;color:#4ade80;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase">Online</span></h2>
        <p style="font-size:13px;color:var(--muted);margin:4px 0 0">Modo Multiplayer: Qualquer alteração feita por você ou por outros usuários atualiza a tela em tempo real sem conflitos.</p>
      </div>
    </div>
  `;

  html += fluxolabRenderPendTable('PENDÊNCIAS MISTAS', 'mistas', '#fbbf24', '#fbbf24');
  html += fluxolabRenderPendTable('COMPLEXAS', 'complexas', '#f472b6', '#f472b6');

  panel.innerHTML = html;
  pendInitResizeObserver();
  if (typeof updateActiveUsersInTables === 'function') updateActiveUsersInTables();
}

setTimeout(fluxolabLoadPendencias, 1500);
