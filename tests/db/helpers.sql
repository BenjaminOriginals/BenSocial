-- =====================================================================
-- Test helpers (loaded after schema.sql and seed.sql, as the superuser).
--
-- Assertions print "PASS <name>" as a NOTICE or "FAIL <name>" as a
-- WARNING. run.sh counts them. They never abort, so one failing check
-- does not hide the rest.
--
-- Impersonation works like PostgREST:
--   tst.login('alice')  ->  set local role authenticated
--                           set local request.jwt.claims = '{"sub": "<alice id>", "role": "authenticated"}'
--   tst.anon()          ->  set local role anon
--   tst.logout()        ->  back to the superuser
-- All of them are transaction-local, so tests wrap work in begin/rollback.
-- =====================================================================

create schema tst;
grant usage on schema tst to public;

-- Fixture users by handle.
create table tst.users (handle text primary key, id uuid not null unique);
grant select on tst.users to public;

create function tst.uid(p_handle text) returns uuid
language sql stable as $$ select id from tst.users where handle = p_handle $$;

create function tst.login(p_handle text) returns void
language plpgsql as $$
declare
  v uuid := tst.uid(p_handle);
begin
  if v is null then
    raise exception 'tst.login: no fixture user %', p_handle;
  end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', v, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function tst.login_id(p_id uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function tst.anon() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
end $$;

create function tst.logout() returns void
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Creates an account the way GoTrue does: as supabase_auth_admin, whose
-- search_path is "auth". The sign-up trigger must cope with that.
create function tst.signup(p_handle_key text, p_id uuid, p_meta jsonb) returns uuid
language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('role', 'supabase_auth_admin', true);
  perform set_config('search_path', 'auth', true);
  execute 'insert into users (id, email, encrypted_password, raw_user_meta_data, email_confirmed_at)
           values ($1, $2, $3, $4, now())'
    using p_id, p_handle_key || '@example.test', 'x', p_meta;
  perform set_config('search_path', '"$user", public', true);
  perform set_config('role', 'none', true);
  if p_handle_key is not null then
    insert into tst.users (handle, id) values (p_handle_key, p_id)
    on conflict (handle) do update set id = excluded.id;
  end if;
  return p_id;
end $$;

create function tst.pass(p_name text) returns void
language plpgsql as $$ begin raise notice 'PASS %', p_name; end $$;

create function tst.fail(p_name text) returns void
language plpgsql as $$ begin raise warning 'FAIL %', p_name; end $$;

create function tst.ok(p_cond boolean, p_name text) returns void
language plpgsql as $$
begin
  if p_cond then
    perform tst.pass(p_name);
  else
    perform tst.fail(p_name || ' (condition was ' || coalesce(p_cond::text, 'null') || ')');
  end if;
end $$;

create function tst.eq(p_got anycompatible, p_want anycompatible, p_name text) returns void
language plpgsql as $$
begin
  if p_got is not distinct from p_want then
    perform tst.pass(p_name);
  else
    perform tst.fail(format('%s (got %s, wanted %s)', p_name,
                            coalesce(p_got::text, 'null'), coalesce(p_want::text, 'null')));
  end if;
end $$;

-- |got - want| <= tol
create function tst.near(p_got numeric, p_want numeric, p_tol numeric, p_name text) returns void
language plpgsql as $$
begin
  if p_got is not null and p_want is not null and abs(p_got - p_want) <= p_tol then
    perform tst.pass(p_name);
  else
    perform tst.fail(format('%s (got %s, wanted %s within %s)', p_name, p_got, p_want, p_tol));
  end if;
end $$;

-- Runs p_sql as the current role and expects it to fail. p_want matches the
-- error message exactly, or the SQLSTATE, or a LIKE pattern on the message.
-- The statement runs in a subtransaction, so a failure leaves no trace.
create function tst.throws(p_sql text, p_want text, p_name text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm = p_want or sqlstate = p_want or sqlerrm like p_want then
      perform tst.pass(p_name);
    else
      perform tst.fail(format('%s (got %s "%s", wanted %s)', p_name, sqlstate, sqlerrm, p_want));
    end if;
    return;
  end;
  perform tst.fail(format('%s (no error, wanted %s)', p_name, p_want));
end $$;

-- Runs p_sql and expects success.
create function tst.lives(p_sql text, p_name text) returns void
language plpgsql as $$
begin
  execute p_sql;
  perform tst.pass(p_name);
exception when others then
  perform tst.fail(format('%s (got %s "%s")', p_name, sqlstate, sqlerrm));
end $$;

-- Number of rows a query returns, as the current role.
create function tst.count(p_sql text) returns bigint
language plpgsql as $$
declare
  n bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into n;
  return n;
end $$;

-- Reference copy of the client's levelInfo() from index.html.
create function tst.client_level(p_xp int) returns int
language plpgsql immutable as $$
declare
  lv int := 1; need int := 100; base int := 0;
begin
  while p_xp >= base + need loop
    base := base + need; lv := lv + 1; need := 100 + (lv - 1) * 50;
  end loop;
  return lv;
end $$;

-- Posts as a fixture user (goes through the same triggers as the app).
create function tst.post(p_handle text, p_body text, p_mood text default null) returns bigint
language plpgsql as $$
declare
  v bigint;
  v_role text := current_setting('role');
  v_claims text := current_setting('request.jwt.claims', true);
begin
  perform tst.login(p_handle);
  insert into public.posts (body, mood) values (p_body, p_mood) returning id into v;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
  perform set_config('role', v_role, true);
  return v;
end $$;

grant execute on all functions in schema tst to public;
