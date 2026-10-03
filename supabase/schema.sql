-- =====================================================================
-- BENSOCIAL DATABASE
--
-- How to use:
--   1. Create a Supabase project.
--   2. Open SQL Editor, paste this whole file, and press Run.
--   3. Sign up in the app, then make yourself an admin here (use the email
--      you signed up with; it should say "UPDATE 1"):
--        update public.profiles set is_admin = true
--         where id = (select id from auth.users where email = 'you@example.com');
--   4. Optional: run supabase/seed.sql for starter duels and held example ads.
--
-- Safe to run again. It creates what is missing, replaces functions,
-- policies and triggers in place, and never deletes your data.
--
-- Monetization is held. public.settings has one switch per feature
-- (ads_enabled, payments_enabled), both off, and nothing here turns one
-- on. In live mode these are the only switches: the app reads them
-- (app_switches()) and ignores SWITCHES in index.html. While ads_enabled
-- is off, no ad shows and no ad pays, whatever the ads table says. Admins
-- turn ads on and off in the app (Moderation -> Switchboard). Payments
-- have no tables yet: no money moves until a processor is connected (see
-- docs/GO-LIVE.md), so payments_enabled changes only in the SQL editor.
--
-- Security model (Supabase gives anon/authenticated ALL privileges on new
-- objects by default):
--   * RLS is on for every table. Policies only target "authenticated".
--   * Table and column privileges are revoked and granted back explicitly,
--     so clients can only write the columns the app needs.
--   * Counters, XP, clout, prices and notifications are written only by
--     triggers and SECURITY DEFINER functions. Internal helpers cannot be
--     called by clients.
-- =====================================================================


-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  handle text not null unique check (handle ~ '^[a-z0-9._]{3,20}$'),
  name text not null check (char_length(name) between 1 and 40),
  hue int not null default 48 check (hue between 0 and 359),
  bio text not null default '' check (char_length(bio) <= 160),
  xp int not null default 0,
  clout numeric(14,2) not null default 500 check (clout >= 0),
  streak int not null default 0,
  last_active date,
  active_days date[] not null default '{}',
  drop_day date,
  followers_count int not null default 0,
  following_count int not null default 0,
  dial jsonb check (dial is null or octet_length(dial::text) <= 4000),
  ad_price_cents int not null default 4 check (ad_price_cents between 1 and 20),
  earnings_cents numeric(14,2) not null default 0,
  is_admin boolean not null default false,
  is_banned boolean not null default false,
  pro boolean not null default false,
  accepted_terms_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id bigint generated always as identity primary key,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  mood text check (mood in ('spicy', 'wholesome', 'question')),
  spicy real not null default .25,
  wholesome real not null default .35,
  likes int not null default 0,
  dislikes int not null default 0,
  replies int not null default 0,
  reposts int not null default 0,
  shares_outstanding numeric(18,6) not null default 0 check (shares_outstanding >= 0),
  price numeric(14,4) not null default 5,
  price_history numeric(14,4)[] not null default '{5}',
  removed boolean not null default false,
  -- Clout Market pot: what backers paid in minus what sellers took out.
  -- Refunds when the post goes away never pay out more than the market holds.
  reserve numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);

create table if not exists public.post_edits (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts (id) on delete cascade,
  body text not null,
  written_at timestamptz not null default now()
);

create table if not exists public.reactions (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id bigint not null references public.posts (id) on delete cascade,
  kind text not null check (kind in ('like', 'dislike')),
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.reposts (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  post_id bigint not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.replies (
  id bigint generated always as identity primary key,
  post_id bigint not null references public.posts (id) on delete cascade,
  author_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 280),
  removed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.follows (
  follower uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  followee uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  check (follower <> followee)
);

create table if not exists public.mutes (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  muted_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, muted_id),
  check (user_id <> muted_id)
);

create table if not exists public.blocks (
  blocker uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  blocked uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);

-- A report keeps its row when the reported content is deleted (the target
-- column becomes null), so "exactly one target" is enforced on insert by
-- the RLS policy, and the table only forbids more than one.
-- target_user, target_handle and content are a copy taken when the report
-- is filed, so moderators can still read it and ban its author after the
-- author deletes it. Only the server writes them, and only moderators read them.
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  reporter uuid default auth.uid() references public.profiles (id) on delete set null,
  post_id bigint references public.posts (id) on delete set null,
  reply_id bigint references public.replies (id) on delete set null,
  profile_id uuid references public.profiles (id) on delete set null,
  reason text not null check (reason in ('spam', 'harassment', 'hate', 'violence', 'sexual',
                                         'self_harm', 'misinformation', 'other')),
  details text default '' check (char_length(details) <= 500),
  status text not null default 'open' check (status in ('open', 'dismissed', 'actioned')),
  target_user uuid references public.profiles (id) on delete set null,
  target_handle text,
  content text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(post_id, reply_id, profile_id) <= 1)
);

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  actor_id uuid references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('like', 'reply', 'follow', 'repost', 'back',
                                     'duel_won', 'duel_lost', 'level', 'mod')),
  post_id bigint references public.posts (id) on delete cascade,
  data jsonb not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.positions (
  user_id uuid not null references public.profiles (id) on delete cascade,
  post_id bigint not null references public.posts (id) on delete cascade,
  shares numeric(18,6) not null default 0 check (shares >= 0),
  cost numeric(14,2) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.duels (
  id bigint generated always as identity primary key,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  a_user uuid references public.profiles (id) on delete set null,
  a_label text not null check (char_length(btrim(a_label)) between 1 and 80),
  a_take text not null check (char_length(btrim(a_take)) between 1 and 500),
  b_user uuid references public.profiles (id) on delete set null,
  b_label text not null check (char_length(btrim(b_label)) between 1 and 80),
  b_take text not null check (char_length(btrim(b_take)) between 1 and 500),
  a_votes int not null default 0,
  b_votes int not null default 0,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  settled boolean not null default false,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table if not exists public.duel_votes (
  user_id uuid not null references public.profiles (id) on delete cascade,
  duel_id bigint not null references public.duels (id) on delete cascade,
  side text not null check (side in ('a', 'b')),
  created_at timestamptz not null default now(),
  primary key (user_id, duel_id)
);

-- One row per XP grant. The primary key is what stops double grants.
create table if not exists public.xp_log (
  user_id uuid not null references public.profiles (id) on delete cascade,
  reason text not null,
  ref text not null default '',
  amount int not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, reason, ref)
);

-- HELD: ads. Nothing shows or pays until a row has active = true.
create table if not exists public.ads (
  id bigint generated always as identity primary key,
  brand text not null check (char_length(btrim(brand)) between 1 and 60),
  hue int not null default 200 check (hue between 0 and 359),
  bid_cents numeric(8,2) not null check (bid_cents > 0),
  copy text not null check (char_length(btrim(copy)) between 1 and 280),
  why text not null default '' check (char_length(why) <= 200),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

-- HELD: one ad credit per user, ad and day.
create table if not exists public.ad_views (
  user_id uuid not null references public.profiles (id) on delete cascade,
  ad_id bigint not null references public.ads (id) on delete cascade,
  day date not null,
  earned_cents numeric(8,2) not null default 0,
  created_at timestamptz not null default now(),
  primary key (user_id, ad_id, day)
);

-- The monetization switchboard for live mode. One row. The app reads these
-- (app_switches()) to decide what people see, and the database checks them
-- before it shows or pays anything. Both start off. Admins turn ads on and
-- off in the app (Moderation -> Switchboard), or here in the SQL editor:
--   update public.settings set ads_enabled = true;
-- Each person gets the change the next time they open BenSocial.
create table if not exists public.settings (
  id boolean primary key default true check (id),
  ads_enabled boolean not null default false,
  payments_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (true) on conflict (id) do nothing;

-- Bans that outlive the account. A row exists while someone is banned. If
-- they delete their account, the row stays with user_id cleared: a one-way
-- hash of their email (signing up again with it starts out banned) and their
-- handle (nobody else can take it). Unbanning deletes the row.
create table if not exists public.bans (
  id bigint generated always as identity primary key,
  user_id uuid unique references public.profiles (id) on delete set null,
  email_hash text,
  handle text,
  created_at timestamptz not null default now()
);

-- Recent writes per person, for rate limits and daily claims. A row stays
-- when what it counts is deleted, so deleting and posting again does not get
-- around a limit. Rows older than a day are cleared as new ones arrive.
create table if not exists public.write_log (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  created_at timestamptz not null default now()
);

-- Columns added after the first release. On an older install these add
-- what is missing; on a new one they change nothing.
alter table public.reports add column if not exists target_user uuid references public.profiles (id) on delete set null;
alter table public.reports add column if not exists target_handle text;
alter table public.reports add column if not exists content text;
update public.reports r
   set target_user = coalesce(po.author_id, re.author_id, r.profile_id),
       content = coalesce(po.body, re.body,
                          pr.name || case when pr.bio <> '' then E'\n' || pr.bio else '' end)
  from public.reports r2
  left join public.posts po on po.id = r2.post_id
  left join public.replies re on re.id = r2.reply_id
  left join public.profiles pr on pr.id = r2.profile_id
 where r2.id = r.id and r.target_user is null and r.content is null
   and num_nonnulls(r2.post_id, r2.reply_id, r2.profile_id) = 1;
update public.reports r set target_handle = p.handle
  from public.profiles p where p.id = r.target_user and r.target_handle is null;
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'posts' and column_name = 'reserve') then
    alter table public.posts add column reserve numeric(14,2) not null default 0;
    -- Start each pot at what its current backers paid.
    update public.posts p set reserve = s.cost
      from (select post_id, sum(cost) as cost from public.positions group by post_id) s
     where s.post_id = p.id;
  end if;
end
$$;


-- =====================================================================
-- 2. INDEXES
-- =====================================================================

create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists posts_author_created_idx on public.posts (author_id, created_at desc);
create index if not exists post_edits_post_idx on public.post_edits (post_id, written_at);
create index if not exists reactions_post_idx on public.reactions (post_id);
create index if not exists reposts_post_idx on public.reposts (post_id);
create index if not exists replies_post_idx on public.replies (post_id, created_at);
create index if not exists replies_author_idx on public.replies (author_id, created_at desc);
create index if not exists follows_followee_idx on public.follows (followee);
create index if not exists mutes_muted_idx on public.mutes (muted_id);
create index if not exists blocks_blocked_idx on public.blocks (blocked);
create index if not exists reports_status_idx on public.reports (status, created_at);
create index if not exists reports_reporter_idx on public.reports (reporter, created_at desc);
create index if not exists reports_post_idx on public.reports (post_id);
create index if not exists reports_reply_idx on public.reports (reply_id);
create index if not exists reports_profile_idx on public.reports (profile_id);
create index if not exists reports_target_user_idx on public.reports (target_user);
create index if not exists bans_email_idx on public.bans (email_hash) where user_id is null;
create index if not exists bans_handle_idx on public.bans (handle) where user_id is null;
create index if not exists write_log_user_idx on public.write_log (user_id, kind, created_at desc);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id) where not read;
create index if not exists notifications_actor_idx on public.notifications (actor_id);
create index if not exists notifications_post_idx on public.notifications (post_id);
create index if not exists positions_post_idx on public.positions (post_id);
create index if not exists duels_ends_idx on public.duels (ends_at);
create index if not exists duels_a_user_idx on public.duels (a_user);
create index if not exists duels_b_user_idx on public.duels (b_user);
create index if not exists duel_votes_duel_idx on public.duel_votes (duel_id, side);
create index if not exists ad_views_ad_idx on public.ad_views (ad_id);


-- =====================================================================
-- 3. INTERNAL HELPERS (never callable by clients; see section 9)
-- =====================================================================

-- Level from XP. Must match levelInfo() in index.html:
--   lv=1, need=100, base=0; while xp >= base+need { base+=need; lv++; need=100+(lv-1)*50 }
create or replace function public.xp_level(p_xp int)
returns int
language plpgsql immutable
set search_path = public
as $$
declare
  lv int := 1;
  need int := 100;
  base int := 0;
begin
  while coalesce(p_xp, 0) >= base + need loop
    base := base + need;
    lv := lv + 1;
    need := 100 + (lv - 1) * 50;
  end loop;
  return lv;
end
$$;

-- Clout Market bonding curve, engagement part:
--   e = greatest(0, likes + 2*reposts + 1.5*replies - 0.5*dislikes)
--   a = 5 + 0.8 * sqrt(e)
-- price = a + 0.05 * shares_outstanding
create or replace function public.market_base(p_likes int, p_dislikes int, p_replies int, p_reposts int)
returns numeric
language sql immutable
set search_path = public
as $$
  select 5 + 0.8 * sqrt(greatest(0::numeric,
    coalesce(p_likes, 0) + 2 * coalesce(p_reposts, 0) + 1.5 * coalesce(p_replies, 0)
    - 0.5 * coalesce(p_dislikes, 0)))
$$;

create or replace function public.market_price(p_likes int, p_dislikes int, p_replies int,
                                               p_reposts int, p_shares numeric)
returns numeric
language sql immutable
set search_path = public
as $$
  select round(public.market_base(p_likes, p_dislikes, p_replies, p_reposts)
               + 0.05 * coalesce(p_shares, 0), 4)
$$;

-- True when a and b have blocked each other in either direction.
create or replace function public.blocked_pair(p_a uuid, p_b uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker = p_a and b.blocked = p_b)
       or (b.blocker = p_b and b.blocked = p_a)
  )
$$;

-- Returns the caller's id, or raises not_authenticated / not_found / banned.
create or replace function public.req_user(p_allow_banned boolean default false)
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_banned boolean;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  select p.is_banned into v_banned from public.profiles p where p.id = v_uid;
  if not found then
    raise exception 'not_found';
  end if;
  if v_banned and not coalesce(p_allow_banned, false) then
    raise exception 'banned';
  end if;
  return v_uid;
end
$$;

-- Returns the caller's id if they are an admin, else raises not_admin.
create or replace function public.req_admin()
returns uuid
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  -- A banned admin keeps the flag but loses every moderation power.
  if not exists (select 1 from public.profiles p where p.id = v_uid and p.is_admin and not p.is_banned) then
    raise exception 'not_admin';
  end if;
  return v_uid;
end
$$;

-- The server-side switches (public.settings). Off unless the owner turned them on.
create or replace function public.payments_enabled()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select s.payments_enabled from public.settings s where s.id), false)
$$;

-- One-way hash of an email address, for bans that outlive the account.
create or replace function public.email_hash(p_email text)
returns text
language sql immutable
set search_path = public
as $$
  select case when nullif(btrim(p_email), '') is null then null
              else encode(sha256(convert_to(lower(btrim(p_email)), 'UTF8')), 'hex') end
$$;

-- Records (or refreshes) the ban of an existing account: its current email
-- hash and handle, so the ban survives if the account is deleted.
create or replace function public.record_ban(p_user uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.bans (user_id, email_hash, handle)
  select p.id, public.email_hash(u.email), p.handle
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = p_user
  on conflict (user_id) do update
    set email_hash = coalesce(excluded.email_hash, public.bans.email_hash),
        handle = excluded.handle;
end
$$;

-- Rate limit for one kind of write. Counts the person's writes of that kind
-- in the last minute and day (deleted posts and replies still count), raises
-- slow_down at the limit, else records this one. A null limit is not checked.
create or replace function public.rate_check(p_user uuid, p_kind text, p_per_minute int, p_per_day int)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_user is null then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtext('bensocial.rate.' || p_kind), hashtext(p_user::text));
  delete from public.write_log
   where user_id = p_user and kind = p_kind and created_at < now() - interval '1 day';
  if (p_per_minute is not null
      and (select count(*) from public.write_log w
            where w.user_id = p_user and w.kind = p_kind and w.created_at > now() - interval '1 minute') >= p_per_minute)
     or (p_per_day is not null
      and (select count(*) from public.write_log w
            where w.user_id = p_user and w.kind = p_kind) >= p_per_day) then
    raise exception 'slow_down';
  end if;
  insert into public.write_log (user_id, kind) values (p_user, p_kind);
end
$$;

-- Daily claims (drop, streak, ad credit) take the caller's local date, which
-- can be a day either side of the server's. To stop one real day from
-- counting as three, at most two claims of a kind fit in any 20 hours.
-- Returns true and records the claim when it is allowed.
create or replace function public.claim_slot(p_user uuid, p_kind text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtext('bensocial.claim.' || p_kind), hashtext(p_user::text));
  delete from public.write_log
   where user_id = p_user and kind = p_kind and created_at < now() - interval '1 day';
  if (select count(*) from public.write_log w
       where w.user_id = p_user and w.kind = p_kind and w.created_at > now() - interval '20 hours') >= 2 then
    return false;
  end if;
  insert into public.write_log (user_id, kind) values (p_user, p_kind);
  return true;
end
$$;

-- Writes a notification. Never notifies yourself, and skips actors you
-- blocked, who blocked you, or whom you muted.
create or replace function public.add_notification(p_user uuid, p_actor uuid, p_kind text,
                                                   p_post bigint default null,
                                                   p_data jsonb default '{}')
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_user is null or p_user = p_actor then
    return;
  end if;
  if p_actor is not null and (
       public.blocked_pair(p_user, p_actor)
       or exists (select 1 from public.mutes m where m.user_id = p_user and m.muted_id = p_actor)) then
    return;
  end if;
  insert into public.notifications (user_id, actor_id, kind, post_id, data)
  values (p_user, p_actor, p_kind, p_post, coalesce(p_data, '{}'::jsonb));
end
$$;

-- Grants XP once per (user, reason, ref). Returns true when it granted.
-- Each level crossed pays 50 x that level in clout and sends a 'level' note.
create or replace function public.award_xp(p_user uuid, p_amount int, p_reason text, p_ref text)
returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  v_new int;
  v_from int;
  v_to int;
  v_bonus int := 0;
  lv int;
begin
  if p_user is null or coalesce(p_amount, 0) <= 0 then
    return false;
  end if;
  insert into public.xp_log (user_id, reason, ref, amount)
  values (p_user, p_reason, coalesce(p_ref, ''), p_amount)
  on conflict do nothing;
  if not found then
    return false;
  end if;
  update public.profiles set xp = xp + p_amount where id = p_user returning xp into v_new;
  if not found then
    return false;
  end if;
  v_from := public.xp_level(v_new - p_amount);
  v_to := public.xp_level(v_new);
  for lv in v_from + 1 .. v_to loop
    v_bonus := v_bonus + 50 * lv;
    insert into public.notifications (user_id, kind, data)
    values (p_user, 'level', jsonb_build_object('level', lv, 'bonus', 50 * lv));
  end loop;
  if v_bonus > 0 then
    update public.profiles set clout = clout + v_bonus where id = p_user;
  end if;
  return true;
end
$$;

-- Pays the holders of a post back and closes the positions. Used when a post
-- is deleted or removed by a moderator. Each holder gets back what they paid,
-- as long as the market can cover it: the post's pot (paid in minus taken out
-- by sellers), or what selling every position right now would pay, whichever
-- is more. If that falls short, everyone gets the same share of what they
-- paid. So deleting a post never pays out more than selling would, and the
-- market cannot create clout (an early backer's profit came from later buyers).
create or replace function public.refund_positions(p_post bigint)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_post public.posts%rowtype;
  v_cost numeric;
  v_h numeric;
  v_s numeric;
  v_pot numeric;
begin
  select * into v_post from public.posts where id = p_post;
  select coalesce(sum(cost), 0), coalesce(sum(shares), 0) into v_cost, v_h
    from public.positions where post_id = p_post;
  if v_cost <= 0 then
    delete from public.positions where post_id = p_post;
    return;
  end if;
  v_s := greatest(coalesce(v_post.shares_outstanding, 0), v_h);
  v_pot := greatest(coalesce(v_post.reserve, 0),
                    public.market_base(v_post.likes, v_post.dislikes, v_post.replies, v_post.reposts) * v_h
                    + 0.05 * v_h * (2 * v_s - v_h) / 2,
                    0);
  with closed as (
    delete from public.positions where post_id = p_post returning user_id, cost
  )
  update public.profiles p
     set clout = p.clout + case when v_pot >= v_cost then closed.cost
                                else trunc(closed.cost * v_pot / v_cost, 2) end
    from closed
   where p.id = closed.user_id;
end
$$;

-- Creates the profile for a new account. The handle comes from the sign-up
-- metadata when it is valid, free and not reserved, otherwise 'user' + the
-- first 8 hex characters of the id (longer if that is taken). Someone whose
-- email matches a ban that outlived its account starts out banned (and may
-- have their old handle back, since it was held for them).
create or replace function public.create_profile(p_id uuid, p_meta jsonb)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_meta jsonb := case when jsonb_typeof(p_meta) = 'object' then p_meta else '{}'::jsonb end;
  v_hex text := replace(p_id::text, '-', '');
  v_handle text := lower(btrim(coalesce(v_meta ->> 'handle', '')));
  v_name text := btrim(left(btrim(coalesce(v_meta ->> 'name', '')), 40));
  v_hash text;
  v_ban public.bans%rowtype;
  v_try int := 0;
begin
  if p_id is null or exists (select 1 from public.profiles where id = p_id) then
    return;
  end if;
  v_hash := public.email_hash((select u.email from auth.users u where u.id = p_id));
  if v_hash is not null then
    select * into v_ban from public.bans b
     where b.user_id is null and b.email_hash = v_hash
     order by b.id limit 1;
  end if;
  v_handle := ltrim(v_handle, '@');
  if v_handle !~ '^[a-z0-9._]{3,20}$'
     or exists (select 1 from public.profiles where handle = v_handle)
     or (public.handle_reserved(v_handle) and v_handle is distinct from v_ban.handle) then
    v_handle := 'user' || left(v_hex, 8);
  end if;
  -- Only BenSocial itself may use its name.
  if lower(regexp_replace(v_name, '[^[:alnum:]]', '', 'g')) like '%bensocial%' then
    v_name := '';
  end if;
  loop
    begin
      insert into public.profiles (id, handle, name, hue, accepted_terms_at, is_banned)
      values (p_id, v_handle, coalesce(nullif(v_name, ''), v_handle),
              ((hashtext(p_id::text) % 360) + 360) % 360, now(), v_ban.id is not null)
      on conflict (id) do nothing;
      if v_ban.id is not null then
        update public.bans set user_id = p_id, handle = v_handle where id = v_ban.id;
      end if;
      return;
    exception when unique_violation then
      v_try := v_try + 1;
      if v_try > 2 then
        raise;
      end if;
      v_handle := 'user' || left(v_hex, 8 + 4 * v_try);
    end;
  end loop;
end
$$;


-- =====================================================================
-- 4. POLICY HELPERS (callable by signed-in users; used inside RLS)
-- =====================================================================

create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select p.is_admin and not p.is_banned from public.profiles p where p.id = auth.uid()), false)
$$;

-- True when the caller and p_other have a block between them, either way.
create or replace function public.is_blocked_with(p_other uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.blocked_pair(auth.uid(), p_other)
$$;

-- True when the owner turned ads on in public.settings. The ads policy uses it.
create or replace function public.ads_enabled()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select s.ads_enabled from public.settings s where s.id), false)
$$;

-- Handles nobody can pick in the app: staff and brand names, anything with
-- "bensocial" in it, and the handles of banned accounts that were deleted.
-- The owner can still give one out in the SQL editor (docs/GO-LIVE.md,
-- step 6). The database also lets admins switch to one.
create or replace function public.handle_reserved(p_handle text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(
    lower(btrim(p_handle)) = any (array[
      'admin', 'administrator', 'admins', 'mod', 'mods', 'moderator', 'moderators', 'moderation',
      'support', 'help', 'helpdesk', 'official', 'staff', 'team', 'root', 'security', 'system',
      'sysadmin', 'owner', 'safety', 'trust', 'abuse', 'legal', 'privacy', 'terms', 'contact',
      'info', 'news', 'verified', 'everyone', 'api', 'www', 'null', 'undefined', 'anonymous',
      'unknown', 'deleted'])
    or translate(lower(p_handle), '._', '') like '%bensocial%'
    or exists (select 1 from public.bans b where b.user_id is null and b.handle = lower(btrim(p_handle))),
    false)
$$;


-- =====================================================================
-- 5. TRIGGERS
-- =====================================================================

-- ---- auth.users -> profiles. Must never fail a sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  begin
    perform public.create_profile(new.id, new.raw_user_meta_data);
  exception when others then
    raise warning 'bensocial: could not create a profile for user %: %', new.id, sqlerrm;
  end;
  return new;
end
$$;

-- auth.users belongs to Supabase Auth, so the SQL editor may add a trigger
-- to it but not drop one. Create it once; re-runs update the function above.
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'auth.users'::regclass
                    and tgname = 'bensocial_on_auth_user_created') then
    create trigger bensocial_on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end
$$;

-- ---- profiles
-- Runs as the caller on purpose: current_user is 'authenticated' only for
-- edits that come straight from the app, not for server-side updates.
create or replace function public.profiles_before_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated' and old.is_banned then
    raise exception 'banned';
  end if;
  if new.handle is distinct from old.handle then
    new.handle := lower(btrim(new.handle));
    if new.handle is distinct from old.handle
       and (exists (select 1 from public.profiles p where p.handle = new.handle and p.id <> new.id)
            or (current_user = 'authenticated' and public.handle_reserved(new.handle) and not public.is_admin())) then
      raise exception 'handle_taken';
    end if;
  end if;
  if new.name is distinct from old.name then
    new.name := btrim(new.name);
    if current_user = 'authenticated'
       and lower(regexp_replace(new.name, '[^[:alnum:]]', '', 'g')) like '%bensocial%'
       and not public.is_admin() then
      raise exception 'name_reserved';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists profiles_before_update on public.profiles;
create trigger profiles_before_update
  before update on public.profiles
  for each row execute function public.profiles_before_update();

-- When an account goes away, its shares leave the market with it.
create or replace function public.profiles_before_delete()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  update public.posts p
     set shares_outstanding = greatest(0, p.shares_outstanding - pos.shares)
    from public.positions pos
   where pos.user_id = old.id and pos.post_id = p.id;
  return old;
end
$$;

drop trigger if exists profiles_before_delete on public.profiles;
create trigger profiles_before_delete
  before delete on public.profiles
  for each row execute function public.profiles_before_delete();

-- ---- posts
create or replace function public.posts_before_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.author_id := v_uid;
    if exists (select 1 from public.profiles p where p.id = v_uid and p.is_banned) then
      raise exception 'banned';
    end if;
    perform pg_advisory_xact_lock(hashtext('bensocial.posts'), hashtext(v_uid::text));
    if (select count(*) from public.posts p
         where p.author_id = v_uid and p.created_at > now() - interval '1 minute') >= 5
       or (select count(*) from public.posts p
         where p.author_id = v_uid and p.created_at > now() - interval '1 day') >= 100 then
      raise exception 'slow_down';
    end if;
    -- Deleted posts count too.
    perform public.rate_check(v_uid, 'post', 5, 100);
  end if;
  new.spicy := case new.mood when 'spicy' then .8 when 'wholesome' then .05 else .25 end;
  new.wholesome := case new.mood when 'spicy' then .1 when 'wholesome' then .85 else .35 end;
  new.price := public.market_price(new.likes, new.dislikes, new.replies, new.reposts, new.shares_outstanding);
  new.price_history := array[new.price];
  return new;
end
$$;

drop trigger if exists posts_before_insert on public.posts;
create trigger posts_before_insert
  before insert on public.posts
  for each row execute function public.posts_before_insert();

create or replace function public.posts_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.award_xp(new.author_id, 25, 'post', new.id::text);
  return null;
end
$$;

drop trigger if exists posts_after_insert on public.posts;
create trigger posts_after_insert
  after insert on public.posts
  for each row execute function public.posts_after_insert();

-- One function for every post update: edit receipts, refunds on removal,
-- and the market price. Edits from the app are limited to 10 a minute and
-- 100 a day per person, and 50 per post (every version stays public).
create or replace function public.posts_before_update()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  n int;
begin
  if new.body is distinct from old.body then
    if auth.uid() is not null then
      perform public.rate_check(auth.uid(), 'edit', 10, 100);
      if (select count(*) from public.post_edits e where e.post_id = old.id) >= 50 then
        raise exception 'edit_limit';
      end if;
    end if;
    insert into public.post_edits (post_id, body, written_at)
    values (old.id, old.body, coalesce(old.edited_at, old.created_at));
    new.edited_at := now();
  end if;

  if new.removed and not old.removed then
    perform public.refund_positions(old.id);
    new.shares_outstanding := 0;
    new.reserve := 0;
  end if;

  if (new.likes, new.dislikes, new.replies, new.reposts, new.shares_outstanding)
     is distinct from (old.likes, old.dislikes, old.replies, old.reposts, old.shares_outstanding) then
    new.price := public.market_price(new.likes, new.dislikes, new.replies, new.reposts, new.shares_outstanding);
    if new.price is distinct from old.price then
      new.price_history := coalesce(old.price_history, '{}') || new.price;
      n := array_length(new.price_history, 1);
      if n > 40 then
        new.price_history := new.price_history[n - 39 : n];
      end if;
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists posts_before_update on public.posts;
create trigger posts_before_update
  before update on public.posts
  for each row execute function public.posts_before_update();

create or replace function public.posts_before_delete()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.refund_positions(old.id);
  return old;
end
$$;

drop trigger if exists posts_before_delete on public.posts;
create trigger posts_before_delete
  before delete on public.posts
  for each row execute function public.posts_before_delete();

-- ---- reactions
-- Upserts from the client rewrite post_id; keep the row's identity fixed.
create or replace function public.reactions_before_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.user_id := old.user_id;
  new.post_id := old.post_id;
  return new;
end
$$;

drop trigger if exists reactions_before_update on public.reactions;
create trigger reactions_before_update
  before update on public.reactions
  for each row execute function public.reactions_before_update();

create or replace function public.reactions_after_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_post bigint;
  v_likes int := 0;
  v_dislikes int := 0;
  v_owner uuid;
begin
  if tg_op <> 'DELETE'
     and exists (select 1 from public.profiles p where p.id = new.user_id and p.is_banned) then
    raise exception 'banned';
  end if;
  if tg_op = 'INSERT' then
    v_post := new.post_id;
    v_likes := (new.kind = 'like')::int;
    v_dislikes := (new.kind = 'dislike')::int;
  elsif tg_op = 'DELETE' then
    v_post := old.post_id;
    v_likes := -(old.kind = 'like')::int;
    v_dislikes := -(old.kind = 'dislike')::int;
  else
    if new.kind = old.kind then
      return null;
    end if;
    v_post := new.post_id;
    v_likes := (new.kind = 'like')::int - (old.kind = 'like')::int;
    v_dislikes := (new.kind = 'dislike')::int - (old.kind = 'dislike')::int;
  end if;

  update public.posts
     set likes = likes + v_likes, dislikes = dislikes + v_dislikes
   where id = v_post
  returning author_id into v_owner;

  -- First like ever from this user on this post: XP for them, a note for the author.
  if tg_op <> 'DELETE' and new.kind = 'like' and v_owner is not null then
    if public.award_xp(new.user_id, 2, 'like', new.post_id::text) then
      perform public.add_notification(v_owner, new.user_id, 'like', new.post_id);
    end if;
  end if;
  return null;
end
$$;

drop trigger if exists reactions_after_change on public.reactions;
create trigger reactions_after_change
  after insert or update or delete on public.reactions
  for each row execute function public.reactions_after_change();

-- ---- reposts
create or replace function public.reposts_after_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.profiles p where p.id = new.user_id and p.is_banned) then
      raise exception 'banned';
    end if;
    update public.posts set reposts = reposts + 1 where id = new.post_id returning author_id into v_owner;
    if v_owner is not null and public.award_xp(new.user_id, 3, 'repost', new.post_id::text) then
      perform public.add_notification(v_owner, new.user_id, 'repost', new.post_id);
    end if;
  else
    update public.posts set reposts = reposts - 1 where id = old.post_id;
  end if;
  return null;
end
$$;

drop trigger if exists reposts_after_change on public.reposts;
create trigger reposts_after_change
  after insert or delete on public.reposts
  for each row execute function public.reposts_after_change();

-- ---- replies
create or replace function public.replies_before_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.author_id := v_uid;
    if exists (select 1 from public.profiles p where p.id = v_uid and p.is_banned) then
      raise exception 'banned';
    end if;
    perform pg_advisory_xact_lock(hashtext('bensocial.replies'), hashtext(v_uid::text));
    if (select count(*) from public.replies r
         where r.author_id = v_uid and r.created_at > now() - interval '1 minute') >= 10 then
      raise exception 'slow_down';
    end if;
    -- 10 a minute and 300 a day. Deleted replies count too.
    perform public.rate_check(v_uid, 'reply', 10, 300);
  end if;
  return new;
end
$$;

drop trigger if exists replies_before_insert on public.replies;
create trigger replies_before_insert
  before insert on public.replies
  for each row execute function public.replies_before_insert();

create or replace function public.replies_after_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if tg_op = 'INSERT' then
    update public.posts set replies = replies + 1 where id = new.post_id returning author_id into v_owner;
    perform public.award_xp(new.author_id, 8, 'reply', new.id::text);
    -- At most 20 reply notifications an hour from one person to another.
    if v_owner is not null
       and (select count(*) from public.notifications n
             where n.user_id = v_owner and n.actor_id = new.author_id and n.kind = 'reply'
               and n.created_at > now() - interval '1 hour') < 20 then
      perform public.add_notification(v_owner, new.author_id, 'reply', new.post_id,
                                      jsonb_build_object('excerpt', left(new.body, 80)));
    end if;
  elsif not old.removed then
    -- A reply a moderator removed was already taken off the count.
    update public.posts set replies = replies - 1 where id = old.post_id;
  end if;
  return null;
end
$$;

drop trigger if exists replies_after_change on public.replies;
create trigger replies_after_change
  after insert or delete on public.replies
  for each row execute function public.replies_after_change();

-- ---- follows
create or replace function public.follows_before_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.follower := auth.uid();
  end if;
  if exists (select 1 from public.profiles p where p.id = new.follower and p.is_banned) then
    raise exception 'banned';
  end if;
  if public.blocked_pair(new.follower, new.followee) then
    raise exception 'blocked';
  end if;
  return new;
end
$$;

drop trigger if exists follows_before_insert on public.follows;
create trigger follows_before_insert
  before insert on public.follows
  for each row execute function public.follows_before_insert();

create or replace function public.follows_after_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  d int := case when tg_op = 'INSERT' then 1 else -1 end;
  v_follower uuid := case when tg_op = 'INSERT' then new.follower else old.follower end;
  v_followee uuid := case when tg_op = 'INSERT' then new.followee else old.followee end;
begin
  update public.profiles p
     set following_count = p.following_count + case when p.id = v_follower then d else 0 end,
         followers_count = p.followers_count + case when p.id = v_followee then d else 0 end
   where p.id in (v_follower, v_followee);
  if tg_op = 'INSERT' and public.award_xp(v_follower, 3, 'follow', v_followee::text) then
    perform public.add_notification(v_followee, v_follower, 'follow');
  end if;
  return null;
end
$$;

drop trigger if exists follows_after_change on public.follows;
create trigger follows_after_change
  after insert or delete on public.follows
  for each row execute function public.follows_after_change();

-- ---- blocks: blocking ends follows in both directions.
create or replace function public.blocks_after_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  delete from public.follows f
   where (f.follower = new.blocker and f.followee = new.blocked)
      or (f.follower = new.blocked and f.followee = new.blocker);
  return null;
end
$$;

drop trigger if exists blocks_after_insert on public.blocks;
create trigger blocks_after_insert
  after insert on public.blocks
  for each row execute function public.blocks_after_insert();

-- ---- reports: max 20 per reporter per day. Keeps a copy of what was
-- reported and who wrote it, in case they delete it.
create or replace function public.reports_before_insert()
returns trigger
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is not null then
    new.reporter := v_uid;
    new.status := 'open';
    perform pg_advisory_xact_lock(hashtext('bensocial.reports'), hashtext(v_uid::text));
    if (select count(*) from public.reports r
         where r.reporter = v_uid and r.created_at > now() - interval '1 day') >= 20 then
      raise exception 'slow_down';
    end if;
  end if;
  new.target_user := null;
  new.content := null;
  if new.post_id is not null then
    select p.author_id, p.body into new.target_user, new.content from public.posts p where p.id = new.post_id;
  elsif new.reply_id is not null then
    select r.author_id, r.body into new.target_user, new.content from public.replies r where r.id = new.reply_id;
  elsif new.profile_id is not null then
    select p.id, p.name || case when p.bio <> '' then E'\n' || p.bio else '' end
      into new.target_user, new.content
      from public.profiles p where p.id = new.profile_id;
  end if;
  new.target_handle := (select p.handle from public.profiles p where p.id = new.target_user);
  return new;
end
$$;

drop trigger if exists reports_before_insert on public.reports;
create trigger reports_before_insert
  before insert on public.reports
  for each row execute function public.reports_before_insert();


-- =====================================================================
-- 6. RPCs (called from the app with supabase.rpc)
-- Errors are raised as plain codes the app maps to messages:
--   not_authenticated, not_found, bad_amount, insufficient_clout, own_post,
--   already_claimed, duel_closed, already_voted, bad_date, slow_down, banned,
--   not_admin, bad_side, handle_taken, blocked
-- plus not_allowed (admin tried to ban themselves), bad_status
-- (mod_resolve_report got an unknown status), bad_switch (mod_set_switch got
-- a switch it can't change), ads_off (ads are switched off in
-- public.settings), edit_limit (a post already has 50 edits) and
-- name_reserved (a name with "BenSocial" in it).
-- =====================================================================

-- Sign-up form check. Works without an account. Reserved handles count as taken.
create or replace function public.handle_available(p_handle text)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce(lower(btrim(p_handle)) ~ '^[a-z0-9._]{3,20}$', false)
     and not exists (select 1 from public.profiles p where p.handle = lower(btrim(p_handle)))
     and not public.handle_reserved(p_handle)
$$;

-- Home feed. Runs as the caller, so RLS hides removed posts, banned
-- authors and blocks (moderators still see people who blocked them). Adds:
-- not muted, and from the last 7 days unless you follow the author or wrote it.
create or replace function public.feed(p_limit int default 200)
returns table (
  id bigint, author_id uuid, body text, mood text, spicy real, wholesome real,
  created_at timestamptz, edited_at timestamptz,
  likes int, dislikes int, replies int, reposts int,
  price numeric, price_history numeric[], shares_outstanding numeric, edit_count int,
  author_handle text, author_name text, author_hue int, author_pro boolean,
  my_reaction text, reposted boolean, removed boolean
)
language sql stable security invoker
set search_path = public
as $$
  select p.id, p.author_id, p.body, p.mood, p.spicy, p.wholesome,
         p.created_at, p.edited_at,
         p.likes, p.dislikes, p.replies, p.reposts,
         p.price::numeric, p.price_history::numeric[], p.shares_outstanding::numeric,
         (select count(*)::int from public.post_edits e where e.post_id = p.id),
         a.handle, a.name, a.hue, a.pro,
         (select r.kind from public.reactions r where r.post_id = p.id and r.user_id = auth.uid()),
         exists (select 1 from public.reposts rp where rp.post_id = p.id and rp.user_id = auth.uid()),
         p.removed
    from public.posts p
    join public.profiles a on a.id = p.author_id
   where not p.removed
     and not a.is_banned
     and (public.is_admin() or not public.is_blocked_with(p.author_id))
     and not exists (select 1 from public.mutes m
                      where m.user_id = auth.uid() and m.muted_id = p.author_id)
     and (p.created_at > now() - interval '7 days'
          or p.author_id = auth.uid()
          or exists (select 1 from public.follows f
                      where f.follower = auth.uid() and f.followee = p.author_id))
   order by p.created_at desc, p.id desc
   limit greatest(1, least(coalesce(p_limit, 200), 300))
$$;

-- One person's posts (for the person view). Mutes do not apply here.
-- Admins also get that person's removed posts, flagged by "removed", and
-- the posts of people who blocked them.
create or replace function public.posts_by(p_author uuid, p_limit int default 50)
returns table (
  id bigint, author_id uuid, body text, mood text, spicy real, wholesome real,
  created_at timestamptz, edited_at timestamptz,
  likes int, dislikes int, replies int, reposts int,
  price numeric, price_history numeric[], shares_outstanding numeric, edit_count int,
  author_handle text, author_name text, author_hue int, author_pro boolean,
  my_reaction text, reposted boolean, removed boolean
)
language sql stable security invoker
set search_path = public
as $$
  select p.id, p.author_id, p.body, p.mood, p.spicy, p.wholesome,
         p.created_at, p.edited_at,
         p.likes, p.dislikes, p.replies, p.reposts,
         p.price::numeric, p.price_history::numeric[], p.shares_outstanding::numeric,
         (select count(*)::int from public.post_edits e where e.post_id = p.id),
         a.handle, a.name, a.hue, a.pro,
         (select r.kind from public.reactions r where r.post_id = p.id and r.user_id = auth.uid()),
         exists (select 1 from public.reposts rp where rp.post_id = p.id and rp.user_id = auth.uid()),
         p.removed
    from public.posts p
    join public.profiles a on a.id = p.author_id
   where p.author_id = p_author
     and (not p.removed or public.is_admin())
     and not a.is_banned
     and (public.is_admin() or not public.is_blocked_with(p.author_id))
   order by p.created_at desc, p.id desc
   limit greatest(1, least(coalesce(p_limit, 50), 300))
$$;

-- Daily streak. p_today is the caller's local date (within a day of UTC).
-- The app calls this on every start, so it also repairs a missing profile
-- (sign-up never fails, even if the profile insert did).
create or replace function public.touch_streak(p_today date)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  me public.profiles%rowtype;
  v_new boolean;
begin
  if v_uid is not null
     and not exists (select 1 from public.profiles p where p.id = v_uid)
     and exists (select 1 from auth.users u where u.id = v_uid) then
    perform public.create_profile(v_uid, (select u.raw_user_meta_data from auth.users u where u.id = v_uid));
  end if;
  v_uid := public.req_user(true);
  if p_today is null or p_today < current_date - 1 or p_today > current_date + 1 then
    raise exception 'bad_date';
  end if;
  select * into me from public.profiles where id = v_uid for update;
  -- Same day (or a date we already counted): no change. A new date counts
  -- unless two already did in the last 20 hours (see claim_slot).
  v_new := me.last_active is null or me.last_active < p_today;
  if v_new then
    v_new := public.claim_slot(v_uid, 'streak');
  end if;
  if v_new then
    update public.profiles
       set streak = case when last_active = p_today - 1 then streak + 1 else 1 end,
           last_active = p_today,
           active_days = (
             select coalesce(array_agg(d order by d), '{}')
               from (select distinct u.d from unnest(active_days || p_today) as u(d)
                      order by u.d desc limit 30) recent
           )
     where id = v_uid
    returning * into me;
  end if;
  return json_build_object('streak', me.streak, 'active_days', me.active_days,
                           'last_active', me.last_active);
end
$$;

-- Daily drop: 40-160 clout and 20 XP, once per local day. Pro doubles it,
-- but only while payments are on (public.settings), since Pro is a paid perk.
create or replace function public.claim_daily_drop(p_today date)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user();
  me public.profiles%rowtype;
  v_amount int;
  v_double boolean;
begin
  if p_today is null or p_today < current_date - 1 or p_today > current_date + 1 then
    raise exception 'bad_date';
  end if;
  select * into me from public.profiles where id = v_uid for update;
  -- Each claim needs a later local date than the last one, and at most two
  -- fit in 20 hours, so a date a day either side cannot turn one real day
  -- into three drops.
  if me.drop_day is not null and me.drop_day >= p_today then
    raise exception 'already_claimed';
  end if;
  if not public.claim_slot(v_uid, 'drop') then
    raise exception 'already_claimed';
  end if;
  v_double := me.pro and public.payments_enabled();
  v_amount := (40 + floor(random() * 121))::int * case when v_double then 2 else 1 end;
  update public.profiles set clout = clout + v_amount, drop_day = p_today where id = v_uid;
  perform public.award_xp(v_uid, 20, 'drop', p_today::text);
  select * into me from public.profiles where id = v_uid;
  return json_build_object('amount', v_amount, 'clout', me.clout, 'xp', me.xp, 'doubled', v_double);
end
$$;

-- Clout Market: buy shares of a post with clout along the bonding curve.
create or replace function public.back_post(p_post bigint, p_amount numeric)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user();
  v_amount numeric := round(p_amount, 2);
  v_post public.posts%rowtype;
  v_clout numeric;
  v_base numeric;
  v_spot numeric;
  v_shares numeric;
  v_price numeric;
begin
  if v_amount is null or v_amount < 10 or v_amount > 100000 then
    raise exception 'bad_amount';
  end if;
  select * into v_post from public.posts where id = p_post for update;
  if not found or v_post.removed
     or exists (select 1 from public.profiles a where a.id = v_post.author_id and a.is_banned) then
    raise exception 'not_found';
  end if;
  if v_post.author_id = v_uid then
    raise exception 'own_post';
  end if;
  if public.blocked_pair(v_uid, v_post.author_id) then
    raise exception 'blocked';
  end if;
  select clout into v_clout from public.profiles where id = v_uid for update;
  if v_clout < v_amount then
    raise exception 'insufficient_clout';
  end if;

  -- delta = (-(a+b*s) + sqrt((a+b*s)^2 + 2*b*M)) / b, written in the
  -- equivalent form 2M / ((a+b*s) + sqrt((a+b*s)^2 + 2*b*M)) for precision.
  -- Rounded down so a buy and an immediate sell never gains clout.
  v_base := public.market_base(v_post.likes, v_post.dislikes, v_post.replies, v_post.reposts);
  v_spot := v_base + 0.05 * v_post.shares_outstanding;
  v_shares := trunc(2 * v_amount / (v_spot + sqrt(v_spot * v_spot + 2 * 0.05 * v_amount)), 6);
  if v_shares <= 0 then
    raise exception 'bad_amount';
  end if;

  update public.posts set shares_outstanding = shares_outstanding + v_shares, reserve = reserve + v_amount
   where id = p_post returning price into v_price;
  insert into public.positions as pos (user_id, post_id, shares, cost, updated_at)
  values (v_uid, p_post, v_shares, v_amount, now())
  on conflict (user_id, post_id) do update
    set shares = pos.shares + excluded.shares,
        cost = pos.cost + excluded.cost,
        updated_at = now();
  update public.profiles set clout = clout - v_amount where id = v_uid;

  -- XP and a note for the author on your first back of this post only, so
  -- backing and selling over and over cannot flood their notifications.
  if public.award_xp(v_uid, 10, 'back', p_post::text) then
    perform public.add_notification(v_post.author_id, v_uid, 'back', p_post,
                                    jsonb_build_object('amount', v_amount));
  end if;

  select clout into v_clout from public.profiles where id = v_uid;
  return json_build_object('shares', v_shares, 'spent', v_amount, 'price', v_price, 'clout', v_clout);
end
$$;

-- Clout Market: sell the whole position.
-- proceeds = a*h + b*h*(2*s - h)/2, rounded down to the cent.
create or replace function public.sell_position(p_post bigint)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user(true);
  v_post public.posts%rowtype;
  v_pos public.positions%rowtype;
  v_base numeric;
  v_s numeric;
  v_h numeric;
  v_proceeds numeric;
  v_clout numeric;
begin
  select * into v_post from public.posts where id = p_post for update;
  if not found then
    raise exception 'not_found';
  end if;
  select * into v_pos from public.positions where user_id = v_uid and post_id = p_post for update;
  if not found or v_pos.shares <= 0 then
    raise exception 'not_found';
  end if;

  v_base := public.market_base(v_post.likes, v_post.dislikes, v_post.replies, v_post.reposts);
  v_s := v_post.shares_outstanding;
  v_h := least(v_pos.shares, v_s);
  v_proceeds := greatest(0, trunc(v_base * v_h + 0.05 * v_h * (2 * v_s - v_h) / 2, 2));

  update public.posts set shares_outstanding = greatest(0, shares_outstanding - v_h), reserve = reserve - v_proceeds
   where id = p_post;
  delete from public.positions where user_id = v_uid and post_id = p_post;
  update public.profiles set clout = clout + v_proceeds where id = v_uid returning clout into v_clout;

  return json_build_object('proceeds', v_proceeds, 'profit', v_proceeds - v_pos.cost, 'clout', v_clout);
end
$$;

-- Active duels plus those that ended in the last 24 hours, soonest end first.
create or replace function public.list_duels()
returns table (
  id bigint, title text,
  a_label text, a_take text, a_user uuid, a_handle text, a_name text, a_hue int,
  b_label text, b_take text, b_user uuid, b_handle text, b_name text, b_hue int,
  a_votes int, b_votes int, starts_at timestamptz, ends_at timestamptz, settled boolean,
  my_side text
)
language sql stable security invoker
set search_path = public
as $$
  select d.id, d.title,
         d.a_label, d.a_take, d.a_user, pa.handle, pa.name, pa.hue,
         d.b_label, d.b_take, d.b_user, pb.handle, pb.name, pb.hue,
         d.a_votes, d.b_votes, d.starts_at, d.ends_at, d.settled,
         (select v.side from public.duel_votes v where v.duel_id = d.id and v.user_id = auth.uid())
    from public.duels d
    left join public.profiles pa on pa.id = d.a_user
    left join public.profiles pb on pb.id = d.b_user
   where d.starts_at <= now()
     and d.ends_at > now() - interval '24 hours'
   order by d.ends_at asc, d.id asc
$$;

create or replace function public.vote_duel(p_duel bigint, p_side text)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user();
  v_duel public.duels%rowtype;
begin
  if p_side is null or p_side not in ('a', 'b') then
    raise exception 'bad_side';
  end if;
  select * into v_duel from public.duels where id = p_duel for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_duel.settled or v_duel.ends_at <= now() or v_duel.starts_at > now() then
    raise exception 'duel_closed';
  end if;
  insert into public.duel_votes (user_id, duel_id, side) values (v_uid, p_duel, p_side)
  on conflict do nothing;
  if not found then
    raise exception 'already_voted';
  end if;
  update public.duels
     set a_votes = a_votes + (p_side = 'a')::int,
         b_votes = b_votes + (p_side = 'b')::int
   where id = p_duel
  returning * into v_duel;
  perform public.award_xp(v_uid, 5, 'vote', p_duel::text);
  return json_build_object('a_votes', v_duel.a_votes, 'b_votes', v_duel.b_votes, 'side', p_side);
end
$$;

-- Pays out every ended, unsettled duel exactly once. Safe to call often.
create or replace function public.settle_duels()
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_duel record;
  v_winner text;
  n int := 0;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated';
  end if;
  for v_duel in
    select * from public.duels
     where not settled and ends_at <= now()
     order by id
     for update skip locked
  loop
    v_winner := case when v_duel.a_votes > v_duel.b_votes then 'a'
                     when v_duel.b_votes > v_duel.a_votes then 'b' end;
    if v_winner is null then
      insert into public.notifications (user_id, kind, data)
      select v.user_id, 'duel_lost', jsonb_build_object('title', v_duel.title, 'tie', true)
        from public.duel_votes v
       where v.duel_id = v_duel.id;
    else
      update public.profiles p
         set clout = p.clout + 100
        from public.duel_votes v
       where v.duel_id = v_duel.id and v.side = v_winner and p.id = v.user_id;
      insert into public.notifications (user_id, kind, data)
      select v.user_id,
             case when v.side = v_winner then 'duel_won' else 'duel_lost' end,
             case when v.side = v_winner
                  then jsonb_build_object('title', v_duel.title, 'clout', 100)
                  else jsonb_build_object('title', v_duel.title) end
        from public.duel_votes v
       where v.duel_id = v_duel.id;
    end if;
    update public.duels set settled = true where id = v_duel.id;
    n := n + 1;
  end loop;
  return n;
end
$$;

create or replace function public.mark_notifications_read()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user(true);
begin
  update public.notifications set read = true where user_id = v_uid and not read;
end
$$;

create or replace function public.unread_count()
returns int
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user(true);
begin
  -- Notifications from people you blocked or who blocked you are hidden, so they are not counted.
  return (select count(*)::int from public.notifications n
           where n.user_id = v_uid and not n.read
             and (n.actor_id is null or not public.blocked_pair(v_uid, n.actor_id)));
end
$$;

create or replace function public.my_stats()
returns json
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user(true);
begin
  return json_build_object(
    'posts',       (select count(*) from public.posts where author_id = v_uid),
    'replies',     (select count(*) from public.replies where author_id = v_uid),
    'backs',       (select count(*) from public.xp_log where user_id = v_uid and reason = 'back'),
    'votes',       (select count(*) from public.duel_votes where user_id = v_uid),
    'edits',       (select count(*) from public.post_edits e
                      join public.posts p on p.id = e.post_id where p.author_id = v_uid),
    'likes_given', (select count(*) from public.reactions where user_id = v_uid and kind = 'like'),
    'reposts',     (select count(*) from public.reposts where user_id = v_uid)
  );
end
$$;

-- Deletes the caller's account. Everything they own goes with it. A banned
-- account's ban stays behind (public.bans), so deleting is not a way back in.
create or replace function public.delete_my_account()
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if exists (select 1 from public.profiles p where p.id = v_uid and p.is_banned) then
    perform public.record_ban(v_uid);
  end if;
  delete from auth.users where id = v_uid;
end
$$;

-- The caller's own profile, every column. Other people's profiles only show
-- their public columns (see section 8), so the app reads its own row here.
create or replace function public.my_profile()
returns json
language sql stable security definer
set search_path = public
as $$
  select row_to_json(p) from public.profiles p where p.id = auth.uid()
$$;

-- The monetization switches (public.settings), for the app: {"ads": bool,
-- "payments": bool}. The app reads them when it starts and every 30 seconds.
-- They say only whether a feature is on.
create or replace function public.app_switches()
returns json
language sql stable security definer
set search_path = public
as $$
  select json_build_object('ads', public.ads_enabled(), 'payments', public.payments_enabled())
$$;

-- Find people by handle or name. An empty query lists the newest members.
-- Skips you, banned accounts and anyone on either side of a block.
create or replace function public.search_people(p_query text default '', p_limit int default 20)
returns table (
  id uuid, handle text, name text, hue int, bio text, pro boolean,
  followers_count int, following_count int
)
language sql stable security invoker
set search_path = public
as $$
  with q as (
    select lower(btrim(coalesce(p_query, ''))) as t,
           ltrim(lower(btrim(coalesce(p_query, ''))), '@') as h
  )
  select p.id, p.handle, p.name, p.hue, p.bio, p.pro, p.followers_count, p.following_count
    from public.profiles p, q
   where p.id is distinct from auth.uid()
     and not p.is_banned
     and not public.is_blocked_with(p.id)
     and (q.t = '' or (q.h <> '' and strpos(p.handle, q.h) > 0) or strpos(lower(p.name), q.t) > 0)
   order by (q.h <> '' and p.handle = q.h) desc,
            (q.h <> '' and left(p.handle, length(q.h)) = q.h) desc,
            case when q.t = '' then p.created_at end desc nulls last,
            p.followers_count desc, p.handle
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;

-- HELD: ads. Credits the viewer 70% of the bid, once per ad per local day
-- (and at most twice in 20 hours, like claim_slot). Pays nothing at all
-- unless public.settings.ads_enabled is on (raises ads_off). Only active ads
-- whose bid meets the viewer's attention price pay.
create or replace function public.record_ad_view(p_ad bigint, p_today date)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_uid uuid := public.req_user();
  v_ad public.ads%rowtype;
  v_price int;
  v_earned numeric := 0;
  v_total numeric;
begin
  if not public.ads_enabled() then
    raise exception 'ads_off';
  end if;
  if p_today is null or p_today < current_date - 1 or p_today > current_date + 1 then
    raise exception 'bad_date';
  end if;
  select * into v_ad from public.ads where id = p_ad and active;
  if not found then
    raise exception 'not_found';
  end if;
  select ad_price_cents into v_price from public.profiles where id = v_uid for update;
  if v_ad.bid_cents >= v_price
     and not exists (select 1 from public.ad_views w
                      where w.user_id = v_uid and w.ad_id = p_ad and w.day >= p_today)
     and (select count(*) from public.ad_views w
           where w.user_id = v_uid and w.ad_id = p_ad and w.created_at > now() - interval '20 hours') < 2 then
    v_earned := round(v_ad.bid_cents * 0.70, 2);
    insert into public.ad_views (user_id, ad_id, day, earned_cents)
    values (v_uid, p_ad, p_today, v_earned);
    update public.profiles set earnings_cents = earnings_cents + v_earned where id = v_uid;
  end if;
  select earnings_cents into v_total from public.profiles where id = v_uid;
  return json_build_object('earned_cents', v_earned, 'earnings_cents', v_total);
end
$$;

-- ---- Moderation (admins only)

-- Open reports, oldest first. target_kind is 'post', 'reply', 'profile',
-- or 'gone' when the reported content has since been deleted. Gone reports
-- still carry the copy taken when they were filed (content, author), so a
-- moderator can read them and ban the author. post_removed is whether the
-- reported post or reply is removed.
create or replace function public.mod_open_reports()
returns table (
  report_id bigint, reason text, details text, status text, created_at timestamptz,
  reporter_handle text, target_kind text, post_id bigint, reply_id bigint, profile_id uuid,
  content text, target_user uuid, target_handle text, target_banned boolean, post_removed boolean
)
language plpgsql stable security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  perform public.req_admin();
  return query
  select r.id, r.reason, r.details, r.status, r.created_at,
         rp.handle,
         case when r.post_id is not null then 'post'
              when r.reply_id is not null then 'reply'
              when r.profile_id is not null then 'profile'
              else 'gone' end,
         r.post_id, r.reply_id, r.profile_id,
         case when r.post_id is not null then po.body
              when r.reply_id is not null then re.body
              when r.profile_id is not null then
                pr.name || case when pr.bio <> '' then E'\n' || pr.bio else '' end
              else r.content
         end,
         tu.id, coalesce(tu.handle, r.target_handle), tu.is_banned,
         case when r.post_id is not null then po.removed
              when r.reply_id is not null then re.removed end
    from public.reports r
    left join public.profiles rp on rp.id = r.reporter
    left join public.posts po on po.id = r.post_id
    left join public.replies re on re.id = r.reply_id
    left join public.profiles pr on pr.id = r.profile_id
    left join public.profiles tu on tu.id = coalesce(po.author_id, re.author_id, pr.id, r.target_user)
   where r.status = 'open'
   order by r.created_at asc, r.id asc;
end
$$;

create or replace function public.mod_set_post_removed(p_post bigint, p_removed boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
  v_author uuid;
  v_was boolean;
begin
  select author_id, removed into v_author, v_was from public.posts where id = p_post for update;
  if not found then
    raise exception 'not_found';
  end if;
  update public.posts set removed = coalesce(p_removed, true) where id = p_post;
  if coalesce(p_removed, true) and not v_was then
    perform public.add_notification(v_author, null, 'mod', p_post,
                                    jsonb_build_object('action', 'removed'));
  end if;
end
$$;

create or replace function public.mod_set_banned(p_user uuid, p_banned boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
begin
  -- Admins can neither ban nor unban themselves.
  if p_user = v_admin then
    raise exception 'not_allowed';
  end if;
  update public.profiles set is_banned = coalesce(p_banned, true) where id = p_user;
  if not found then
    raise exception 'not_found';
  end if;
  -- The ban outlives the account (see public.bans); unbanning clears it.
  if coalesce(p_banned, true) then
    perform public.record_ban(p_user);
  else
    delete from public.bans where user_id = p_user;
  end if;
end
$$;

-- Removes (or restores) one reply. Its author is told when it is removed.
create or replace function public.mod_set_reply_removed(p_reply bigint, p_removed boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
  v_reply public.replies%rowtype;
  v_on boolean := coalesce(p_removed, true);
begin
  select * into v_reply from public.replies where id = p_reply for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_reply.removed = v_on then
    return;
  end if;
  update public.replies set removed = v_on where id = p_reply;
  update public.posts set replies = greatest(0, replies + case when v_on then -1 else 1 end) where id = v_reply.post_id;
  if v_on then
    perform public.add_notification(v_reply.author_id, null, 'mod', v_reply.post_id,
                                    jsonb_build_object('action', 'reply_removed'));
  end if;
end
$$;

-- Clears a profile someone reported: the name goes back to the handle and
-- the bio is emptied. The person is told.
create or replace function public.mod_reset_profile(p_user uuid)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
begin
  update public.profiles set name = handle, bio = '' where id = p_user;
  if not found then
    raise exception 'not_found';
  end if;
  perform public.add_notification(p_user, null, 'mod', null, jsonb_build_object('action', 'profile_reset'));
end
$$;

create or replace function public.mod_resolve_report(p_report bigint, p_status text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
begin
  if p_status is null or p_status not in ('open', 'dismissed', 'actioned') then
    raise exception 'bad_status';
  end if;
  update public.reports set status = p_status where id = p_report;
  if not found then
    raise exception 'not_found';
  end if;
end
$$;

-- Creates a duel. Handles (with or without @) link a side to a person.
-- p_hours outside 1-72 raises bad_amount.
create or replace function public.mod_create_duel(
  p_title text, p_a_label text, p_a_take text, p_b_label text, p_b_take text,
  p_hours int, p_a_handle text default null, p_b_handle text default null)
returns bigint
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
  v_a public.profiles%rowtype;
  v_b public.profiles%rowtype;
  v_id bigint;
begin
  if p_hours is null or p_hours < 1 or p_hours > 72 then
    raise exception 'bad_amount';
  end if;
  if nullif(btrim(p_a_handle), '') is not null then
    select * into v_a from public.profiles where handle = lower(ltrim(btrim(p_a_handle), '@'));
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  if nullif(btrim(p_b_handle), '') is not null then
    select * into v_b from public.profiles where handle = lower(ltrim(btrim(p_b_handle), '@'));
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  insert into public.duels (title, a_user, a_label, a_take, b_user, b_label, b_take,
                            starts_at, ends_at, created_by)
  values (btrim(p_title),
          v_a.id, coalesce(nullif(btrim(p_a_label), ''), v_a.name), btrim(p_a_take),
          v_b.id, coalesce(nullif(btrim(p_b_label), ''), v_b.name), btrim(p_b_take),
          now(), now() + make_interval(hours => p_hours), v_admin)
  returning id into v_id;
  return v_id;
end
$$;

-- The Switchboard in the Moderation view: turns ads on or off for everyone
-- (public.settings.ads_enabled) and returns app_switches(). Ads are the only
-- switch here. Payments need a payment processor first (docs/GO-LIVE.md), so
-- payments_enabled changes only in the SQL editor: p_name 'payments', or
-- anything else, raises bad_switch.
create or replace function public.mod_set_switch(p_name text, p_on boolean)
returns json
language plpgsql security definer
set search_path = public
as $$
declare
  v_admin uuid := public.req_admin();
begin
  if p_name is distinct from 'ads' or p_on is null then
    raise exception 'bad_switch';
  end if;
  insert into public.settings (id, ads_enabled) values (true, p_on)
  on conflict (id) do update set ads_enabled = excluded.ads_enabled, updated_at = now();
  return public.app_switches();
end
$$;


-- =====================================================================
-- 7. ROW LEVEL SECURITY
-- =====================================================================

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.post_edits enable row level security;
alter table public.reactions enable row level security;
alter table public.reposts enable row level security;
alter table public.replies enable row level security;
alter table public.follows enable row level security;
alter table public.mutes enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.notifications enable row level security;
alter table public.positions enable row level security;
alter table public.duels enable row level security;
alter table public.duel_votes enable row level security;
alter table public.xp_log enable row level security;
alter table public.ads enable row level security;
alter table public.ad_views enable row level security;
alter table public.settings enable row level security;
alter table public.bans enable row level security;
alter table public.write_log enable row level security;

-- profiles: everyone signed in can read; you can edit your own row.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- posts. Moderators also see removed posts, and posts by people who blocked them.
drop policy if exists posts_select on public.posts;
create policy posts_select on public.posts
  for select to authenticated using (
    (not removed or (select public.is_admin()))
    and not exists (select 1 from public.profiles a where a.id = posts.author_id and a.is_banned)
    and ((select public.is_admin()) or not public.is_blocked_with(author_id))
  );
drop policy if exists posts_insert_own on public.posts;
create policy posts_insert_own on public.posts
  for insert to authenticated with check (author_id = (select auth.uid()));
drop policy if exists posts_update_own on public.posts;
create policy posts_update_own on public.posts
  for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
drop policy if exists posts_delete_own on public.posts;
create policy posts_delete_own on public.posts
  for delete to authenticated using (author_id = (select auth.uid()));

-- post_edits: readable when the post is.
drop policy if exists post_edits_select on public.post_edits;
create policy post_edits_select on public.post_edits
  for select to authenticated using (
    exists (select 1 from public.posts p where p.id = post_edits.post_id)
  );

-- reactions: your own only. Reacting needs a post you can see.
drop policy if exists reactions_select_own on public.reactions;
create policy reactions_select_own on public.reactions
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists reactions_insert_own on public.reactions;
create policy reactions_insert_own on public.reactions
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.posts p where p.id = reactions.post_id)
  );
drop policy if exists reactions_update_own on public.reactions;
create policy reactions_update_own on public.reactions
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists reactions_delete_own on public.reactions;
create policy reactions_delete_own on public.reactions
  for delete to authenticated using (user_id = (select auth.uid()));

-- reposts: same rules as reactions.
drop policy if exists reposts_select_own on public.reposts;
create policy reposts_select_own on public.reposts
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists reposts_insert_own on public.reposts;
create policy reposts_insert_own on public.reposts
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.posts p where p.id = reposts.post_id)
  );
drop policy if exists reposts_delete_own on public.reposts;
create policy reposts_delete_own on public.reposts
  for delete to authenticated using (user_id = (select auth.uid()));

-- replies
drop policy if exists replies_select on public.replies;
create policy replies_select on public.replies
  for select to authenticated using (
    not removed
    and exists (select 1 from public.posts p where p.id = replies.post_id)
    and not exists (select 1 from public.profiles a where a.id = replies.author_id and a.is_banned)
    and ((select public.is_admin()) or not public.is_blocked_with(author_id))
  );
drop policy if exists replies_insert_own on public.replies;
create policy replies_insert_own on public.replies
  for insert to authenticated with check (
    author_id = (select auth.uid())
    and exists (select 1 from public.posts p where p.id = replies.post_id)
  );
drop policy if exists replies_delete_own on public.replies;
create policy replies_delete_own on public.replies
  for delete to authenticated using (author_id = (select auth.uid()));

-- follows: public graph; you manage your own follows.
drop policy if exists follows_select on public.follows;
create policy follows_select on public.follows
  for select to authenticated using (true);
drop policy if exists follows_insert_own on public.follows;
create policy follows_insert_own on public.follows
  for insert to authenticated with check (follower = (select auth.uid()));
drop policy if exists follows_delete_own on public.follows;
create policy follows_delete_own on public.follows
  for delete to authenticated using (follower = (select auth.uid()));

-- mutes and blocks: private to their owner.
drop policy if exists mutes_select_own on public.mutes;
create policy mutes_select_own on public.mutes
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists mutes_insert_own on public.mutes;
create policy mutes_insert_own on public.mutes
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists mutes_delete_own on public.mutes;
create policy mutes_delete_own on public.mutes
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists blocks_select_own on public.blocks;
create policy blocks_select_own on public.blocks
  for select to authenticated using (blocker = (select auth.uid()));
drop policy if exists blocks_insert_own on public.blocks;
create policy blocks_insert_own on public.blocks
  for insert to authenticated with check (blocker = (select auth.uid()));
drop policy if exists blocks_delete_own on public.blocks;
create policy blocks_delete_own on public.blocks
  for delete to authenticated using (blocker = (select auth.uid()));

-- reports: file your own (exactly one target); read your own; admins read and resolve all.
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports
  for select to authenticated using (reporter = (select auth.uid()) or (select public.is_admin()));
drop policy if exists reports_insert_own on public.reports;
create policy reports_insert_own on public.reports
  for insert to authenticated with check (
    reporter = (select auth.uid())
    and num_nonnulls(post_id, reply_id, profile_id) = 1
  );
drop policy if exists reports_update_admin on public.reports;
create policy reports_update_admin on public.reports
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- notifications, positions, duel votes, ad views: read your own. Written by the server.
-- Notifications from someone on either side of a block are hidden, old ones too.
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated using (
    user_id = (select auth.uid())
    and (actor_id is null or not public.is_blocked_with(actor_id))
  );

drop policy if exists positions_select_own on public.positions;
create policy positions_select_own on public.positions
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists duel_votes_select_own on public.duel_votes;
create policy duel_votes_select_own on public.duel_votes
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists ad_views_select_own on public.ad_views;
create policy ad_views_select_own on public.ad_views
  for select to authenticated using (user_id = (select auth.uid()));

-- duels: everyone signed in can read.
drop policy if exists duels_select on public.duels;
create policy duels_select on public.duels
  for select to authenticated using (true);

-- ads (HELD): active ads are readable while ads are on (public.settings);
-- admins manage all ads.
drop policy if exists ads_select on public.ads;
create policy ads_select on public.ads
  for select to authenticated using ((active and (select public.ads_enabled())) or (select public.is_admin()));
drop policy if exists ads_admin_insert on public.ads;
create policy ads_admin_insert on public.ads
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists ads_admin_update on public.ads;
create policy ads_admin_update on public.ads
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists ads_admin_delete on public.ads;
create policy ads_admin_delete on public.ads
  for delete to authenticated using ((select public.is_admin()));

-- xp_log, settings, bans and write_log have RLS on and no policies: no client access at all.


-- =====================================================================
-- 8. TABLE AND COLUMN PRIVILEGES
-- Supabase grants ALL to anon and authenticated on new tables. Take it
-- back, then grant exactly what the app uses. anon gets no table access.
-- =====================================================================

revoke all on table
  public.profiles, public.posts, public.post_edits, public.reactions, public.reposts,
  public.replies, public.follows, public.mutes, public.blocks, public.reports,
  public.notifications, public.positions, public.duels, public.duel_votes,
  public.xp_log, public.ads, public.ad_views, public.settings, public.bans, public.write_log
from anon, authenticated;

grant select on table
  public.posts, public.post_edits, public.reactions, public.reposts,
  public.replies, public.follows, public.mutes, public.blocks,
  public.notifications, public.positions, public.duels, public.duel_votes,
  public.ads, public.ad_views
to authenticated;

-- Profiles: everyone signed in sees only the public columns. Your own XP,
-- clout, streak, settings, earnings and admin flag come from my_profile().
grant select (id, handle, name, hue, bio, pro, followers_count, following_count, is_banned, created_at)
  on public.profiles to authenticated;
-- Reports: reporters see what they filed, not the server's copy of the content.
grant select (id, reporter, post_id, reply_id, profile_id, reason, details, status, created_at)
  on public.reports to authenticated;

grant update (name, handle, hue, bio, dial, ad_price_cents) on public.profiles to authenticated;
grant insert (body, mood), update (body), delete on public.posts to authenticated;
-- Upserts send post_id in the update list, so it is granted; a trigger keeps it fixed.
grant insert (post_id, kind), update (post_id, kind), delete on public.reactions to authenticated;
grant insert (post_id), delete on public.reposts to authenticated;
grant insert (post_id, body), delete on public.replies to authenticated;
grant insert (followee), delete on public.follows to authenticated;
grant insert (muted_id), delete on public.mutes to authenticated;
grant insert (blocked), delete on public.blocks to authenticated;
grant insert (post_id, reply_id, profile_id, reason, details), update (status)
  on public.reports to authenticated;
grant insert (brand, hue, bid_cents, copy, why, active),
      update (brand, hue, bid_cents, copy, why, active), delete
  on public.ads to authenticated;


-- =====================================================================
-- 9. FUNCTION PRIVILEGES
-- Postgres lets PUBLIC execute every new function, and Supabase adds anon
-- and authenticated. Revoke everything, then grant the RPCs back.
-- =====================================================================

revoke execute on function
  public.xp_level(int),
  public.market_base(int, int, int, int),
  public.market_price(int, int, int, int, numeric),
  public.blocked_pair(uuid, uuid),
  public.req_user(boolean),
  public.req_admin(),
  public.add_notification(uuid, uuid, text, bigint, jsonb),
  public.award_xp(uuid, int, text, text),
  public.refund_positions(bigint),
  public.create_profile(uuid, jsonb),
  public.payments_enabled(),
  public.email_hash(text),
  public.record_ban(uuid),
  public.rate_check(uuid, text, int, int),
  public.claim_slot(uuid, text),
  public.is_admin(),
  public.is_blocked_with(uuid),
  public.ads_enabled(),
  public.handle_reserved(text),
  public.handle_new_user(),
  public.profiles_before_update(),
  public.profiles_before_delete(),
  public.posts_before_insert(),
  public.posts_after_insert(),
  public.posts_before_update(),
  public.posts_before_delete(),
  public.reactions_before_update(),
  public.reactions_after_change(),
  public.reposts_after_change(),
  public.replies_before_insert(),
  public.replies_after_change(),
  public.follows_before_insert(),
  public.follows_after_change(),
  public.blocks_after_insert(),
  public.reports_before_insert(),
  public.handle_available(text),
  public.feed(int),
  public.posts_by(uuid, int),
  public.touch_streak(date),
  public.claim_daily_drop(date),
  public.back_post(bigint, numeric),
  public.sell_position(bigint),
  public.list_duels(),
  public.vote_duel(bigint, text),
  public.settle_duels(),
  public.mark_notifications_read(),
  public.unread_count(),
  public.my_stats(),
  public.delete_my_account(),
  public.my_profile(),
  public.app_switches(),
  public.search_people(text, int),
  public.record_ad_view(bigint, date),
  public.mod_open_reports(),
  public.mod_set_post_removed(bigint, boolean),
  public.mod_set_reply_removed(bigint, boolean),
  public.mod_reset_profile(uuid),
  public.mod_set_banned(uuid, boolean),
  public.mod_resolve_report(bigint, text),
  public.mod_create_duel(text, text, text, text, text, int, text, text),
  public.mod_set_switch(text, boolean)
from public, anon, authenticated;

-- The only thing a signed-out visitor can call.
grant execute on function public.handle_available(text) to anon, authenticated;

-- Used inside RLS policies and the profile trigger, so signed-in users must
-- be able to run them. They only reveal facts about the caller, whether ads
-- are on, and whether a handle is reserved.
grant execute on function public.is_admin(), public.is_blocked_with(uuid), public.ads_enabled(),
  public.handle_reserved(text) to authenticated;

grant execute on function
  public.feed(int),
  public.posts_by(uuid, int),
  public.touch_streak(date),
  public.claim_daily_drop(date),
  public.back_post(bigint, numeric),
  public.sell_position(bigint),
  public.list_duels(),
  public.vote_duel(bigint, text),
  public.settle_duels(),
  public.mark_notifications_read(),
  public.unread_count(),
  public.my_stats(),
  public.delete_my_account(),
  public.my_profile(),
  public.app_switches(),
  public.search_people(text, int),
  public.record_ad_view(bigint, date),
  public.mod_open_reports(),
  public.mod_set_post_removed(bigint, boolean),
  public.mod_set_reply_removed(bigint, boolean),
  public.mod_reset_profile(uuid),
  public.mod_set_banned(uuid, boolean),
  public.mod_resolve_report(bigint, text),
  public.mod_create_duel(text, text, text, text, text, int, text, text),
  public.mod_set_switch(text, boolean)
to authenticated;


-- =====================================================================
-- 10. BACKFILL
-- Accounts created before this script ran get their profile now.
-- =====================================================================

do $$
begin
  perform public.create_profile(u.id, u.raw_user_meta_data)
     from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id);
  -- Accounts banned before bans could outlive an account.
  perform public.record_ban(p.id)
     from public.profiles p
    where p.is_banned and not exists (select 1 from public.bans b where b.user_id = p.id);
end
$$;

-- Tell the Supabase API to pick up the new tables and functions right away.
notify pgrst, 'reload schema';
