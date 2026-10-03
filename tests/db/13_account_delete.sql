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
  perform tst.eq((select clout from public.profiles where id = tst.uid('bob')), 400::numeric, 'setup: bob backed zed with 100');
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
  perform tst.eq((select clout from public.profiles where id = tst.uid('bob')), 500::numeric,
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
