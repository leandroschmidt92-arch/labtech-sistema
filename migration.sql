-- ════════════════════════════════════════════════════════════════════
-- MIGRAÇÃO FIREBASE → SUPABASE — peças que faltavam no schema
-- Rode tudo isso no SQL Editor do Supabase (projeto wpawjyqjrzzleojzejuw)
-- ════════════════════════════════════════════════════════════════════

-- 1) Tabela de devoluções (não existia ainda)
create table if not exists public.devolucoes (
  id          text primary key,
  raw         jsonb not null default '{}'::jsonb,
  created_at  timestamp with time zone default now()
);

-- 2) Tabela de reconhecimento facial (existe no editor como "face_auth";
--    crie só se ainda não existir)
create table if not exists public.face_auth (
  id          text primary key,
  raw         jsonb not null default '{}'::jsonb,
  created_at  timestamp with time zone default now()
);

-- (Observação: "/fluxolab" e "/alarme_global" do Firebase passam a usar a
--  tabela fluxolab_state que você já tem, key='fluxolab' e key='alarme_global'.
--  Não precisa criar tabela nova pra eles.)

-- 3) Habilita Realtime (Postgres Changes) nas tabelas que têm listeners
--    em tempo real no app (onValue do Firebase).
alter publication supabase_realtime add table public.operadores;
alter publication supabase_realtime add table public.history;
alter publication supabase_realtime add table public.fluxolab_log;
alter publication supabase_realtime add table public.fluxolab_state;
alter publication supabase_realtime add table public.fluxolab_checklists;
alter publication supabase_realtime add table public.devolucoes;
alter publication supabase_realtime add table public.face_auth;

-- 4) RLS — habilita e libera acesso para a chave "publishable" (anon),
--    replicando o comportamento "aberto" que o Firebase RTDB tinha.
--    ⚠️ Isso é equivalente ao que provavelmente já existia no Firebase,
--    mas se quiser mais segurança depois, troque "true" por uma condição
--    (ex: exigir auth.role() = 'authenticated' nas escritas de admin).
alter table public.devolucoes   enable row level security;
alter table public.face_auth    enable row level security;

create policy "anon full access" on public.devolucoes
  for all using (true) with check (true);
create policy "anon full access" on public.face_auth
  for all using (true) with check (true);

-- Se as outras tabelas (operadores, history, fluxolab_log, fluxolab_state,
-- fluxolab_checklists) ainda não tiverem policy permitindo o app ler/escrever
-- com a publishable key, rode o mesmo padrão pra elas:
-- alter table public.operadores enable row level security;
-- create policy "anon full access" on public.operadores for all using (true) with check (true);
-- (repita para history, fluxolab_log, fluxolab_state, fluxolab_checklists)
