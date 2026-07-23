// ════════════════════════════════════════════════════════════════
// PLANEJAMENTO DO DIA (STATE, DRAG & DROP E MULTIPLAYER REALTIME)
// ════════════════════════════════════════════════════════════════
let _fluxolabPlanejamentoState = { tabela1: [], tabela2: [], tabela3: [] };
let _fluxolabPlanLoaded = false;
let _planSyncChannel = null;
let _planMediaSortDir = { tabela1: null, tabela2: null, tabela3: null }; // null | 'desc' | 'asc'

// Carrega o estado do Supabase
async function fluxolabLoadPlanejamento() {
  if (typeof currentUser === 'undefined' || !currentUser) return;
  if (typeof _supa !== 'undefined') {
    try {
      const {data, error} = await _supa.from('fluxolab_state').select('data').eq('key', 'planejamento_lote_dia').maybeSingle();
      if (!error && data && data.data) {
        _fluxolabPlanejamentoState = Object.assign({ tabela1: [], tabela2: [], tabela3: [] }, data.data);
      }
    } catch(e) { console.error('Erro ao carregar planejamento:', e); }
    
    // Configura o sincronismo em tempo real (Multiplayer)
    if (!_planSyncChannel) {
      _planSyncChannel = _supa.channel('planejamento_sync')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'fluxolab_state', filter: "key=eq.planejamento_lote_dia" }, payload => {
          if (payload.new && payload.new.data) {
            fluxolabApplyRemoteSync(payload.new.data);
          }
        }).subscribe();
    }
  }
  
  // Garantir linhas mínimas
  while (_fluxolabPlanejamentoState.tabela1.length < 10) _fluxolabPlanejamentoState.tabela1.push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
  while (_fluxolabPlanejamentoState.tabela2.length < 5)  _fluxolabPlanejamentoState.tabela2.push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
  while (_fluxolabPlanejamentoState.tabela3.length < 10) _fluxolabPlanejamentoState.tabela3.push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
  
  _fluxolabPlanLoaded = true;
  
  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'planejamento') {
    fluxolabRenderPlanejamento();
  }
}

// Salva o estado no Supabase
let _fluxolabPlanSaveTimer;
function fluxolabSavePlanejamentoDebounced() {
  if (!_fluxolabPlanLoaded) return;
  clearTimeout(_fluxolabPlanSaveTimer);
  _fluxolabPlanSaveTimer = setTimeout(async () => {
    if (typeof _supa !== 'undefined') {
      await _supa.from('fluxolab_state').upsert({ key: 'planejamento_lote_dia', data: _fluxolabPlanejamentoState }, { onConflict: 'key' });
    }
  }, 4000);
}

// Aplica as atualizações que vieram de outros usuários (Tempo Real)
function fluxolabApplyRemoteSync(remoteData) {
  if (!_fluxolabPlanLoaded) return;
  
  ['tabela1', 'tabela2', 'tabela3'].forEach(t => {
    if (!remoteData[t]) return;
    
    for (let i = 0; i < remoteData[t].length; i++) {
      if (!_fluxolabPlanejamentoState[t][i]) _fluxolabPlanejamentoState[t][i] = { modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' };
      
      const remoteRow = remoteData[t][i];
      const localRow = _fluxolabPlanejamentoState[t][i];
      
      ['modelo', 'qtd_wms', 'sugestao', 'obs', 'pecas'].forEach(f => {
        const val = remoteRow[f] || '';
        localRow[f] = val; // Atualiza a memória local
        
        // Atualiza a tela discretamente, APENAS se o usuário não estiver digitando neste campo agora
        const inpId = `plan-${t}-r${i}-${f}`;
        const inpElem = document.getElementById(inpId);
        if (inpElem && document.activeElement !== inpElem) {
          inpElem.value = val;
          
          // Se for modelo, precisa recalcular Checklists/Bolsões visualmente
          if (f === 'modelo') {
            const statsChk = val ? fluxolabPlanGetChecklistStats(val) : { count: 0, media: 0 };
            const statsBol = val ? fluxolabPlanGetBolsaoStats(val) : { doca: 0, lab: 0 };
            
            const cellChk = document.getElementById(`plan-${t}-r${i}-chk`);
            const cellMedia = document.getElementById(`plan-${t}-r${i}-media`);
            const cellDoca = document.getElementById(`plan-${t}-r${i}-doca`);
            const cellLab = document.getElementById(`plan-${t}-r${i}-lab`);
            const cellBadge = document.getElementById(`plan-${t}-r${i}-badge`);
            
            if (cellChk) { cellChk.innerText = val ? (statsChk.count || '-') : ''; cellChk.style.color = statsChk.count > 0 ? '#4ade80' : 'var(--muted)'; }
            if (cellMedia) { cellMedia.innerText = val ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
            if (cellDoca) cellDoca.innerText = val ? (statsBol.doca || '-') : '';
            if (cellLab) cellLab.innerText = val ? (statsBol.lab || '-') : '';
            if (cellBadge) cellBadge.innerHTML = planBadgeHtml(statsChk.count, !!val);
          }
        }
      });
    }
    fluxolabUpdateTotalChk(t);
  });
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
  _fluxolabPlanejamentoState[tableName][index][field] = value;
  fluxolabSavePlanejamentoDebounced();
  
  if (field === 'modelo') {
    const statsChk = value ? fluxolabPlanGetChecklistStats(value) : { count: 0, media: 0 };
    const statsBol = value ? fluxolabPlanGetBolsaoStats(value) : { doca: 0, lab: 0 };
    
    const cellChk = document.getElementById(`plan-${tableName}-r${index}-chk`);
    const cellMedia = document.getElementById(`plan-${tableName}-r${index}-media`);
    const cellDoca = document.getElementById(`plan-${tableName}-r${index}-doca`);
    const cellLab = document.getElementById(`plan-${tableName}-r${index}-lab`);
    const cellBadge = document.getElementById(`plan-${tableName}-r${index}-badge`);
    
    if (cellChk) { cellChk.innerText = value ? (statsChk.count || '-') : ''; cellChk.style.color = statsChk.count > 0 ? '#4ade80' : 'var(--muted)'; }
    if (cellMedia) { cellMedia.innerText = value ? (statsChk.media || '-') : ''; cellMedia.style.color = statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'; }
    if (cellDoca) cellDoca.innerText = value ? (statsBol.doca || '-') : '';
    if (cellLab) cellLab.innerText = value ? (statsBol.lab || '-') : '';
    if (cellBadge) cellBadge.innerHTML = planBadgeHtml(statsChk.count, !!value);
    fluxolabUpdateTotalChk(tableName);
  }
}

function fluxolabClearPlanTable(tableName) {
  if (confirm(`Tem certeza que deseja limpar a ${tableName}? Os ajustes de tamanho da tabela não serão perdidos.`)) {
    const size = _fluxolabPlanejamentoState[tableName].length;
    _fluxolabPlanejamentoState[tableName] = [];
    for (let i = 0; i < size; i++) {
      _fluxolabPlanejamentoState[tableName].push({ modelo: '', qtd_wms: '', sugestao: '', obs: '', pecas: '' });
    }
    fluxolabSavePlanejamentoDebounced();
    fluxolabRenderPlanejamento();
  }
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
      ['modelo','qtd_wms','sugestao','obs','pecas'].forEach(f => {
        const inp = tr.querySelector(`[id$="-${f}"]`);
        if (inp) inp.id = `plan-${tableName}-r${i}-${f}`;
      });
      ['chk','media','doca','lab','badge'].forEach(f => {
        const cell = tr.querySelector(`[id$="-${f}"]`);
        if (cell) cell.id = `plan-${tableName}-r${i}-${f}`;
      });
    });
    
    const finalIdx = Array.from(tbody.children).indexOf(_planDraggedTr);
    const list = _fluxolabPlanejamentoState[tableName];
    const item = list.splice(oldIdx, 1)[0];
    list.splice(finalIdx, 0, item);
    
    fluxolabSavePlanejamentoDebounced();
  }
}
function planDragEnd(e) {
  e.target.style.opacity = '1';
  e.target.setAttribute('draggable', 'false');
}

// Salvamento de Larguras e Alturas no LocalStorage
let _planResizeObserver = null;
function planInitResizeObserver() {
  if (_planResizeObserver) _planResizeObserver.disconnect();
  
  _planResizeObserver = new ResizeObserver(entries => {
    let savedSizes = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
    let changed = false;
    for (let entry of entries) {
      if (entry.target.id) {
        if (entry.target.classList.contains('plan-header-resizer')) {
          savedSizes[entry.target.id] = entry.target.style.width;
          changed = true;
        } else if (entry.target.tagName.toLowerCase() === 'textarea') {
          savedSizes[entry.target.id] = entry.target.style.height;
          changed = true;
        }
      }
    }
    if (changed) localStorage.setItem('fluxolabPlanSizes', JSON.stringify(savedSizes));
  });
  
  document.querySelectorAll('.plan-header-resizer, .plan-textarea').forEach(el => _planResizeObserver.observe(el));
}

// Badge visual ao lado do modelo: indica se existe checklist importado para ele
function planBadgeHtml(count, filled) {
  if (!filled) return '';
  if (count > 0) {
    return `<span style="background:rgba(74,222,128,0.15);color:#4ade80;font-size:9px;font-weight:800;padding:3px 7px;border-radius:10px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em">✓ CHECKLIST</span>`;
  }
  return `<span style="background:rgba(248,113,113,0.15);color:#f87171;font-size:9px;font-weight:800;padding:3px 7px;border-radius:10px;white-space:nowrap;flex-shrink:0;letter-spacing:0.03em">✗ SEM CHECKLIST</span>`;
}

// Helpers de cálculo
function fluxolabPlanGetChecklistStats(modeloName) {
  if (!modeloName || typeof _fluxolabChecklistsImported === 'undefined' || !_fluxolabChecklistsImported.length) return { count: 0, media: 0 };
  const sample = _fluxolabChecklistsImported[0];
  const kModelo = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Modelo') || _fluxolabFindKey(sample, 'Equipamento')) : null;
  const kDias = (typeof _fluxolabFindKey === 'function') ? (_fluxolabFindKey(sample, 'Dias Úteis Andamento') || _fluxolabFindKey(sample, 'Dias Uteis Andamento') || _fluxolabFindKey(sample, 'Dias Úteis') || _fluxolabFindKey(sample, 'Dias Uteis')) : null;
  
  if (!kModelo) return { count: 0, media: 0 };
  
  const normAlvo = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modeloName) : modeloName.toUpperCase().replace(/\s+/g,'');
  
  let count = 0;
  let somaDias = 0;
  for (const r of _fluxolabChecklistsImported) {
    const rowM = r[kModelo] || '';
    const rm = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(rowM) : rowM.toUpperCase().replace(/\s+/g,'');
    if (rm === normAlvo) {
      count++;
      if (kDias) {
        let d = parseInt(r[kDias]);
        if (!isNaN(d)) somaDias += d;
      }
    }
  }
  return { count, media: count > 0 ? Math.round(somaDias / count) : 0 };
}

function fluxolabPlanGetBolsaoStats(modeloName) {
  if (!modeloName || typeof _fluxolabData === 'undefined' || !_fluxolabData) return { doca: 0, lab: 0 };
  const normAlvo = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(modeloName) : modeloName.toUpperCase().replace(/\s+/g,'');
  
  let docaCount = 0;
  let labCount = 0;
  
  Object.entries(_fluxolabData).forEach(([bolsao, items]) => {
    if (!items) return;
    Object.values(items).forEach(v => {
      const code = String(v.selb || '').trim();
      let m = (typeof getEquipName === 'function' ? getEquipName(code) : '') || '';
      let normM = (typeof _fluxolabNormModel === 'function') ? _fluxolabNormModel(m) : m.toUpperCase().replace(/\s+/g,'');
      
      if (normM === normAlvo) {
        if (bolsao === 'DOCA_1') {
          docaCount++;
        } else if (bolsao !== 'RETORNO_ESTOQUE') {
          labCount++;
        }
      }
    });
  });
  
  return { doca: docaCount, lab: labCount };
}

// Soma os checklists de todos os modelos preenchidos numa tabela (Ord, Lote, etc. não contam)
function fluxolabCalcTotalChk(tableName) {
  const rows = _fluxolabPlanejamentoState[tableName] || [];
  return rows.reduce((sum, row) => {
    if (!row.modelo) return sum;
    const stats = fluxolabPlanGetChecklistStats(row.modelo);
    return sum + (stats.count || 0);
  }, 0);
}

// Atualiza só o badge do total na tela, sem redesenhar a tabela inteira
function fluxolabUpdateTotalChk(tableName) {
  const el = document.getElementById(`plan-total-chk-${tableName}`);
  if (el) el.innerText = `Total Checklists: ${fluxolabCalcTotalChk(tableName)}`;
}

function fluxolabRenderPlanTable(title, tableName, titleColor, themeColor) {
  const rows = _fluxolabPlanejamentoState[tableName] || [];
  const savedSizes = JSON.parse(localStorage.getItem('fluxolabPlanSizes') || '{}');
  
  const tableStyle = 'width:max-content;border-collapse:separate;border-spacing:0;font-family:var(--font);font-size:14px;text-align:center;border-radius:12px;overflow:hidden;background:rgba(0,0,0,0.2);border:1px solid var(--border2);box-shadow:0 8px 32px rgba(0,0,0,0.3)';
  const thStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  const thLastStyle = 'border-bottom:1px solid var(--border2);padding:0;font-weight:800;vertical-align:middle;background:rgba(0,0,0,0.4)';
  const tdStyle = 'border-bottom:1px solid var(--border2);border-right:1px solid var(--border2);padding:0;vertical-align:middle';
  const tdLastStyle = 'border-bottom:1px solid var(--border2);padding:0;vertical-align:middle';
  
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
            <th colspan="11" style="background:rgba(255,255,255,0.03);color:${titleColor};padding:14px;font-size:14px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid var(--border2);text-shadow:0 0 12px ${titleColor}50;position:relative">
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
            <th style="${thStyle};width:72px;min-width:72px;max-width:72px"><div style="padding:12px 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0.05em">Sugerido</div></th>
            <th style="${thStyle}">${resizableHeader('DOCA', `ph-${tableName}-doca`, '60px', '50px', '#22d3ee')}</th>
            <th style="${thStyle}">${resizableHeader('LAB', `ph-${tableName}-lab`, '60px', '50px', '#a78bfa')}</th>
            <th style="${thStyle}">${resizableHeader('Observação', `ph-${tableName}-obs`, '180px', '80px')}</th>
            <th style="${thLastStyle}">${resizableHeader('Peças', `ph-${tableName}-pecas`, '180px', '80px')}</th>
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
    const dragHandle = `cursor:grab;`
    
    const idObs = `pta-${tableName}-r${idx}-obs`;
    const hObs = savedSizes[idObs] || '36px';
    
    const idPecas = `pta-${tableName}-r${idx}-pecas`;
    const hPecas = savedSizes[idPecas] || '36px';
    
    html += `
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
            <input id="plan-${tableName}-r${idx}-modelo" type="text" list="modelos-lista" placeholder="Digite..." value="${row.modelo || ''}" 
                   onfocus="${inpFocus}" onblur="${inpBlur}" 
                   onchange="fluxolabUpdateRowElem(this, '${tableName}', 'modelo')" 
                   style="flex:1;min-width:0;height:100%;min-height:36px;border:none;background:transparent;text-align:left;font-weight:800;outline:none;font-family:var(--font);font-size:15px;color:${themeColor};transition:all .2s;padding:0" />
            <span id="plan-${tableName}-r${idx}-badge" style="display:flex;align-items:center">${planBadgeHtml(statsChk.count, isFilled)}</span>
          </div>
        </td>
        
        <td id="plan-${tableName}-r${idx}-chk" class="chk-cell" style="${tdStyle};color:${statsChk.count > 0 ? '#4ade80' : 'var(--muted)'};font-weight:900;font-size:18px">
          ${isFilled ? (statsChk.count || '-') : ''}
        </td>
        <td id="plan-${tableName}-r${idx}-media" class="media-cell" style="${tdStyle};color:${statsChk.count > 0 ? 'var(--text)' : 'var(--muted)'};font-weight:900;font-size:18px">
          ${isFilled ? (statsChk.media || '-') : ''}
        </td>
        
        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="plan-${tableName}-r${idx}-qtd_wms" type="text" value="${row.qtd_wms || ''}" 
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'qtd_wms')" 
                 style="${inpBase};min-width:0;box-sizing:border-box" />
        </td>
        <td style="${tdStyle};width:72px;min-width:72px;max-width:72px;background:rgba(255,255,255,0.02);overflow:hidden">
          <input id="plan-${tableName}-r${idx}-sugestao" type="text" value="${row.sugestao || ''}" 
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'sugestao')" 
                 style="${inpBase};min-width:0;box-sizing:border-box;color:var(--accent)" />
        </td>
        
        <td id="plan-${tableName}-r${idx}-doca" class="doca-cell" style="${tdStyle};background:rgba(34,211,238,0.05);color:#22d3ee;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(34,211,238,0.4)">
          ${isFilled ? (statsBol.doca || '-') : ''}
        </td>
        <td id="plan-${tableName}-r${idx}-lab" class="lab-cell" style="${tdStyle};background:rgba(167,139,250,0.05);color:#a78bfa;font-weight:900;font-size:18px;text-shadow:0 0 8px rgba(167,139,250,0.4)">
          ${isFilled ? (statsBol.lab || '-') : ''}
        </td>
        
        <td style="${tdStyle};padding:4px">
          <textarea id="plan-${tableName}-r${idx}-obs" class="plan-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'obs')" 
                 style="${inpBase};height:${hObs};padding-top:10px;font-weight:500;text-transform:uppercase;color:var(--text);resize:vertical">${esc(row.obs || '')}</textarea>
        </td>
        <td style="${tdLastStyle};padding:4px">
          <textarea id="plan-${tableName}-r${idx}-pecas" class="plan-textarea" rows="1" placeholder="..."
                 onfocus="${inpFocus}" onblur="${inpBlur}" 
                 onchange="fluxolabUpdateRowElem(this, '${tableName}', 'pecas')" 
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

function fluxolabRenderPlanejamento() {
  const panel = document.getElementById('fluxolab-tab-planejamento-panel');
  if (!panel) return;
  
  let modelosUnicos = Array.from(new Set(Object.values(typeof equipamentos !== 'undefined' ? equipamentos : {}).filter(Boolean)));
  modelosUnicos.sort((a,b) => a.localeCompare(b));
  
  let dataListHtml = '<datalist id="modelos-lista">';
  modelosUnicos.forEach(m => dataListHtml += `<option value="${m}">`);
  dataListHtml += '</datalist>';
  
  let html = dataListHtml;
  
  html += `
    <div style="margin-bottom:24px;display:flex;align-items:center;gap:14px">
      <div style="background:var(--bg3);padding:10px;border-radius:12px;border:1px solid var(--border2);display:inline-flex;align-items:center;justify-content:center;box-shadow:inset 0 2px 10px rgba(0,0,0,0.3)">
        <span style="font-size:24px;line-height:1">🌐</span>
      </div>
      <div>
        <h2 style="font-size:22px;font-weight:900;color:var(--text);margin:0;letter-spacing:-0.02em">Planejamento do Dia <span style="font-size:10px;background:#4ade8022;color:#4ade80;padding:2px 6px;border-radius:4px;margin-left:6px;vertical-align:middle;text-transform:uppercase">Online</span></h2>
        <p style="font-size:13px;color:var(--muted);margin:4px 0 0">Modo Multiplayer: Qualquer alteração feita por você ou por outros usuários atualiza a tela em tempo real sem conflitos.</p>
      </div>
    </div>
  `;
  
  html += fluxolabRenderPlanTable('PROGRAMAÇÃO ENTRADA EM LOTE LABORATÓRIO', 'tabela1', '#22d3ee', '#22d3ee');
  html += fluxolabRenderPlanTable('SOLICITAÇÕES DA DIREÇÃO', 'tabela2', '#a78bfa', '#a78bfa');
  html += fluxolabRenderPlanTable('PRIORIDADE DE SAÍDA', 'tabela3', '#fb923c', '#fb923c');
  
  panel.innerHTML = html;
  planInitResizeObserver();
}

setTimeout(fluxolabLoadPlanejamento, 1500);
