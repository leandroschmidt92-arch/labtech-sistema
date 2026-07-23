// ════════════════════════════════════════════════════════════════
// PENDÊNCIAS MISTAS / COMPLEXAS (STATE, DRAG & DROP E MULTIPLAYER REALTIME)
// Mesmo padrão da aba "Planejamento do Dia", em namespace próprio
// para não conflitar com _fluxolabPlanejamentoState.
// ════════════════════════════════════════════════════════════════
let _fluxolabPendenciasState = { mistas: [], complexas: [] };
let _fluxolabPendLoaded = false;
let _pendSyncChannel = null;
let _pendMediaSortDir = { mistas: null, complexas: null }; // null | 'desc' | 'asc'

const PEND_ROW_MIN = { mistas: 30, complexas: 20 };
const PEND_FIELDS = ['modelo', 'qtd_wms', 'sugestao', 'obs', 'pecas'];

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

  // Garantir linhas mínimas (30 Pendências Mistas / 20 Complexas)
  Object.keys(PEND_ROW_MIN).forEach(t => {
    if (!Array.isArray(_fluxolabPendenciasState[t])) _fluxolabPendenciasState[t] = [];
    while (_fluxolabPendenciasState[t].length < PEND_ROW_MIN[t]) {
      _fluxolabPendenciasState[t].push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
  });

  _fluxolabPendLoaded = true;

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'pendencias') {
    fluxolabRenderPendencias();
  }
}

// Salva o estado no Supabase
let _fluxolabPendSaveTimer;
function fluxolabSavePendenciasDebounced() {
  if (!_fluxolabPendLoaded) return;
  clearTimeout(_fluxolabPendSaveTimer);
  _fluxolabPendSaveTimer = setTimeout(async () => {
    if (typeof _supa !== 'undefined') {
      await _supa.from('fluxolab_state').upsert({ key: 'pendencias_mistas_complexas', data: _fluxolabPendenciasState }, { onConflict: 'key' });
    }
  }, 4000);
}

// Aplica as atualizações que vieram de outros usuários (Tempo Real)
function fluxolabApplyRemoteSyncPend(remoteData) {
  if (!_fluxolabPendLoaded) return;

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
            const cellMedia = document.getElementById(`pnd-${t}-r${i}-media`);
            const cellDoca = document.getElementById(`pnd-${t}-r${i}-doca`);
            const cellLab = document.getElementById(`pnd-${t}-r${i}-lab`);
            const cellBadge = document.getElementById(`pnd-${t}-r${i}-badge`);

            if (cellChk) { cellChk.innerText = val ? (statsChk.count || '-') : ''; cellChk.style.color = statsChk.count > 0 ? '#4ade80' : 'var(--muted)'; }
            if (cellMedia) { cellMedia.innerText = val ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
            if (cellDoca) cellDoca.innerText = val ? (statsBol.doca || '-') : '';
            if (cellLab) cellLab.innerText = val ? (statsBol.lab || '-') : '';
            if (cellBadge) cellBadge.innerHTML = pendBadgeHtml(statsChk.count, !!val);
          }
        }
      });
    }
    pendUpdateHeaderTotals(t);
  });
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
  fluxolabSavePendenciasDebounced();

  if (field === 'modelo') {
    const statsChk = value ? fluxolabPlanGetChecklistStats(value) : { count: 0, media: 0 };
    const statsBol = value ? fluxolabPlanGetBolsaoStats(value) : { doca: 0, lab: 0 };

    const cellChk = document.getElementById(`pnd-${tableName}-r${index}-chk`);
    const cellMedia = document.getElementById(`pnd-${tableName}-r${index}-media`);
    const cellDoca = document.getElementById(`pnd-${tableName}-r${index}-doca`);
    const cellLab = document.getElementById(`pnd-${tableName}-r${index}-lab`);
    const cellBadge = document.getElementById(`pnd-${tableName}-r${index}-badge`);

    if (cellChk) { cellChk.innerText = value ? (statsChk.count || '-') : ''; cellChk.style.color = statsChk.count > 0 ? '#4ade80' : 'var(--muted)'; }
    if (cellMedia) { cellMedia.innerText = value ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
    if (cellDoca) cellDoca.innerText = value ? (statsBol.doca || '-') : '';
    if (cellLab) cellLab.innerText = value ? (statsBol.lab || '-') : '';
    if (cellBadge) cellBadge.innerHTML = pendBadgeHtml(statsChk.count, !!value);
    pendUpdateHeaderTotals(tableName);
  }
}

function fluxolabClearPendTable(tableName) {
  const label = tableName === 'mistas' ? 'Pendências Mistas' : 'Complexas';
  if (confirm(`Tem certeza que deseja limpar a lista ${label}? Os ajustes de tamanho da tabela não serão perdidos.`)) {
    const size = _fluxolabPendenciasState[tableName].length;
    _fluxolabPendenciasState[tableName] = [];
    for (let i = 0; i < size; i++) {
      _fluxolabPendenciasState[tableName].push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
    fluxolabSavePendenciasDebounced();
    fluxolabRenderPendencias();
  }
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
      ['chk','media','doca','lab','badge'].forEach(f => {
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

  const tableStyle = 'width:max-content;border-collapse:separate;border-spacing:0;font-family:var(--font);font-size:14px;text-align:center;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.2);border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3)';
  const thStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  const thLastStyle = 'border-bottom:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  const tdStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;vertical-align:middle';
  const tdLastStyle = 'border-bottom:1px solid var(--border2);padding:0;vertical-align:middle';

  const resizableHeader = (content, id, defWidth, minWidth, color) => {
    const savedW = savedSizes[id] || defWidth;
    return `<div id="${id}" class="pend-header-resizer" style="resize:horizontal;overflow:hidden;width:${savedW};min-width:${minWidth};padding:12px 6px;margin:0 auto;color:${color || 'var(--muted)'};font-size:11px;text-transform:uppercase;letter-spacing:0.05em">${content}</div>`;
  };

  const mediaSortDir = _pendMediaSortDir[tableName] || null;
  const mediaSortArrow = mediaSortDir === 'desc' ? ' ↓' : (mediaSortDir === 'asc' ? ' ↑' : '');
  const mediaHeaderContent = `<span onclick="fluxolabSortPendByMedia('${tableName}')" style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:2px" title="Ordenar por Média Dias (maior → menor)">Média Dias${mediaSortArrow}</span>`;

  const docaHeaderContent = `DOCA <span id="pnd-${tableName}-doca-total" style="font-weight:900">(${totalDoca})</span>`;
  const labHeaderContent = `LAB <span id="pnd-${tableName}-lab-total" style="font-weight:900">(${totalLab})</span>`;

  let html = `
    <div style="margin-bottom:32px;overflow-x:auto;padding-bottom:14px">
      <table style="${tableStyle}">
        <thead>
          <tr>
            <th colspan="11" style="background:rgba(255,255,255,0.03);color:${titleColor};padding:14px;font-size:14px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid var(--border2);text-shadow:0 0 12px ${titleColor}50;position:relative">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${titleColor};margin-right:8px;box-shadow:0 0 8px ${titleColor}"></span>
              ${title}
              <span style="font-size:10px;color:var(--muted);font-weight:700;margin-left:8px;text-transform:none;letter-spacing:normal">(${rows.length} registros)</span>
              <span id="pnd-${tableName}-chk-total" style="position:absolute;right:100px;top:50%;transform:translateY(-50%);background:rgba(74,222,128,0.12);color:#4ade80;border:1px solid rgba(74,222,128,0.35);border-radius:6px;padding:5px 12px;font-size:11px;font-weight:800;letter-spacing:0.04em;text-transform:none;text-shadow:none">Total Checklists: ${totalChk}</span>
              <button onclick="fluxolabClearPendTable('${tableName}')" style="position:absolute;right:14px;top:10px;background:var(--danger);color:#fff;border:none;border-radius:6px;padding:4px 10px;font-size:10px;font-weight:800;cursor:pointer;text-transform:uppercase;letter-spacing:0.05em">Limpar</button>
            </th>
          </tr>
          <tr>
            <th style="${thStyle}">${resizableHeader('Ord', `ph-pnd-${tableName}-ord`, '50px', '40px')}</th>
            <th style="${thStyle}">${resizableHeader('Lote', `ph-pnd-${tableName}-lote`, '50px', '40px')}</th>
            <th style="${thStyle}">${resizableHeader('MODELO', `ph-pnd-${tableName}-mod`, '340px', '120px', 'var(--text)')}</th>
            <th style="${thStyle}">${resizableHeader('Checklists', `ph-pnd-${tableName}-chk-v2`, '60px', '50px')}</th>
            <th style="${thStyle}">${resizableHeader(mediaHeaderContent, `ph-pnd-${tableName}-media`, '80px', '60px')}</th>
            <th style="${thStyle};width:72px;min-width:72px;max-width:72px"><div style="padding:12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Qtd WMS</div></th>
            <th style="${thStyle};width:72px;min-width:72px;max-width:72px"><div style="padding:12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Sugerido</div></th>
            <th style="${thStyle}">${resizableHeader(docaHeaderContent, `ph-pnd-${tableName}-doca`, '70px', '60px', '#22d3ee')}</th>
            <th style="${thStyle}">${resizableHeader(labHeaderContent, `ph-pnd-${tableName}-lab`, '70px', '60px', '#a78bfa')}</th>
            <th style="${thStyle}">${resizableHeader('Observação', `ph-pnd-${tableName}-obs`, '180px', '80px')}</th>
            <th style="${thLastStyle}">${resizableHeader('Peças', `ph-pnd-${tableName}-pecas`, '180px', '80px')}</th>
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

        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px;${dragHandle}"
            title="Arraste para reordenar"
            onmousedown="this.parentNode.setAttribute('draggable','true')"
            onmouseup="this.parentNode.setAttribute('draggable','false')"
            onmouseleave="this.parentNode.setAttribute('draggable','false')">
          <span style="opacity:0.4;margin-right:4px">≡</span>${idx + 1}º
        </td>
        <td style="${tdStyle};color:var(--muted);font-weight:800;font-size:15px">${idx + 1}</td>

        <td style="${tdStyle}">
          <div style="display:flex;align-items:center;gap:6px;height:100%;padding:0 8px 0 12px">
            <input id="pnd-${tableName}-r${idx}-modelo" type="text" list="modelos-lista" placeholder="Digite..." value="${row.modelo || ''}"
                   onfocus="${inpFocus}" onblur="${inpBlur}"
                   onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'modelo')"
                   style="flex:1;min-width:0;height:100%;min-height:36px;border:none;background:transparent;text-align:left;font-weight:800;outline:none;font-family:var(--font);font-size:15px;color:${themeColor};transition:all .2s;padding:0" />
            <span id="pnd-${tableName}-r${idx}-badge" style="display:flex;align-items:center">${pendBadgeHtml(statsChk.count, isFilled)}</span>
          </div>
        </td>

        <td id="pnd-${tableName}-r${idx}-chk" class="chk-cell" style="${tdStyle};color:${statsChk.count > 0 ? '#4ade80' : 'var(--muted)'};font-weight:900;font-size:18px">
          ${isFilled ? (statsChk.count || '-') : ''}
        </td>
        <td id="pnd-${tableName}-r${idx}-media" class="media-cell" style="${tdStyle};color:${statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'};font-weight:900;font-size:18px">
          ${isFilled ? (statsChk.media || '-') : ''}
        </td>

        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="pnd-${tableName}-r${idx}-qtd_wms" type="text" value="${row.qtd_wms || ''}"
                 onfocus="${inpFocus}" onblur="${inpBlur}"
                 onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'qtd_wms')"
                 style="${inpBase};min-width:0;box-sizing:border-box" />
        </td>
        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="pnd-${tableName}-r${idx}-sugestao" type="text" value="${row.sugestao || ''}"
                 onfocus="${inpFocus}" onblur="${inpBlur}"
                 onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'sugestao')"
                 style="${inpBase};min-width:0;box-sizing:border-box;color:var(--accent)" />
        </td>

        <td id="pnd-${tableName}-r${idx}-doca" class="doca-cell" style="${tdStyle};background:rgba(34,211,238,0.05);color:#22d3ee;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(34,211,238,0.4)">
          ${isFilled ? (statsBol.doca || '-') : ''}
        </td>
        <td id="pnd-${tableName}-r${idx}-lab" class="lab-cell" style="${tdStyle};background:rgba(167,139,250,0.05);color:#a78bfa;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(167,139,250,0.4)">
          ${isFilled ? (statsBol.lab || '-') : ''}
        </td>

        <td style="${tdStyle};padding:4px">
          <textarea id="pnd-${tableName}-r${idx}-obs" class="pend-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}"
                 onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'obs')"
                 style="${inpBase};height:${hObs};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical">${esc(row.obs || '')}</textarea>
        </td>
        <td style="${tdLastStyle};padding:4px">
          <textarea id="pnd-${tableName}-r${idx}-pecas" class="pend-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}"
                 onchange="fluxolabUpdateRowElemPend(this, '${tableName}', 'pecas')"
                 style="${inpBase};height:${hPecas};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical">${esc(row.pecas || '')}</textarea>
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
}

setTimeout(fluxolabLoadPendencias, 1500);
