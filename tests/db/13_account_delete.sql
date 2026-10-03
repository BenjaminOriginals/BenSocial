-- delete_my_account(): the auth user and everything they own go; others stay consistent.

begin;
do $$
declare
  zed uuid := '2e000000-0000-4000-8000-0000000000ee';
  v_alice bigint;
  v_zed bigint;
  v_shares_before numeric;
  rep bigint;
begin
  perform tst.signup('zed', zed, '{"handle":"zed","name":"Zed"}');
  insert into auth.identities (user_id, identity_data) values (zed, '{"sub":"zed"}');
  v_alice := tst.post('alice', 'alice post zed touches');
  v_zed := tst.post('zed', 'zed post');

  -- zed interacts
  perform tst.login('zed');
  insert into public.reactions (post_id, kind) values (v_alice, 'like');
  insert into public.reposts (post_id) values (v_alice);
  insert into public.replies (post_id, body) values (v_alice, 'zed reply');
  insert into public.follows (followee) values (tst.uid('alice'));
  insert into public.mutes (muted_id) values (tst.uid('carol'));
  insert into public.blocks (blocked) values (tst.uid('frank'));
  insert into public.reports (post_id, reason) values (v_alice, 'other') returning id into rep;
  perform public.back_post(v_alice, 100);
  perform public.vote_duel((select min(id) from public.duels), 'a');
  -- others interact with zed
  perform tst.login('alice');
  insert into public.follows (followee) values (zed);
  insert into public.reactions (post_id, kind) values (v_zed, 'like');
  perform tst.login('bob');
  perform public.back_post(v_zed, 100);
  insert into public.reports (profile_id, reason) values (zed, 'spam');

  perform tst.logout();
  select shares_outstanding into v_shares_before from public.posts where id = v_alice;
  perform tst.ok(v_shares_before > 0, 'setup: zed holds shares in alice''s post');
  perform tst.eq((select clout from tst.profiles where id = tst.uid('bob')), 400::numeric, 'setup: bob backed zed with 100');
  perform tst.ok((select likes = 1 and reposts = 1 and replies = 1 from public.posts where id = v_alice), 'setup: counters on alice''s post');
  perform tst.ok((select followers_count = 1 and following_count = 1 from public.profiles where id = tst.uid('alice')),
                 'setup: alice and zed follow each other');

  perform tst.login('zed');
  perform public.delete_my_account();
  perform tst.logout();

  perform tst.eq((select count(*)::int from auth.users where id = zed), 0, 'auth user deleted');
  perform tst.eq((select count(*)::int from auth.identities where user_id = zed), 0, 'auth identities deleted');
  perform tst.eq((select count(*)::int from public.profiles where id = zed), 0, 'profile deleted');
  perform tst.eq((select count(*)::int from public.posts where author_id = zed), 0, 'posts deleted');
  perform tst.eq((select count(*)::int from public.replies where author_id = zed), 0, 'replies deleted');
  perform tst.eq((select count(*)::int from public.reactions where user_id = zed), 0, 'reactions deleted');
  perform tst.eq((select count(*)::int from public.reposts where user_id = zed), 0, 'reposts deleted');
  perform tst.eq((select count(*)::int from public.follows where follower = zed or followee = zed), 0, 'follows deleted');
  perform tst.eq((select count(*)::int from public.mutes where user_id = zed), 0, 'mutes deleted');
  perform tst.eq((select count(*)::int from public.blocks where blocker = zed), 0, 'blocks deleted');
  perform tst.eq((select count(*)::int from public.positions where user_id = zed), 0, 'positions deleted');
  perform tst.eq((select count(*)::int from public.duel_votes where user_id = zed), 0, 'duel votes deleted');
  perform tst.eq((select count(*)::int from public.xp_log where user_id = zed), 0, 'xp log deleted');
  perform tst.eq((select count(*)::int from public.notifications where user_id = zed or actor_id = zed), 0,
                 'notifications to and from them deleted');

  perform tst.ok((select likes = 0 and reposts = 0 and replies = 0 from public.posts where id = v_alice),
                 'counters on other people''s posts are corrected');
  perform tst.ok((select followers_count = 0 and following_count = 0 from public.profiles where id = tst.uid('alice')),
                 'follow counters on other profiles are corrected');
  perform tst.eq((select shares_outstanding from public.posts where id = v_alice), 0::numeric,
                 'their shares leave the market');
  perform tst.eq((select price from public.posts where id = v_alice), 5.0000::numeric, 'price follows the shares out');
  perform tst.eq((select clout from tst.profiles where id = tst.uid('bob')), 500::numeric,
                 'people who backed their posts are refunded');
  perform tst.eq((select reporter from public.reports where id = rep), null::uuid, 'their reports stay, unattributed');
  perform tst.eq((select count(*)::int from public.reports where reason = 'spam' and profile_id is null and reporter = tst.uid('bob')), 1,
                 'reports about them stay, with the target cleared');
end $$;
rollback;

-- Only your own account
begin;
select tst.login('bob');
select public.delete_my_account();
select tst.logout();
select tst.eq((select count(*)::int from auth.users where id = tst.uid('alice')), 1, 'deleting my account leaves others alone');
select tst.eq((select count(*)::int from auth.users where id = tst.uid('bob')), 0, 'deleting my account removes mine');
rollback;

-- A ban outlives the account. Deleting a banned account and signing up again
-- with the same email starts out banned, and nobody else can take the handle.
begin;
do $$
declare
  v bigint;
  rep bigint;
  g2 uuid := '1b000000-0000-4000-8000-0000000000b1';
  other uuid := '1c000000-0000-4000-8000-0000000000b2';
  r record;
begin
  v := tst.post('gina', 'gina harasses carol');
  perform tst.login('carol');
  insert into public.reports (post_id, reason, details) values (v, 'harassment', 'she is harassing me') returning id into rep;
  perform tst.login('dave');
  perform public.mod_set_banned(tst.uid('gina'), true);
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.bans where user_id = tst.uid('gina')), 1, 'banning records the ban');

  perform tst.login('gina');
  perform public.delete_my_account();
  perform tst.logout();
  perform tst.eq((select count(*)::int from auth.users where email = 'gina@example.test'), 0, 'the banned account is deleted');
  perform tst.eq((select count(*)::int from public.bans
                   where user_id is null and handle = 'gina' and email_hash = public.email_hash('gina@example.test')), 1,
                 'the ban stays behind as an email hash and the handle');
  perform tst.ok((select email_hash <> 'gina@example.test' and length(email_hash) = 64 from public.bans where handle = 'gina'),
                 'the email itself is not kept');

  -- Someone else cannot take the handle.
  perform tst.login('alice');
  perform tst.eq(public.handle_available('gina'), false, 'the banned handle is not available');
  perform tst.throws($q$update public.profiles set handle = 'gina' where id = auth.uid()$q$, 'handle_taken',
                     'nobody else can switch to the banned handle');
  perform tst.logout();
  other := tst.signup('gina_other', other, '{"handle":"gina","name":"Not Gina"}');
  perform tst.eq((select handle from public.profiles where id = other), 'user1c000000', 'a new sign-up cannot take the banned handle');
  perform tst.ok((select not is_banned from public.profiles where id = other), 'a different email starts out normally');

  -- Same email again (any case): banned from the start, with the held handle.
  g2 := tst.signup('gina', g2, '{"handle":"gina","name":"Gina Again"}');
  perform tst.ok((select is_banned from public.profiles where id = g2), 'signing up again with the same email starts out banned');
  perform tst.eq((select handle from public.profiles where id = g2), 'gina', 'the held handle goes back to the same person');
  perform tst.eq((select user_id from public.bans where handle = 'gina'), g2, 'the ban follows the new account');
  perform tst.login('gina');
  perform tst.throws($q$insert into public.posts (body) values ('I am back')$q$, 'banned', 'the returning account cannot post');

  -- The report still tells the moderator what was said and by whom.
  perform tst.login('dave');
  select * into r from public.mod_open_reports() where report_id = rep;
  perform tst.ok(r.target_kind = 'gone' and r.content = 'gina harasses carol' and r.target_handle = 'gina',
                 'the report keeps the deleted post and the handle');

  -- Unbanning clears it.
  perform public.mod_set_banned(g2, false);
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.bans where handle = 'gina'), 0, 'unbanning removes the ban record');
end $$;
rollback;

-- An email change before deleting does not shake the ban.
begin;
do $$
declare
  g2 uuid := '1d000000-0000-4000-8000-0000000000b3';
begin
  perform tst.login('dave');
  perform public.mod_set_banned(tst.uid('gina'), true);
  perform tst.logout();
  update auth.users set email = 'new.gina@example.test' where id = tst.uid('gina');
  perform tst.login('gina');
  perform public.delete_my_account();
  perform tst.logout();
  perform tst.eq((select email_hash from public.bans where handle = 'gina'), public.email_hash('new.gina@example.test'),
                 'the ban records the email the account had when it was deleted');
  perform set_config('role', 'supabase_auth_admin', true);
  perform set_config('search_path', 'auth', true);
  execute 'insert into users (id, email, raw_user_meta_data) values ($1, $2, $3)'
    using g2, 'New.Gina@Example.test', '{"handle":"ginagain"}'::jsonb;
  perform set_config('search_path', '"$user", public', true);
  perform set_config('role', 'none', true);
  perform tst.ok((select is_banned from public.profiles where id = g2), 'the email matches whatever its case');
end $$;
rollback;

-- Deleting an account that was never banned leaves no ban behind.
begin;
select tst.login('erin');
select public.delete_my_account();
select tst.logout();
select tst.eq((select count(*)::int from public.bans), 0, 'no ban record for an ordinary deletion');
rollback;
