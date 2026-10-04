-- Runs after schema.sql was applied again on a database with data in it.

select tst.eq((select count(*)::int from public.profiles where id in (select id from tst.users)),
              (select count(*)::int from tst.users), 'fixture profiles survived the re-run');
select tst.ok((select is_admin from public.profiles where id = tst.uid('dave')), 'admin flag survived the re-run');
select tst.eq((select count(*)::int from public.duels), 3, 'duels survived the re-run');
select tst.eq((select count(*)::int from public.ads where active), 0, 'ads are still held after the re-run');
select tst.eq((select count(*)::int from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal), 1,
              'the sign-up trigger exists exactly once');
select tst.eq((select count(*)::int from pg_policies where schemaname = 'public'), 38, 'policies were replaced, not duplicated');
select tst.ok((select ads_enabled and payments_enabled from public.settings), 'the server switches keep the owner''s choice');
select tst.eq(public.app_switches()::jsonb, '{"ads": true, "payments": true}'::jsonb, 'app_switches reports the owner''s choice after the re-run');
select tst.eq((select count(*)::int from public.settings), 1, 'settings still has one row');
select tst.eq((select count(*)::int from public.bans where handle = 'gone_banned' and user_id is null), 1, 'bans of deleted accounts survive');
select tst.eq(public.handle_available('gone_banned'), false, 'and still hold the handle');

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
  perform tst.throws($q$select public.mod_set_switch('ads', false)$q$, 'not_admin', 'the Switchboard is still admin-only after the re-run');
  perform tst.login('dave');
  perform tst.eq(public.mod_set_switch('ads', false)::jsonb, '{"ads": false, "payments": true}'::jsonb, 'admins can still turn ads off after the re-run');
  perform tst.anon();
  perform tst.throws($q$select * from public.posts$q$, '42501', 'anon still locked out after the re-run');
end $$;
rollback;
