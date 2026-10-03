-- Posts: ownership, column limits, mood weights, rate limits, bans, edit receipts.

begin;
do $$
declare
  p public.posts%rowtype;
  v_xp int;
begin
  perform tst.login('alice');
  v_xp := (select xp from tst.profiles where id = auth.uid());

  insert into public.posts (body, mood) values ('A spicy take', 'spicy') returning * into p;
  perform tst.eq(p.author_id, tst.uid('alice'), 'author_id defaults to the caller');
  perform tst.eq(p.spicy, 0.8::real, 'spicy mood sets spicy .8');
  perform tst.eq(p.wholesome, 0.1::real, 'spicy mood sets wholesome .1');
  perform tst.eq(p.price, 5.0000::numeric, 'new post price is 5');
  perform tst.eq(p.price_history, array[5.0000]::numeric[], 'new post price history is {5}');
  perform tst.eq(p.likes + p.dislikes + p.replies + p.reposts, 0, 'counters start at zero');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 25, 'posting gives 25 XP');

  insert into public.posts (body, mood) values ('So wholesome', 'wholesome') returning * into p;
  perform tst.eq(p.spicy, 0.05::real, 'wholesome mood sets spicy .05');
  perform tst.eq(p.wholesome, 0.85::real, 'wholesome mood sets wholesome .85');

  insert into public.posts (body, mood) values ('Is this a question?', 'question') returning * into p;
  perform tst.eq(p.spicy, 0.25::real, 'question mood sets spicy .25');
  perform tst.eq(p.wholesome, 0.35::real, 'question mood sets wholesome .35');

  insert into public.posts (body) values ('No mood at all') returning * into p;
  perform tst.ok(p.mood is null and p.spicy = 0.25::real and p.wholesome = 0.35::real,
                 'no mood sets .25 / .35');
end $$;
rollback;

-- Column limits on insert
begin;
select tst.login('alice');
select tst.throws($q$insert into public.posts (body, author_id) values ('as bob', tst.uid('bob'))$q$,
                  '42501', 'cannot insert author_id');
select tst.throws($q$insert into public.posts (body, likes) values ('free likes', 1000)$q$,
                  '42501', 'cannot insert likes');
select tst.throws($q$insert into public.posts (body, price) values ('cheap', 1)$q$,
                  '42501', 'cannot insert price');
select tst.throws($q$insert into public.posts (body, removed) values ('x', false)$q$,
                  '42501', 'cannot insert removed');
select tst.throws($q$insert into public.posts (body, created_at) values ('x', now() - interval '30 days')$q$,
                  '42501', 'cannot insert created_at');
select tst.throws($q$insert into public.posts (body, spicy) values ('x', 1)$q$,
                  '42501', 'cannot insert spicy');
select tst.throws($q$insert into public.posts (body) values ('')$q$, '23514', 'empty body rejected');
select tst.throws($q$insert into public.posts (body) values ('    ')$q$, '23514', 'blank body rejected');
select tst.throws($q$insert into public.posts (body) values (repeat('x', 501))$q$, '23514', '501-character body rejected');
select tst.lives($q$insert into public.posts (body) values (repeat('x', 500))$q$, '500-character body accepted');
select tst.throws($q$insert into public.posts (body, mood) values ('x', 'angry')$q$, '23514', 'unknown mood rejected');
rollback;

-- Update and delete ownership
begin;
do $$
declare
  v_alice bigint;
  v_bob bigint;
  n int;
begin
  v_alice := tst.post('alice', 'Alice original');
  v_bob := tst.post('bob', 'Bob original');
  perform tst.login('alice');

  perform tst.lives(format('update public.posts set body = %L where id = %s', 'Alice edited', v_alice),
                    'author can edit body');
  perform tst.throws(format('update public.posts set likes = 999 where id = %s', v_alice), '42501', 'cannot update likes');
  perform tst.throws(format('update public.posts set removed = true where id = %s', v_alice), '42501', 'cannot update removed');
  perform tst.throws(format('update public.posts set mood = %L where id = %s', 'spicy', v_alice), '42501', 'cannot update mood');
  perform tst.throws(format('update public.posts set author_id = %L where id = %s', tst.uid('bob'), v_alice), '42501', 'cannot update author_id');
  perform tst.throws(format('update public.posts set shares_outstanding = 0 where id = %s', v_alice), '42501', 'cannot update shares_outstanding');
  perform tst.throws(format('update public.posts set edited_at = null where id = %s', v_alice), '42501', 'cannot update edited_at');
  perform tst.throws(format('update public.posts set body = %L where id = %s', '', v_alice), '23514', 'cannot edit to an empty body');

  update public.posts set body = 'Hacked' where id = v_bob;
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot edit another user''s post');
  delete from public.posts where id = v_bob;
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot delete another user''s post');
  perform tst.eq((select body from public.posts where id = v_bob), 'Bob original', 'other post untouched');

  delete from public.posts where id = v_alice;
  get diagnostics n = row_count;
  perform tst.eq(n, 1, 'author can delete own post');
end $$;
rollback;

-- Banned users cannot post
begin;
update public.profiles set is_banned = true where id = tst.uid('erin');
select tst.login('erin');
select tst.throws($q$insert into public.posts (body) values ('I am banned')$q$, 'banned', 'banned user gets banned on post');
rollback;

-- Rate limit: 5 per rolling minute
begin;
select tst.login('carol');
select tst.lives($q$insert into public.posts (body) select 'post ' || g from generate_series(1, 5) g$q$,
                 'five posts in a minute are fine');
select tst.throws($q$insert into public.posts (body) values ('sixth')$q$, 'slow_down', 'sixth post in a minute is slow_down');
rollback;

-- Rate limit: 100 per day
begin;
insert into public.posts (author_id, body, created_at)
select tst.uid('carol'), 'old ' || g, now() - interval '2 hours'
  from generate_series(1, 98) g;
select tst.login('carol');
select tst.lives($q$insert into public.posts (body) values ('99'), ('100')$q$, 'posts 99 and 100 of the day are fine');
select tst.throws($q$insert into public.posts (body) values ('101')$q$, 'slow_down', 'post 101 of the day is slow_down');
rollback;

begin;
insert into public.posts (author_id, body, created_at)
select tst.uid('carol'), 'yesterday ' || g, now() - interval '25 hours'
  from generate_series(1, 100) g;
select tst.login('carol');
select tst.lives($q$insert into public.posts (body) values ('fresh day')$q$, 'posts older than a day do not count');
rollback;

-- Edit receipts
begin;
do $$
declare
  v bigint;
  v_created timestamptz;
  v_first_edit timestamptz;
  e record;
  n int;
begin
  v := tst.post('alice', 'Version one');
  -- Pretend it was posted an hour ago.
  update public.posts set created_at = now() - interval '1 hour' where id = v returning created_at into v_created;

  perform tst.login('alice');
  update public.posts set body = 'Version two' where id = v;
  select edited_at into v_first_edit from public.posts where id = v;
  perform tst.eq(v_first_edit, now(), 'editing sets edited_at');
  select * into e from public.post_edits where post_id = v order by written_at, id limit 1;
  perform tst.eq(e.body, 'Version one', 'edit history keeps the old body');
  perform tst.eq(e.written_at, v_created, 'first old version is stamped with created_at');

  update public.posts set body = 'Version three' where id = v;
  select count(*) into n from public.post_edits where post_id = v;
  perform tst.eq(n, 2, 'second edit adds a second history row');
  select * into e from public.post_edits where post_id = v order by id desc limit 1;
  perform tst.eq(e.body, 'Version two', 'second history row holds the previous body');
  perform tst.eq(e.written_at, v_first_edit, 'later versions are stamped with the previous edited_at');

  update public.posts set body = 'Version three' where id = v;
  select count(*) into n from public.post_edits where post_id = v;
  perform tst.eq(n, 2, 'saving the same body adds no history');

  perform tst.eq((select edit_count from public.feed() f where f.id = v), 2, 'feed edit_count counts history rows');
  perform tst.eq((select edits from json_to_record(public.my_stats()) as s(edits int)), 2, 'my_stats counts edits');

  perform tst.throws(format('insert into public.post_edits (post_id, body) values (%s, %L)', v, 'fake'),
                     '42501', 'clients cannot write edit history');
  perform tst.throws(format('update public.post_edits set body = %L where post_id = %s', 'rewritten', v),
                     '42501', 'clients cannot rewrite edit history');
  perform tst.throws(format('delete from public.post_edits where post_id = %s', v),
                     '42501', 'clients cannot delete edit history');

  perform tst.login('bob');
  perform tst.eq(tst.count(format('select * from public.post_edits where post_id = %s', v)), 2::bigint,
                 'others can read the receipt of a visible post');

  -- Once alice blocks bob, the receipt is hidden too.
  perform tst.login('alice');
  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.login('bob');
  perform tst.eq(tst.count(format('select * from public.post_edits where post_id = %s', v)), 0::bigint,
                 'receipt hidden when blocked');
end $$;
rollback;

-- Deleting does not reset the rate limits: post and delete five times, and
-- the sixth post in that minute is still slow_down (and earns no more XP).
begin;
do $$
declare
  v bigint;
  v_xp int := (select xp from tst.profiles where id = tst.uid('carol'));
begin
  perform tst.login('carol');
  for i in 1..5 loop
    insert into public.posts (body) values ('churn ' || i) returning id into v;
    delete from public.posts where id = v;
  end loop;
  perform tst.eq(tst.count(format('select id from public.posts where author_id = %L', tst.uid('carol'))), 0::bigint,
                 'setup: every churned post is deleted');
  perform tst.throws($q$insert into public.posts (body) values ('sixth')$q$, 'slow_down',
                     'posting and deleting still counts toward 5 a minute');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 125, 'XP stops at the limit too');
end $$;
rollback;

begin;
insert into public.write_log (user_id, kind, created_at)
select tst.uid('carol'), 'post', now() - interval '2 hours' from generate_series(1, 100);
select tst.login('carol');
select tst.throws($q$insert into public.posts (body) values ('101 counting deleted ones')$q$, 'slow_down',
                  'deleted posts count toward 100 a day');
rollback;

begin;
insert into public.write_log (user_id, kind, created_at)
select tst.uid('carol'), 'post', now() - interval '25 hours' from generate_series(1, 100);
select tst.login('carol');
select tst.lives($q$insert into public.posts (body) values ('a new day')$q$, 'writes older than a day do not count');
select tst.logout();
select tst.eq((select count(*)::int from public.write_log where user_id = tst.uid('carol') and kind = 'post'), 1,
              'old entries are cleared as new ones arrive');
rollback;

-- Edits: 10 a minute and 100 a day per person, and 50 per post.
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'version 0');
  perform tst.login('alice');
  for i in 1..10 loop
    update public.posts set body = 'version ' || i where id = v;
  end loop;
  perform tst.throws(format('update public.posts set body = %L where id = %s', 'version 11', v), 'slow_down',
                     'an 11th edit in a minute is slow_down');
  perform tst.eq((select count(*)::int from public.post_edits where post_id = v), 10, 'ten versions were kept');
  perform tst.login('bob');
  perform tst.lives(format('insert into public.reactions (post_id, kind) values (%s, %L)', v, 'like'),
                    'other people can still react to the post');
  perform tst.login('alice');
  perform tst.lives(format('update public.posts set body = body where id = %s', v), 'saving the same text is not an edit');
end $$;
rollback;

begin;
insert into public.write_log (user_id, kind, created_at)
select tst.uid('alice'), 'edit', now() - interval '2 hours' from generate_series(1, 100);
do $$
declare
  v bigint := tst.post('alice', 'busy day');
begin
  perform tst.login('alice');
  perform tst.throws(format('update public.posts set body = %L where id = %s', 'edit 101', v), 'slow_down', 'edit 101 of the day is slow_down');
end $$;
rollback;

begin;
do $$
declare
  v bigint := tst.post('alice', 'edited a lot');
begin
  insert into public.post_edits (post_id, body, written_at)
  select v, 'old ' || g, now() - make_interval(hours => g) from generate_series(1, 50) g;
  perform tst.login('alice');
  perform tst.throws(format('update public.posts set body = %L where id = %s', 'one more', v), 'edit_limit',
                     'a post with 50 earlier versions cannot be edited again');
  perform tst.logout();
  perform tst.lives(format('update public.posts set body = %L where id = %s', 'owner fix', v),
                    'the SQL editor is not limited');
end $$;
rollback;
