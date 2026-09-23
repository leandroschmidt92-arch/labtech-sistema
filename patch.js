window.fluxolabAbrirEstagnados = function() {
  var estagnados = window._fluxolabEstagnadosCache || [];
  if (estagnados.length === 0) {
    if (typeof showToast === 'function') showToast('Nenhum SELB estagnado (>3 dias) encontrado.', false);
    else alert('Nenhum SELB estagnado (>3 dias) encontrado.');
    return;
  }
  
  estagnados.sort(function(a, b) { return b.dias - a.dias; });

  var rows = estagnados.map(function(e) {
    return '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid var(--border)"><strong>' + e.selb + '</strong></td>' +
      '<td style="padding:8px;border-bottom:1px solid var(--border)">' + e.dias + ' dias</td>' +
      '<td style="padding:8px;border-bottom:1px solid var(--border)">' + e.bolsao + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid var(--border);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + (e.modelo || '') + '">' + (e.modelo || '') + '</td>' +
    '</tr>';
  }).join('');

  var overlay = document.createElement('div');
  overlay.style.position = 'fixed';
  overlay.style.top = '0'; overlay.style.left = '0'; overlay.style.width = '100%'; overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.6)';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex'; overlay.style.alignItems = 'center'; overlay.style.justifyContent = 'center';
  overlay.style.backdropFilter = 'blur(4px)';
  
  var modal = document.createElement('div');
  modal.style.backgroundColor = 'var(--bg1, #1e293b)';
  modal.style.border = '1px solid var(--border, #334155)';
  modal.style.borderRadius = '12px';
  modal.style.padding = '24px';
  modal.style.width = '600px';
  modal.style.maxWidth = '90vw';
  modal.style.maxHeight = '90vh';
  modal.style.display = 'flex';
  modal.style.flexDirection = 'column';
  modal.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';
  modal.style.color = 'var(--text, #f8fafc)';
  
  var selbListStr = estagnados.map(function(e) { return e.selb; }).join('\n');

  modal.innerHTML = 
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
      '<h2 style="margin:0;font-size:20px;color:#ef4444">🛑 SELBs Estagnados (> 3 dias)</h2>' +
      '<button id="btn-close-estagnados" style="background:none;border:none;font-size:24px;color:var(--muted);cursor:pointer;line-height:1">&times;</button>' +
    '</div>' +
    '<div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:14px;color:var(--muted)">Total: ' + estagnados.length + ' SELB(s) parados.</span>' +
      '<button id="btn-copy-estagnados" style="background:var(--accent, #3b82f6);color:#fff;border:none;border-radius:6px;padding:8px 16px;font-weight:bold;cursor:pointer">📋 Copiar SELBs</button>' +
    '</div>' +
    '<div style="overflow-y:auto;flex:1;border:1px solid var(--border, #334155);border-radius:6px">' +
      '<table style="width:100%;border-collapse:collapse;text-align:left;font-size:13px">' +
        '<thead style="background:var(--bg3, #0f172a);position:sticky;top:0">' +
          '<tr><th style="padding:8px">SELB</th><th style="padding:8px">Tempo Parado</th><th style="padding:8px">Bolsão</th><th style="padding:8px">Modelo</th></tr>' +
        '</thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  document.getElementById('btn-close-estagnados').onclick = function() {
    document.body.removeChild(overlay);
  };
  
  overlay.onclick = function(e) {
    if (e.target === overlay) document.body.removeChild(overlay);
  };

  document.getElementById('btn-copy-estagnados').onclick = function() {
    navigator.clipboard.writeText(selbListStr).then(function() {
      var btn = document.getElementById('btn-copy-estagnados');
      btn.textContent = '✅ Copiado!';
      btn.style.background = '#10b981';
      setTimeout(function() {
        if(document.body.contains(btn)){
            btn.textContent = '📋 Copiar SELBs';
            btn.style.background = 'var(--accent, #3b82f6)';
        }
      }, 2000);
    });
  };
};
