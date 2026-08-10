const fs = require('fs');
let lines = fs.readFileSync('app.js', 'utf8').split('\r\n');

// Insert badge update code after line 18352 (index 18351 zero-based)
// Line 18352: "  _fluxolabRenderModelFilterBar(Array.from(allModelsSet), matchCountsByBolsao, totalMatches);"
const insertAfter = 18351; // zero-based index

const badgeCode = [
  '',
  "  // Atualiza badge total de SELBs nos bols\u00f5es",
  "  (function() {",
  "    var _badge = document.getElementById('fluxolab-bolsoes-total-badge');",
  "    if (_badge) {",
  "      var _total = 0;",
  "      bolsaoList.forEach(function(bb) { _total += (bb.items ? bb.items.length : 0); });",
  "      if (_total > 0) {",
  "        _badge.textContent = _total;",
  "        _badge.style.display = 'inline-block';",
  "      } else {",
  "        _badge.style.display = 'none';",
  "      }",
  "    }",
  "  })();"
];

lines.splice(insertAfter + 1, 0, ...badgeCode);

fs.writeFileSync('app.js', lines.join('\r\n'));
console.log('Badge injected at line', insertAfter + 2);
