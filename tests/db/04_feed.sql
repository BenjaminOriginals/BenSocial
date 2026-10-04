-- feed() and posts_by(): row shape, visibility rules, limits.

-- Exact FEED ROW contract used by the client.
select tst.eq(pg_get_function_result('public.feed(integer)'::regprocedure),
  'TABLE(id bigint, author_id uuid, body text, mood text, spicy real, wholesome real, '
  'created_at timestamp with time zone, edited_at timestamp with time zone, '
  'likes integer, dislikes integer, replies integer, reposts integer, '
  'price numeric, price_history numeric[], shares_outstanding numeric, edit_count integer, '
  'author_handle text, author_name text, author_hue integer, author_pro boolean, '
  'my_reaction text, reposted boolean, removed boolean)',
  'feed() returns the exact FEED ROW columns and types');
select tst.eq(pg_get_function_result('public.posts_by(uuid, integer)'::regprocedure),
              pg_get_function_result('public.feed(integer)'::regprocedure),
              'posts_by() returns the same FEED ROW');
select tst.eq(pg_get_function_identity_arguments('public.feed(integer)'::regprocedure),
              'p_limit integer', 'feed() takes p_limit');
select tst.eq(pg_get_function_arguments('public.feed(integer)'::regprocedure),
              'p_limit integer DEFAULT 200', 'feed() p_limit defaults to 200');
select tst.eq(pg_get_function_arguments('public.posts_by(uuid, integer)'::regprocedure),
              'p_author uuid, p_limit integer DEFAULT 50', 'posts_by() takes p_author, p_limit default 50');
select tst.ok((select not prosecdef and provolatile = 's' from pg_proc where oid = 'public.feed(integer)'::regprocedure),
              'feed() is security invoker and stable');

begin;
do $$
declare
  pa bigint; pb bigint; pc bigint; pe bigint; pf_old bigint; pr bigint; pa2 bigint;
  r record;
  n bigint;
begin
  pa := tst.post('alice', 'alice post', 'spicy');
  pb := tst.post('bob', 'bob post');
  pc := tst.post('carol', 'carol post');
  pe := tst.post('erin', 'erin post');
  pf_old := tst.post('frank', 'frank old post');
  pr := tst.post('gina', 'gina removed post');
  update public.posts set created_at = now() - interval '8 days' where id = pf_old;
  update public.posts set removed = true where id = pr;
  update public.profiles set is_banned = true where id = tst.uid('erin');

  -- Row values
  perform tst.login('bob');
  select * into r from public.feed() f where f.id = pa;
  perform tst.eq(r.author_handle, 'alice', 'feed row has author_handle');
  perform tst.eq(r.author_name, 'Alice Adams', 'feed row has author_name');
  perform tst.eq(r.author_hue, (select hue from public.profiles where id = tst.uid('alice')), 'feed row has author_hue');
  perform tst.eq(r.author_pro, false, 'feed row has author_pro');
  perform tst.eq(r.mood, 'spicy', 'feed row has mood');
  perform tst.eq(r.my_reaction, null::text, 'my_reaction is null before reacting');
  perform tst.eq(r.reposted, false, 'reposted is false before reposting');
  perform tst.eq(r.removed, false, 'removed is false');
  perform tst.eq(r.edit_count, 0, 'edit_count is 0');
  perform tst.eq(r.price_history, array[5]::numeric[], 'price_history is numeric[]');

  insert into public.reactions (post_id, kind) values (pa, 'dislike');
  insert into public.reposts (post_id) values (pa);
  select * into r from public.feed() f where f.id = pa;
  perform tst.eq(r.my_reaction, 'dislike', 'my_reaction shows my reaction');
  perform tst.eq(r.reposted, true, 'reposted shows my repost');
  perform tst.login('carol');
  select * into r from public.feed() f where f.id = pa;
  perform tst.eq(r.my_reaction, null::text, 'my_reaction is per viewer');
  perform tst.eq(r.reposted, false, 'reposted is per viewer');

  -- Removed and banned
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pr), 'removed post not in feed');
  perform tst.ok(not exists (select 1 from public.posts where id = pr), 'removed post not selectable');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pe), 'banned author''s post not in feed');
  perform tst.ok(not exists (select 1 from public.posts where id = pe), 'banned author''s post not selectable');
  perform tst.login('gina');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pr), 'removed post not in its author''s feed');

  -- 7-day window
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pf_old), 'post older than 7 days not in feed');
  perform tst.ok(exists (select 1 from public.posts where id = pf_old), 'old post is still selectable');
  insert into public.follows (followee) values (tst.uid('frank'));
  perform tst.ok(exists (select 1 from public.feed() f where f.id = pf_old), 'old post from someone I follow is in feed');
  perform tst.login('frank');
  perform tst.ok(exists (select 1 from public.feed() f where f.id = pf_old), 'my own old post is in my feed');

  -- Mutes: only hide from the muter's feed
  perform tst.login('alice');
  insert into public.mutes (muted_id) values (tst.uid('carol'));
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pc), 'muted author not in my feed');
  perform tst.ok(exists (select 1 from public.posts_by(tst.uid('carol')) f where f.id = pc),
                 'muted author''s profile still lists their posts');
  perform tst.login('bob');
  perform tst.ok(exists (select 1 from public.feed() f where f.id = pc), 'mute does not affect others');

  -- Blocks: both directions
  perform tst.login('alice');
  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pb), 'blocker does not see blocked user''s posts');
  perform tst.ok(not exists (select 1 from public.posts where id = pb), 'blocker cannot select blocked user''s post');
  perform tst.ok(not exists (select 1 from public.posts_by(tst.uid('bob'))), 'posts_by is empty for someone I blocked');
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pa), 'blocked user does not see blocker''s posts');
  perform tst.ok(not exists (select 1 from public.posts where id = pa), 'blocked user cannot select blocker''s post');
  perform tst.ok(not exists (select 1 from public.posts_by(tst.uid('alice'))), 'posts_by is empty for someone who blocked me');
  perform tst.login('carol');
  perform tst.ok(exists (select 1 from public.feed() f where f.id = pa) and exists (select 1 from public.feed() f where f.id = pb),
                 'a block does not affect third parties');

  -- Order: newest first
  perform tst.logout();
  pa2 := tst.post('alice', 'alice newer post');
  update public.posts set created_at = now() + interval '1 second' where id = pa2;
  perform tst.login('carol');
  perform tst.eq((select f.id from public.feed() f limit 1), pa2, 'feed is newest first');

  -- posts_by
  perform tst.eq(tst.count(format('select * from public.posts_by(%L)', tst.uid('alice'))), 2::bigint,
                 'posts_by returns that author''s posts');
  perform tst.ok(not exists (select 1 from public.posts_by(tst.uid('alice')) f where f.author_id <> tst.uid('alice')),
                 'posts_by returns no one else''s posts');
  perform tst.ok(not exists (select 1 from public.posts_by(tst.uid('gina'))), 'posts_by hides removed posts from members');
  perform tst.login('dave');
  perform tst.ok((select f.removed from public.posts_by(tst.uid('gina')) f where f.id = pr),
                 'admins see removed posts in posts_by, flagged removed');
  perform tst.ok(not exists (select 1 from public.feed() f where f.id = pr), 'admins do not get removed posts in feed');
  perform tst.ok(exists (select 1 from public.posts where id = pr), 'admins can select removed posts');
end $$;
rollback;

-- Limit clamp 1..300
begin;
insert into public.posts (author_id, body)
select (array[tst.uid('alice'), tst.uid('bob'), tst.uid('carol')])[1 + g % 3], 'bulk ' || g
  from generate_series(1, 310) g;
select tst.login('dave');
select tst.eq(tst.count('select * from public.feed()'), 200::bigint, 'feed() defaults to 200 rows');
select tst.eq(tst.count('select * from public.feed(1000)'), 300::bigint, 'feed(1000) is clamped to 300');
select tst.eq(tst.count('select * from public.feed(0)'), 1::bigint, 'feed(0) is clamped to 1');
select tst.eq(tst.count('select * from public.feed(-5)'), 1::bigint, 'feed(-5) is clamped to 1');
select tst.eq(tst.count('select * from public.feed(null)'), 200::bigint, 'feed(null) uses 200');
select tst.eq(tst.count('select * from public.feed(25)'), 25::bigint, 'feed(25) returns 25');
select tst.eq(tst.count(format('select * from public.posts_by(%L)', tst.uid('alice'))), 50::bigint,
              'posts_by() defaults to 50 rows');
rollback;

-- Not for anon
begin;
select tst.anon();
select tst.throws($q$select * from public.feed()$q$, '42501', 'anon cannot call feed()');
select tst.throws($q$select * from public.posts_by(gen_random_uuid())$q$, '42501', 'anon cannot call posts_by()');
select tst.throws($q$select * from public.posts$q$, '42501', 'anon cannot read posts');
rollback;
