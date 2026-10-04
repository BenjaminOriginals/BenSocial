-- =====================================================================
-- Supabase stand-in for the local database tests.
--
-- Recreates the parts of a fresh Supabase project that schema.sql relies
-- on, including the parts that bite in production:
--   * postgres is NOT a superuser (it has bypassrls, like on Supabase).
--     schema.sql and seed.sql are applied as postgres, the same role the
--     Supabase SQL editor uses.
--   * anon, authenticated and service_role get ALL on every new table,
--     sequence and function in public through default privileges. Only
--     RLS and explicit grants/revokes in schema.sql guard the data.
--   * New functions are executable by PUBLIC (Postgres default).
--   * auth.users belongs to supabase_auth_admin, whose search_path is
--     "auth". Sign-up triggers run as that role, so a trigger function
--     that is not SECURITY DEFINER, or that relies on search_path, fails
--     the same way it would on Supabase ("Database error saving new user").
--   * auth.uid() / auth.role() / auth.jwt() read request.jwt.claim.sub and
--     request.jwt.claims exactly like Supabase.
--
-- Run as the cluster superuser (supabase_admin) on an empty database.
-- =====================================================================

\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- roles
create role postgres with login createrole createdb bypassrls;
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit;
create role supabase_auth_admin login noinherit createrole;

grant anon, authenticated, service_role to authenticator;
-- The dashboard lets postgres impersonate the API roles.
grant anon, authenticated, service_role to postgres;

alter role supabase_auth_admin set search_path = auth;
alter role authenticated set statement_timeout = '8s';
alter role anon set statement_timeout = '3s';

-- --------------------------------------------------------- schema public
grant usage, create on schema public to postgres;
grant usage on schema public to anon, authenticated, service_role;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;

-- ----------------------------------------------------------- schema auth
create schema auth authorization supabase_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
grant all on schema auth to supabase_auth_admin;

create table auth.users (
  instance_id uuid,
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{"provider":"email","providers":["email"]}',
  raw_user_meta_data jsonb default '{}',
  is_super_admin boolean,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_sign_in_at timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean not null default false
);
alter table auth.users owner to supabase_auth_admin;

-- A table GoTrue keeps that cascades from auth.users, so account deletion
-- exercises a real cascade on the auth side too.
create table auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null default 'email',
  identity_data jsonb not null default '{}',
  created_at timestamptz default now()
);
alter table auth.identities owner to supabase_auth_admin;

-- The SQL editor (postgres) can read and write auth tables and add triggers.
grant all on auth.users, auth.identities to postgres;

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role, postgres;
