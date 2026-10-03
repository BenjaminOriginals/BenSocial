-- XP: dedupe, level formula (must equal the client's), level-up clout bonus.

-- Level formula matches index.html levelInfo() for every XP value up to 20000.
select tst.eq((select count(*)::int from generate_series(0, 20000) x
                where public.xp_level(x) <> tst.client_level(x)), 0,
              'xp_level matches the client formula for 0..20000');
select tst.eq(public.xp_level(0), 1, 'level 1 at 0 XP');
select tst.eq(public.xp_level(99), 1, 'level 1 at 99 XP');
select tst.eq(public.xp_level(100), 2, 'level 2 at 100 XP');
select tst.eq(public.xp_level(249), 2, 'level 2 at 249 XP');
select tst.eq(public.xp_level(250), 3, 'level 3 at 250 XP');
select tst.eq(public.xp_level(449), 3, 'level 3 at 449 XP');
select tst.eq(public.xp_level(450), 4, 'level 4 at 450 XP');
select tst.eq(public.xp_level(700), 5, 'level 5 at 700 XP');

-- Dedupe
begin;
do $$
declare
  v_xp int := (select xp from public.profiles where id = tst.uid('carol'));
begin
  perform tst.eq(public.award_xp(tst.uid('carol'), 10, 'test', 'r1'), true, 'first grant returns true');
  perform tst.eq(public.award_xp(tst.uid('carol'), 10, 'test', 'r1'), false, 'same reason and ref returns false');
  perform tst.eq((select xp from public.profiles where id = tst.uid('carol')), v_xp + 10, 'XP granted once');
  perform tst.eq(public.award_xp(tst.uid('carol'), 10, 'test', 'r2'), true, 'a new ref grants again');
  perform tst.eq(public.award_xp(tst.uid('carol'), 0, 'test', 'r3'), false, 'zero XP grants nothing');
  perform tst.eq(public.award_xp(null, 10, 'test', 'r4'), false, 'no user grants nothing');
end $$;
rollback;

-- Level-up from a real action: 95 XP + a post (25) = 120 -> level 2, +100 clout
begin;
update public.profiles set xp = 95 where id = tst.uid('bob');
do $$
declare
  v_clout numeric := (select clout from public.profiles where id = tst.uid('bob'));
  nt public.notifications%rowtype;
begin
  perform tst.post('bob', 'This post levels me up');
  perform tst.eq((select xp from public.profiles where id = tst.uid('bob')), 120, 'post XP added');
  perform tst.eq((select clout from public.profiles where id = tst.uid('bob')), v_clout + 100, 'level 2 pays 100 clout');
  select * into nt from public.notifications where user_id = tst.uid('bob') and kind = 'level';
  perform tst.eq(nt.data, '{"level": 2, "bonus": 100}'::jsonb, 'level notification has level and bonus');
  perform tst.eq(nt.actor_id, null::uuid, 'level notification has no actor');
end $$;
rollback;

-- Crossing several levels at once pays each level: 2, 3 and 4 -> 100 + 150 + 200
begin;
do $$
declare
  v_clout numeric := (select clout from public.profiles where id = tst.uid('carol'));
begin
  perform public.award_xp(tst.uid('carol'), 460, 'test', 'big');
  perform tst.eq((select xp from public.profiles where id = tst.uid('carol')), 460, 'big grant applied');
  perform tst.eq((select clout from public.profiles where id = tst.uid('carol')), v_clout + 450,
                 'crossing levels 2, 3 and 4 pays 450 clout');
  perform tst.eq((select array_agg((data->>'level')::int order by (data->>'level')::int)
                    from public.notifications where user_id = tst.uid('carol') and kind = 'level'),
                 array[2, 3, 4], 'one level notification per level crossed');
  perform tst.eq((select sum((data->>'bonus')::int)::int from public.notifications
                   where user_id = tst.uid('carol') and kind = 'level'), 450, 'bonuses in notifications add up');
  -- No level-up when staying within a level.
  perform public.award_xp(tst.uid('carol'), 5, 'test', 'small');
  perform tst.eq((select count(*)::int from public.notifications where user_id = tst.uid('carol') and kind = 'level'), 3,
                 'no level notification without a level-up');
end $$;
rollback;

-- XP log is invisible to clients, and award_xp cannot be called by them.
begin;
select tst.login('bob');
select tst.throws($q$select * from public.xp_log$q$, '42501', 'clients cannot read xp_log');
select tst.throws($q$insert into public.xp_log (user_id, reason, ref) values (auth.uid(), 'x', 'y')$q$, '42501', 'clients cannot write xp_log');
select tst.throws($q$select public.award_xp(auth.uid(), 100000, 'cheat', 'x')$q$, '42501', 'clients cannot call award_xp');
select tst.throws($q$select public.xp_level(5)$q$, '42501', 'clients cannot call xp_level');
rollback;
