-- Duels: list_duels, vote_duel, settle_duels.

select tst.eq(pg_get_function_result('public.list_duels()'::regprocedure),
  'TABLE(id bigint, title text, a_label text, a_take text, a_user uuid, a_handle text, a_name text, a_hue integer, '
  'b_label text, b_take text, b_user uuid, b_handle text, b_name text, b_hue integer, '
  'a_votes integer, b_votes integer, starts_at timestamp with time zone, ends_at timestamp with time zone, '
  'settled boolean, my_side text)',
  'list_duels() returns the documented columns');

begin;
do $$
declare
  d bigint;
  r json;
  v_xp int;
  row record;
begin
  perform tst.login('alice');
  perform tst.eq(tst.count('select * from public.list_duels()'), 3::bigint, 'seeded duels are listed');
  perform tst.ok((select bool_and(my_side is null) from public.list_duels()), 'my_side is null before voting');
  perform tst.ok((select bool_and(e <= coalesce(nxt, e))
                    from (select l.ends_at as e, lead(l.ends_at) over (order by l.ordinality) as nxt
                            from public.list_duels() with ordinality l) x),
                 'list_duels is ordered by ends_at');
  select id into d from public.list_duels() order by ends_at limit 1;

  v_xp := (select xp from public.profiles where id = auth.uid());
  perform tst.throws(format('select public.vote_duel(%s, %L)', d, 'c'), 'bad_side', 'side other than a/b is bad_side');
  perform tst.throws(format('select public.vote_duel(%s, null)', d), 'bad_side', 'null side is bad_side');
  perform tst.throws(format('select public.vote_duel(%s, %L)', 999999999, 'a'), 'not_found', 'missing duel is not_found');

  r := public.vote_duel(d, 'a');
  perform tst.eq(r->>'side', 'a', 'vote returns my side');
  perform tst.eq((r->>'a_votes')::int, 1, 'vote returns updated a_votes');
  perform tst.eq((r->>'b_votes')::int, 0, 'vote returns b_votes');
  perform tst.eq((select xp from public.profiles where id = auth.uid()), v_xp + 5, 'voting earns 5 XP');
  perform tst.throws(format('select public.vote_duel(%s, %L)', d, 'b'), 'already_voted', 'second vote is already_voted');
  perform tst.eq((select my_side from public.list_duels() where id = d), 'a', 'list_duels shows my side');
  perform tst.eq((select votes from json_to_record(public.my_stats()) as t(votes int)), 1, 'my_stats counts votes');

  perform tst.login('bob');
  r := public.vote_duel(d, 'b');
  perform tst.ok((r->>'a_votes')::int = 1 and (r->>'b_votes')::int = 1, 'votes accumulate across users');
  perform tst.eq((select my_side from public.list_duels() where id = d), 'b', 'my_side is per viewer');
  perform tst.eq(tst.count(format('select * from public.duel_votes where duel_id = %s', d)), 1::bigint,
                 'others'' votes are private');

  perform tst.throws(format('insert into public.duel_votes (user_id, duel_id, side) values (auth.uid(), %s, %L)', d, 'a'),
                     '42501', 'clients cannot write votes');
  perform tst.throws(format('update public.duels set a_votes = 1000 where id = %s', d), '42501', 'clients cannot edit duels');
  perform tst.throws($q$insert into public.duels (title, a_label, a_take, b_label, b_take, ends_at)
                       values ('x', 'a', 'a', 'b', 'b', now() + interval '1 hour')$q$, '42501', 'clients cannot create duels');
end $$;
rollback;

-- Closed duels
begin;
insert into public.duels (title, a_label, a_take, b_label, b_take, starts_at, ends_at)
values ('Ended', 'A', 'take a', 'B', 'take b', now() - interval '2 hours', now() - interval '1 hour'),
       ('Not started', 'A', 'take a', 'B', 'take b', now() + interval '1 hour', now() + interval '2 hours'),
       ('Old', 'A', 'take a', 'B', 'take b', now() - interval '3 days', now() - interval '2 days');
select tst.login('alice');
select tst.throws(format('select public.vote_duel(%s, %L)', (select id from public.duels where title = 'Ended'), 'a'),
                  'duel_closed', 'voting on an ended duel is duel_closed');
select tst.throws(format('select public.vote_duel(%s, %L)', (select id from public.duels where title = 'Not started'), 'a'),
                  'duel_closed', 'voting before a duel starts is duel_closed');
select tst.ok(exists (select 1 from public.list_duels() where title = 'Ended'), 'duels that ended in the last 24h are listed');
select tst.ok(not exists (select 1 from public.list_duels() where title = 'Old'), 'duels that ended over 24h ago are not listed');
select tst.ok(not exists (select 1 from public.list_duels() where title = 'Not started'), 'duels not started yet are not listed');
rollback;

-- Settlement: winners +100 clout and duel_won; losers duel_lost; idempotent
begin;
do $$
declare
  d bigint;
  n int;
  v_alice numeric := (select clout from public.profiles where id = tst.uid('alice'));
  v_bob numeric := (select clout from public.profiles where id = tst.uid('bob'));
  v_carol numeric := (select clout from public.profiles where id = tst.uid('carol'));
  nt public.notifications%rowtype;
begin
  insert into public.duels (title, a_label, a_take, b_label, b_take, starts_at, ends_at, a_votes, b_votes)
  values ('Settle me', 'A', 'take a', 'B', 'take b', now() - interval '2 hours', now() - interval '1 minute', 2, 1)
  returning id into d;
  insert into public.duel_votes (user_id, duel_id, side)
  values (tst.uid('alice'), d, 'a'), (tst.uid('bob'), d, 'a'), (tst.uid('carol'), d, 'b');

  perform tst.login('frank');
  n := public.settle_duels();
  perform tst.ok(n >= 1, 'settle_duels returns how many it settled');
  perform tst.logout();
  perform tst.eq((select settled from public.duels where id = d), true, 'duel marked settled');
  perform tst.eq((select clout from public.profiles where id = tst.uid('alice')), v_alice + 100, 'winner alice +100 clout');
  perform tst.eq((select clout from public.profiles where id = tst.uid('bob')), v_bob + 100, 'winner bob +100 clout');
  perform tst.eq((select clout from public.profiles where id = tst.uid('carol')), v_carol, 'loser carol gets nothing');
  select * into nt from public.notifications where user_id = tst.uid('alice') and kind = 'duel_won';
  perform tst.eq(nt.data, '{"title": "Settle me", "clout": 100}'::jsonb, 'winner notification has title and clout');
  select * into nt from public.notifications where user_id = tst.uid('carol') and kind = 'duel_lost';
  perform tst.eq(nt.data, '{"title": "Settle me"}'::jsonb, 'loser notification has the title');

  perform tst.login('frank');
  n := public.settle_duels();
  perform tst.eq(n, 0, 'second settle settles nothing');
  perform tst.logout();
  perform tst.eq((select clout from public.profiles where id = tst.uid('alice')), v_alice + 100, 'no double payout');
  perform tst.eq((select count(*)::int from public.notifications where kind in ('duel_won', 'duel_lost')), 3,
                 'no duplicate duel notifications');

  perform tst.login('alice');
  perform tst.throws(format('select public.vote_duel(%s, %L)', d, 'b'), 'duel_closed', 'settled duel is duel_closed');
end $$;
rollback;

-- Ties pay nobody and tell every voter
begin;
do $$
declare
  d bigint;
  v_alice numeric := (select clout from public.profiles where id = tst.uid('alice'));
begin
  insert into public.duels (title, a_label, a_take, b_label, b_take, starts_at, ends_at, a_votes, b_votes)
  values ('Tie', 'A', 'take a', 'B', 'take b', now() - interval '2 hours', now() - interval '1 minute', 1, 1)
  returning id into d;
  insert into public.duel_votes (user_id, duel_id, side) values (tst.uid('alice'), d, 'a'), (tst.uid('bob'), d, 'b');
  perform tst.login('carol');
  perform public.settle_duels();
  perform tst.logout();
  perform tst.eq((select clout from public.profiles where id = tst.uid('alice')), v_alice, 'a tie pays nothing');
  perform tst.eq((select count(*)::int from public.notifications where kind = 'duel_lost' and data = '{"title": "Tie", "tie": true}'::jsonb), 2,
                 'every voter gets duel_lost with tie true');
  perform tst.eq((select count(*)::int from public.notifications where kind = 'duel_won'), 0, 'nobody wins a tie');
end $$;
rollback;

-- Seeded duels have not ended, so settle leaves them alone; anon cannot settle.
begin;
select tst.login('alice');
select tst.eq(public.settle_duels(), 0, 'open duels are not settled');
select tst.anon();
select tst.throws('select public.settle_duels()', '42501', 'anon cannot call settle_duels');
select tst.throws('select * from public.list_duels()', '42501', 'anon cannot call list_duels');
select tst.throws('select public.vote_duel(1, ''a'')', '42501', 'anon cannot vote');
rollback;

begin;
update public.profiles set is_banned = true where id = tst.uid('erin');
select tst.login('erin');
select tst.throws(format('select public.vote_duel(%s, %L)', (select min(id) from public.duels), 'a'), 'banned',
                  'banned users cannot vote');
rollback;
