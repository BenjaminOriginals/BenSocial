-- Runs after schema.sql was applied again on a database with data in it.

select tst.eq((select count(*)::int from public.profiles where id in (select id from tst.users)),
              (select count(*)::int from tst.users), 'fixture profiles survived the re-run');
select tst.ok((select is_admin from public.profiles where id = tst.uid('dave')), 'admin flag survived the re-run');
select tst.eq((select count(*)::int from public.duels), 3, 'duels survived the re-run');
select tst.eq((select count(*)::int from public.ads where active), 0, 'ads are still held after the re-run');
select tst.eq((select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal), 1,
              'the sign-up trigger exists exactly once');
select tst.eq((select count(*)::int from pg_policies where schemaname = 'public'), 38, 'policies were replaced, not duplicated');

begin;
do $$
declare
  v bigint;
begin
  perform tst.login('alice');
  insert into public.posts (body) values ('still works') returning id into v;
  perform tst.login('bob');
  insert into public.reactions (post_id, kind) values (v, 'like');
  perform tst.eq((select likes from public.posts where id = v), 1, 'triggers still work after the re-run');
  perform tst.throws($q$update public.profiles set clout = 1e9 where id = auth.uid()$q$, '42501', 'column privileges still hold after the re-run');
  perform tst.anon();
  perform tst.throws($q$select * from public.posts$q$, '42501', 'anon still locked out after the re-run');
end $$;
rollback;
