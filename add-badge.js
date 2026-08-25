const fs = require('fs');
let appJs = fs.readFileSync('app.js', 'utf8');

const targetStr = `  // Renderiza/atualiza a barra de filtro acima do grid
  _fluxolabRenderModelFilterBar(Array.from(allModelsSet), matchCountsByBolsao, totalMatches);

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'modelos') {`;

const newStr = `  // Renderiza/atualiza a barra de filtro acima do grid
  _fluxolabRenderModelFilterBar(Array.from(allModelsSet), matchCountsByBolsao, totalMatches);

  // Atualiza badge total
  const totalSelbsBadge = document.getElementById('fluxolab-bolsoes-total-badge');
  if (totalSelbsBadge) {
    let totalAll = 0;
    bolsaoList.forEach(bb => { totalAll += (bb.items ? bb.items.length : 0); });
    if (totalAll > 0) {
      totalSelbsBadge.textContent = totalAll;
      totalSelbsBadge.style.display = 'inline-block';
    } else {
      totalSelbsBadge.style.display = 'none';
    }
  }

  if (typeof _fluxolabActiveTab !== 'undefined' && _fluxolabActiveTab === 'modelos') {`;

if (appJs.includes(targetStr)) {
  appJs = appJs.replace(targetStr, newStr);
  fs.writeFileSync('app.js', appJs);
  console.log('App.js badge injected successfully.');
} else {
  console.log('Target string NOT FOUND in app.js.');
}
