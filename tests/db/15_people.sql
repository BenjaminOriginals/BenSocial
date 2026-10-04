-- search_people(): finding people by handle or name, and the newest members.

begin;
do $$
declare
  ids uuid[];
begin
  update public.profiles set created_at = now() - make_interval(days => 10) where id <> tst.uid('gina');
  update public.profiles set created_at = now() - interval '1 day' where id = tst.uid('gina');
  update public.profiles set name = 'Carol 100% Real_' where id = tst.uid('carol');
  perform tst.login('alice');

  perform tst.eq((select handle from public.search_people('') limit 1), 'gina', 'an empty search lists the newest members first');
  perform tst.ok(not exists (select 1 from public.search_people('') where id = auth.uid()), 'you are not in your own results');
  perform tst.eq((select count(*)::int from public.search_people('')), 6, 'everyone else is listed');
  perform tst.eq((select handle from public.search_people('bob') limit 1), 'bob', 'a handle finds that person');
  perform tst.eq((select handle from public.search_people('@BOB') limit 1), 'bob', 'with an @ and in any case');
  perform tst.eq((select handle from public.search_people('the mod') limit 1), 'dave', 'part of a name finds them');
  perform tst.eq((select count(*)::int from public.search_people('zzzz')), 0, 'no match, no rows');
  perform tst.eq((select count(*)::int from public.search_people('%')), 1, 'a % is matched literally, not as a wildcard');
  perform tst.eq((select count(*)::int from public.search_people('_')), 1, 'so is an underscore');
  perform tst.eq((select count(*)::int from public.search_people('', 2)), 2, 'p_limit caps the rows');
  perform tst.eq((select count(*)::int from public.search_people('', 1000)), 6, 'p_limit is clamped (to 50)');
  perform tst.eq((select count(*)::int from public.search_people(null)), 6, 'a null query lists everyone');

  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.ok(not exists (select 1 from public.search_people('bob')), 'people you blocked are left out');
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.search_people('alice')), 'people who blocked you are left out');
  perform tst.logout();
  update public.profiles set is_banned = true where id = tst.uid('erin');
  perform tst.login('carol');
  perform tst.ok(not exists (select 1 from public.search_people('erin')), 'banned accounts are left out');
  perform tst.anon();
  perform tst.throws($q$select * from public.search_people('bob')$q$, '42501', 'anon cannot search');
end $$;
rollback;
