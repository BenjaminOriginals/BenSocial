-- Security posture: RLS everywhere, anon locked out, helpers locked down,
-- SECURITY DEFINER functions pinned to search_path = public.

-- Every table in public has RLS on.
select tst.eq((select string_agg(c.relname, ', ' order by c.relname)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
              null::text, 'every public table has row level security enabled');
select tst.eq((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'), 20, 'all 20 tables exist');

-- Policies only target authenticated.
select tst.eq((select string_agg(tablename || '.' || policyname, ', ')
                 from pg_policies
                where schemaname = 'public' and roles <> '{authenticated}'::name[]),
              null::text, 'every policy targets authenticated only');

-- anon has no table or column privileges at all.
select tst.eq((select string_agg(c.relname, ', ' order by c.relname)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'
                  and has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')),
              null::text, 'anon has no table privileges in public');
select tst.eq((select string_agg(c.relname, ', ' order by c.relname)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'
                  and has_any_column_privilege('anon', c.oid, 'select, insert, update, references')),
              null::text, 'anon has no column privileges in public');
select tst.eq((select string_agg(c.relname, ', ' order by c.relname)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'
                  and has_table_privilege('authenticated', c.oid, 'truncate, references, trigger')),
              null::text, 'authenticated cannot truncate, reference or add triggers');
select tst.eq((select string_agg(c.relname, ', ' order by c.relname)
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind = 'r'
                  and has_table_privilege('authenticated', c.oid, 'insert, update')),
              null::text, 'authenticated has no table-wide insert or update (columns only)');

-- anon can execute exactly one function: handle_available.
select tst.eq((select string_agg(p.oid::regprocedure::text, ', ' order by 1)
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')),
              'handle_available(text)', 'anon can execute only handle_available');

-- authenticated can execute exactly the RPCs plus the two policy helpers.
select tst.eq((select string_agg(p.proname, ', ' order by p.proname)
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')),
              'ads_enabled, back_post, claim_daily_drop, delete_my_account, feed, handle_available, handle_reserved, '
              'is_admin, is_blocked_with, list_duels, mark_notifications_read, mod_create_duel, mod_open_reports, '
              'mod_reset_profile, mod_resolve_report, mod_set_banned, mod_set_post_removed, mod_set_reply_removed, '
              'my_profile, my_stats, posts_by, record_ad_view, search_people, sell_position, '
              'settle_duels, touch_streak, unread_count, vote_duel',
              'authenticated can execute exactly the RPCs and policy helpers');

-- Internal helpers and trigger functions: not executable by clients, but still by service_role.
select tst.eq((select string_agg(p.proname, ', ' order by p.proname)
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('award_xp', 'xp_level', 'add_notification', 'refund_positions', 'create_profile',
                                    'market_base', 'market_price', 'blocked_pair', 'req_user', 'req_admin',
                                    'payments_enabled', 'email_hash', 'record_ban', 'rate_check', 'claim_slot')
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))),
              null::text, 'internal helpers are not executable by anon or authenticated');
select tst.eq((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prorettype = 'trigger'::regtype
                  and (has_function_privilege('anon', p.oid, 'execute')
                       or has_function_privilege('authenticated', p.oid, 'execute'))),
              0, 'trigger functions are not executable by anon or authenticated');
select tst.ok((select count(*) >= 16 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prorettype = 'trigger'::regtype), 'trigger functions exist');
select tst.ok(has_function_privilege('service_role', 'public.award_xp(uuid, int, text, text)', 'execute'),
              'service_role keeps access to helpers');
select tst.ok(not has_function_privilege('public', 'public.award_xp(uuid, int, text, text)', 'execute'),
              'PUBLIC cannot execute helpers');

-- Every SECURITY DEFINER function pins search_path = public.
select tst.eq((select string_agg(p.proname, ', ')
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prosecdef
                  and not coalesce(p.proconfig @> array['search_path=public'], false)),
              null::text, 'every SECURITY DEFINER function sets search_path = public');
select tst.eq((select string_agg(p.proname, ', ')
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public'
                  and p.proname in ('handle_available', 'touch_streak', 'claim_daily_drop', 'back_post', 'sell_position',
                                    'vote_duel', 'settle_duels', 'mark_notifications_read', 'unread_count', 'my_stats',
                                    'delete_my_account', 'record_ad_view', 'mod_open_reports', 'mod_set_post_removed',
                                    'mod_set_banned', 'mod_resolve_report', 'mod_create_duel', 'my_profile',
                                    'mod_set_reply_removed', 'mod_reset_profile', 'handle_reserved', 'ads_enabled')
                  and not p.prosecdef),
              null::text, 'RPCs that write or read private data are SECURITY DEFINER');
select tst.eq((select string_agg(p.proname, ', ' order by p.proname)
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname in ('feed', 'posts_by', 'list_duels', 'search_people') and p.prosecdef),
              null::text, 'feed, posts_by, list_duels and search_people run as the caller');

-- Behaviour as anon
begin;
select tst.anon();
do $$
declare
  t text;
begin
  foreach t in array array['profiles','posts','post_edits','reactions','reposts','replies','follows','mutes','blocks',
                           'reports','notifications','positions','duels','duel_votes','xp_log','ads','ad_views',
                           'settings','bans','write_log'] loop
    perform tst.throws(format('select * from public.%I', t), '42501', 'anon cannot read ' || t);
  end loop;
  perform tst.throws($q$insert into public.posts (body) values ('anon post')$q$, '42501', 'anon cannot post');
  perform tst.throws($q$update public.profiles set name = 'x'$q$, '42501', 'anon cannot update profiles');
  perform tst.throws('select public.unread_count()', '42501', 'anon cannot call unread_count');
  perform tst.throws('select public.my_stats()', '42501', 'anon cannot call my_stats');
  perform tst.throws('select public.delete_my_account()', '42501', 'anon cannot call delete_my_account');
  perform tst.throws('select public.is_admin()', '42501', 'anon cannot call is_admin');
  perform tst.ok(public.handle_available('free_handle'), 'anon can still check a handle');
end $$;
rollback;

-- Authenticated users cannot call helpers directly.
begin;
select tst.login('bob');
select tst.throws($q$select public.award_xp(auth.uid(), 5000, 'cheat', 'x')$q$, '42501', 'members cannot call award_xp');
select tst.throws($q$select public.add_notification(auth.uid(), null, 'level', null, '{}')$q$, '42501', 'members cannot call add_notification');
select tst.throws($q$select public.refund_positions(1)$q$, '42501', 'members cannot call refund_positions');
select tst.throws($q$select public.create_profile(gen_random_uuid(), '{}')$q$, '42501', 'members cannot call create_profile');
select tst.throws($q$select public.blocked_pair(auth.uid(), auth.uid())$q$, '42501', 'members cannot call blocked_pair');
select tst.throws($q$select public.req_admin()$q$, '42501', 'members cannot call req_admin');
select tst.throws($q$select public.market_price(1, 1, 1, 1, 1)$q$, '42501', 'members cannot call market_price');
select tst.eq(public.is_admin(), false, 'is_admin is false for members');
select tst.throws($q$select public.rate_check(auth.uid(), 'post', 1000, 1000)$q$, '42501', 'members cannot call rate_check');
select tst.throws($q$select public.claim_slot(auth.uid(), 'drop')$q$, '42501', 'members cannot call claim_slot');
select tst.throws($q$select public.record_ban(auth.uid())$q$, '42501', 'members cannot call record_ban');
select tst.throws($q$select public.payments_enabled()$q$, '42501', 'members cannot call payments_enabled');
do $$
declare
  t text;
begin
  foreach t in array array['settings', 'bans', 'write_log', 'xp_log'] loop
    perform tst.throws(format('select * from public.%I', t), '42501', 'members cannot read ' || t);
  end loop;
end $$;
select tst.throws($q$update public.settings set ads_enabled = true$q$, '42501', 'members cannot turn ads on');
select tst.throws($q$update public.settings set payments_enabled = true$q$, '42501', 'members cannot turn payments on');
select tst.throws($q$delete from public.write_log$q$, '42501', 'members cannot clear their rate limits');
rollback;

-- The server switches start off, and there is exactly one row.
select tst.eq((select count(*)::int from public.settings), 1, 'settings has one row');
select tst.ok((select not ads_enabled and not payments_enabled from public.settings), 'ads and payments are off on the server');
select tst.throws($q$insert into public.settings (id) values (false)$q$, '23514', 'settings cannot get a second row');

begin;
select tst.login('dave');
select tst.eq(public.is_admin(), true, 'is_admin is true for admins');
rollback;

-- An authenticated role with no matching profile gets nothing extra.
begin;
select tst.login_id('99999999-9999-4999-8999-999999999999');
select tst.throws($q$select public.claim_daily_drop(current_date)$q$, 'not_found', 'RPCs need a profile');
select tst.throws($q$insert into public.posts (body) values ('ghost')$q$, '23503', 'a ghost user cannot post');
select tst.eq(tst.count('select * from public.notifications'), 0::bigint, 'a ghost user sees no notifications');
rollback;

-- No claims at all while acting as authenticated: RPCs refuse.
begin;
set local role authenticated;
select tst.throws($q$select public.settle_duels()$q$, 'not_authenticated', 'settle_duels needs a user');
select tst.throws($q$select public.delete_my_account()$q$, 'not_authenticated', 'delete_my_account needs a user');
select tst.throws($q$select public.claim_daily_drop(current_date)$q$, 'not_authenticated', 'claim_daily_drop needs a user');
select tst.throws($q$select * from public.mod_open_reports()$q$, 'not_authenticated', 'mod RPCs need a user');
rollback;
