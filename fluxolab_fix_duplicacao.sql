-- ════════════════════════════════════════════════════════════════════════
-- FIX: SELB duplicado entre bolsões do FluxoLAB
--
-- CAUSA RAIZ: toda a árvore /fluxolab é guardada como UM ÚNICO JSON
-- (tabela fluxolab_state, key='fluxolab'). Hoje, mover um SELB é feito
-- em DOIS passos no navegador:
--   1) lê o JSON inteiro -> remove o SELB de onde ele estiver -> regrava
--      o JSON inteiro (dbDelete / fluxolabRemoveSelbGlobal)
--   2) lê o JSON de novo -> insere o SELB no bolsão novo -> regrava tudo
--      de novo (dbSet)
-- Isso é um clássico "read-modify-write" sem trava. Quando duas bipagens
-- de SELBs diferentes acontecem quase ao mesmo tempo (comum no chão de
-- fábrica, com vários operadores), a segunda gravação pode se basear numa
-- cópia do JSON tirada ANTES da primeira remoção ter sido salva — e ao
-- regravar o JSON inteiro, ela "ressuscita" o registro que já tinha sido
-- apagado. Resultado: o mesmo SELB aparece em dois bolsões ao mesmo tempo.
--
-- CORREÇÃO: mover/remover um SELB passa a ser UMA ÚNICA operação atômica
-- dentro do Postgres (SELECT ... FOR UPDATE trava a linha do blob durante
-- a transação), então duas bipagens concorrentes são serializadas pelo
-- banco e nunca mais uma sobrescreve a remoção feita pela outra.
--
-- Rode este script uma vez no SQL Editor do Supabase.
-- ════════════════════════════════════════════════════════════════════════

-- Remove um SELB de TODOS os bolsões (usado em qualquer "saída" do SELB
-- do FluxoLAB, sem necessariamente entrar em outro bolsão).
create or replace function fluxolab_remove_selb_everywhere(
  p_key text,
  p_selb_key text
) returns jsonb
language plpgsql
as $$
declare
  v_data   jsonb;
  v_bolsao text;
begin
  -- Trava a linha até o fim da transação: qualquer outra chamada a esta
  -- função (ou a fluxolab_move_selb) para a mesma p_key espera aqui.
  select data into v_data from fluxolab_state where key = p_key for update;
  if v_data is null then
    v_data := '{}'::jsonb;
  end if;

  for v_bolsao in select jsonb_object_keys(v_data) loop
    if (v_data -> v_bolsao) ? p_selb_key then
      v_data := jsonb_set(v_data, array[v_bolsao], (v_data -> v_bolsao) - p_selb_key);
    end if;
  end loop;

  insert into fluxolab_state (key, data, updated_at)
  values (p_key, v_data, now())
  on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;

  return v_data;
end;
$$;

-- Move um SELB para p_dest_bolsao: remove de qualquer bolsão onde ele
-- esteja e insere no destino, TUDO em uma única transação/travamento.
create or replace function fluxolab_move_selb(
  p_key          text,
  p_selb_key     text,
  p_dest_bolsao  text,
  p_record       jsonb
) returns jsonb
language plpgsql
as $$
declare
  v_data   jsonb;
  v_bolsao text;
begin
  select data into v_data from fluxolab_state where key = p_key for update;
  if v_data is null then
    v_data := '{}'::jsonb;
  end if;

  for v_bolsao in select jsonb_object_keys(v_data) loop
    if (v_data -> v_bolsao) ? p_selb_key then
      v_data := jsonb_set(v_data, array[v_bolsao], (v_data -> v_bolsao) - p_selb_key);
    end if;
  end loop;

  v_data := jsonb_set(
    jsonb_set(v_data, array[p_dest_bolsao], coalesce(v_data -> p_dest_bolsao, '{}'::jsonb), true),
    array[p_dest_bolsao, p_selb_key],
    p_record,
    true
  );

  insert into fluxolab_state (key, data, updated_at)
  values (p_key, v_data, now())
  on conflict (key) do update set data = excluded.data, updated_at = excluded.updated_at;

  return v_data;
end;
$$;
