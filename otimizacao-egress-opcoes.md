# Otimização de Egress no Supabase

Após analisar o código fonte do seu sistema (principalmente `app.js` e `supabase-compat-shim.js`), identifiquei que **88.9%** do seu consumo vem de requisições ao PostgREST (banco de dados). 

O problema principal é o tráfego de dados desnecessários na carga inicial das tabelas. Abaixo estão as opções de otimização, da mais segura/fácil até a mais complexa:

---

### Opção 1: Extração específica de campos JSON (Fácil & Muito Seguro)
**Onde:** Em `app.js` (linha ~12148)
**O problema:** Quando o sistema inicia, ele carrega as tabelas de equipamentos trazendo o objeto JSON `raw` inteiro:
```javascript
_supa.from('equipamentos').select('id, raw')
_supa.from('equipamentos_series').select('id, raw')
// ... (skus, unitizadores, maquinas_a_equipamentos)
```
**A solução:** O PostgREST permite extrair apenas chaves específicas do JSON, evitando baixar dados enormes. Como você só usa campos específicos para montar caches na memória, podemos mudar para:
```javascript
_supa.from('equipamentos').select('id, raw->>nome, raw->>manual, raw->>criadoEm')
```
**Impacto:** Muito alto, não afeta o sistema e reduz drasticamente o tráfego de megabytes a cada F5 do usuário.

---

### Opção 2: Filtrar ou limitar `select('*')` em listas que crescem sempre (Médio & Seguro)
**Onde:** Em `app.js` (linhas 6035, 7105, 7646, 13999)
**O problema:** Tabelas históricas estão sendo baixadas por inteiro, com todas as colunas. 
```javascript
let q = _supa.from('solicitacoes_pecas').select('*').order('ts', { ascending: false });
const { data } = await _supa.from('garantia').select('*');
// ... maquinas_perdidas, maquinas_a
```
Com o passar dos meses, essas tabelas ficam gigantes. Toda vez que alguém abre a aba/carrega a página, todo o histórico é baixado.
**A solução:** 
1. Trocar `select('*')` pelas colunas exatas necessárias (ex: `select('id, selb, ts, raw')`).
2. Adicionar `.limit(300)` ou limitar por data recente (ex: últimos 30 dias com `.gte('ts', data)`). 
**Impacto:** Muito alto a longo prazo. **Verificar:** Precisamos ter certeza se os usuários precisam ver o histórico completo dessas telas o tempo todo, ou se só precisam ver as pendências mais recentes.

---

### Opção 3: Otimizar carregamentos do `supabase-compat-shim.js` (Avançado)
**Onde:** `supabase-compat-shim.js` (linha 183)
**O problema:** O seu *shim* genérico de compatibilidade carrega sempre a tabela toda trazendo o campo `raw`:
```javascript
let q = supa.from(cfg.table).select('id,raw' + (dateKey ? ',date_key' : ''));
```
**A solução:** Adicionar inteligência no shim para suportar paginação ou especificação de campos (ex: receber um parâmetro de select).
**Impacto:** Médio. Um pouco mais sensível de alterar porque é usado como fundação em várias partes do sistema.

---

### Opção 4: Implementar Cache no Navegador (Offline First / PWA) (Muito Avançado)
**O problema:** O seu sistema parece ser um SPA (Single Page Application) que recarrega muitas tabelas "mestras" a cada refresh de página.
**A solução:** Usar o `localStorage` (como você já usa para pequenas coisas) ou o `IndexedDB` para guardar a tabela `equipamentos` inteira localmente. Quando a página carregar, você verifica com o Supabase apenas: *"Traga-me os equipamentos alterados/criados desde ontem"*, economizando 99% do Egress dessas requisições.
**Impacto:** Reduziria seu egress drasticamente, mas requer refatoração da lógica de fetch.

---

### Como prosseguir?
Recomendo começarmos pelas **Opções 1 e 2**, pois são pequenas alterações nas queries ("Low Hanging Fruits") que já devem resolver seu problema de limite para os próximos meses, sem alterar a lógica ou visual do seu sistema. 

Me diga se você concorda e eu posso implementar as mudanças na **Opção 1** e analisar exatamente como aplicar a **Opção 2** sem quebrar a tela de listagem de Peças/Garantia!
