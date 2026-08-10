const fs = require('fs');
let content = fs.readFileSync('app.js', 'utf8');

// The original file ended with })();
const delimiter = '})();';
const idx = content.lastIndexOf(delimiter);
if (idx !== -1) {
  content = content.substring(0, idx + delimiter.length);
}

const newCode = `

// ── LIMPEZA BOLSÕES MÁQUINAS A ──
window.fluxolabLimparMaquinasA = async function() {
  if (!confirm('Deseja conferir e remover dos bolsões do FluxoLAB os equipamentos que foram enviados para Máquinas A nos últimos 7 dias?')) return;
  
  const now = Date.now();
  const setedias = 7 * 24 * 60 * 60 * 1000;
  const selbsEmMaquinasARecentes = new Set();
  
  if (typeof _maquinasA === 'object' && _maquinasA !== null) {
    Object.values(_maquinasA).forEach(m => {
      if (m.selb && m.registrado_em && (now - m.registrado_em) <= setedias) {
        selbsEmMaquinasARecentes.add(m.selb);
      } else if (m.selb && !m.registrado_em) {
        selbsEmMaquinasARecentes.add(m.selb);
      }
    });
  }

  const selbsParaRemover = new Set();
  if (typeof _fluxolabData === 'object' && _fluxolabData !== null) {
    Object.entries(_fluxolabData).forEach(([bolsao, items]) => {
      if(items && typeof items === 'object') {
        Object.keys(items).forEach(selb => {
          if (selbsEmMaquinasARecentes.has(selb)) {
            selbsParaRemover.add(selb);
          }
        });
      }
    });
  }

  if (selbsParaRemover.size === 0) {
    if (typeof window._labPopup === 'function') {
      window._labPopup('Limpeza Máquinas A', 'Nenhum equipamento que foi para Máquinas A nos últimos 7 dias foi encontrado nos bolsões atuais.', 'ok');
    } else {
      alert('Nenhum equipamento que foi para Máquinas A nos últimos 7 dias foi encontrado nos bolsões atuais.');
    }
    return;
  }
  
  let removidas = 0;
  for (const selb of selbsParaRemover) {
    try {
      if (typeof fluxolabRemoveSelbGlobal === 'function') {
        await fluxolabRemoveSelbGlobal(selb);
        removidas++;
        console.log('[Limpeza Máquinas A] Removido SELB dos bolsões:', selb);
      }
    } catch(e) {
      console.warn('Erro ao remover SELB ' + selb, e);
    }
  }
  
  if (typeof window._labPopup === 'function') {
    window._labPopup('Limpeza Máquinas A', 'Limpeza concluída! Foram removidos ' + removidas + ' equipamento(s) dos bolsões.', 'ok');
  } else {
    alert('Limpeza concluída! Foram removidos ' + removidas + ' equipamento(s) dos bolsões.');
  }
};
`;

fs.writeFileSync('app.js', content + newCode);
console.log('Fixed app.js successfully!');
