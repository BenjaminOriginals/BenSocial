-- Moderation RPCs: admins only.

begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'mod target');
  perform tst.login('bob');
  perform tst.throws('select * from public.mod_open_reports()', 'not_admin', 'members cannot list reports');
  perform tst.throws(format('select public.mod_set_post_removed(%s, true)', v), 'not_admin', 'members cannot remove posts');
  perform tst.throws(format('select public.mod_set_banned(%L, true)', tst.uid('alice')), 'not_admin', 'members cannot ban');
  perform tst.throws('select public.mod_resolve_report(1, ''dismissed'')', 'not_admin', 'members cannot resolve reports');
  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 5)$q$, 'not_admin', 'members cannot create duels');
  perform tst.throws($q$insert into public.ads (brand, bid_cents, copy) values ('Sneaky', 5, 'buy')$q$, '42501',
                     'members cannot create ads');

  perform tst.anon();
  perform tst.throws('select * from public.mod_open_reports()', '42501', 'anon cannot list reports');
  perform tst.throws(format('select public.mod_set_banned(%L, true)', tst.uid('alice')), '42501', 'anon cannot ban');
end $$;
rollback;

-- Open reports, remove/restore, ban/unban, resolve
begin;
do $$
declare
  v bigint;
  vb bigint;
  rid bigint;
  r record;
  n int;
  v_post_report bigint;
begin
  v := tst.post('alice', 'Bad post body');
  vb := tst.post('bob', 'Bob post for ban checks');
  perform tst.login('bob');
  insert into public.replies (post_id, body) values (v, 'Bad reply body') returning id into rid;
  perform tst.login('carol');
  insert into public.reports (post_id, reason, details) values (v, 'hate', 'post report') returning id into v_post_report;
  insert into public.reports (reply_id, reason) values (rid, 'harassment');
  insert into public.reports (profile_id, reason) values (tst.uid('erin'), 'spam');

  perform tst.login('dave');
  perform tst.eq(tst.count('select * from public.mod_open_reports()'), 3::bigint, 'admin sees open reports');
  select * into r from public.mod_open_reports() where report_id = v_post_report;
  perform tst.eq(r.target_kind, 'post', 'post report has target_kind post');
  perform tst.eq(r.content, 'Bad post body', 'post report carries the post body');
  perform tst.eq(r.reporter_handle, 'carol', 'report carries the reporter handle');
  perform tst.eq(r.target_handle, 'alice', 'post report targets the author');
  perform tst.eq(r.target_user, tst.uid('alice'), 'post report carries target_user');
  perform tst.eq(r.target_banned, false, 'target_banned is false');
  perform tst.eq(r.post_removed, false, 'post_removed is false');
  perform tst.eq(r.reason, 'hate', 'report carries the reason');
  perform tst.eq(r.details, 'post report', 'report carries details');
  perform tst.eq(r.status, 'open', 'report carries status');
  select * into r from public.mod_open_reports() where reply_id = rid;
  perform tst.ok(r.target_kind = 'reply' and r.content = 'Bad reply body' and r.target_handle = 'bob',
                 'reply report carries the reply and its author');
  select * into r from public.mod_open_reports() where profile_id = tst.uid('erin');
  perform tst.ok(r.target_kind = 'profile' and r.target_handle = 'erin' and r.content = 'Erin',
                 'profile report carries the profile');

  -- Remove and restore
  perform public.mod_set_post_removed(v, true);
  perform tst.ok((select post_removed from public.mod_open_reports() where report_id = v_post_report), 'post_removed reflects removal');
  perform tst.ok(exists (select 1 from public.posts where id = v), 'admin can still see the removed post');
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.posts where id = v), 'removed post hidden from members');
  perform tst.login('alice');
  perform tst.ok(not exists (select 1 from public.posts where id = v), 'removed post hidden from its author');
  perform tst.eq((select data from public.notifications where kind = 'mod' and post_id = v), '{"action": "removed"}'::jsonb,
                 'author gets a mod notification when a post is removed');
  perform tst.login('dave');
  perform public.mod_set_post_removed(v, true);
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.notifications where kind = 'mod'), 1, 'removing twice notifies once');
  perform tst.login('dave');
  perform public.mod_set_post_removed(v, false);
  perform tst.login('bob');
  perform tst.ok(exists (select 1 from public.posts where id = v), 'restored post is visible again');
  perform tst.login('dave');
  perform tst.throws('select public.mod_set_post_removed(999999999, true)', 'not_found', 'removing a missing post is not_found');

  -- Ban and unban
  perform public.mod_set_banned(tst.uid('alice'), true);
  perform tst.ok((select target_banned from public.mod_open_reports() where report_id = v_post_report), 'target_banned reflects the ban');
  perform tst.login('bob');
  perform tst.ok(not exists (select 1 from public.posts where author_id = tst.uid('alice')), 'banned user''s posts are hidden');
  perform tst.login('alice');
  perform tst.throws($q$insert into public.posts (body) values ('still here')$q$, 'banned', 'banned user cannot post');
  perform tst.throws(format('select public.claim_daily_drop(%L)', current_date), 'banned', 'banned user cannot claim drops');
  perform tst.lives(format('select public.touch_streak(%L)', current_date), 'banned user can still load the app');
  perform tst.throws(format('insert into public.reactions (post_id, kind) values (%s, %L)', vb, 'like'), 'banned', 'banned user cannot react');
  perform tst.throws(format('insert into public.reposts (post_id) values (%s)', vb), 'banned', 'banned user cannot repost');
  perform tst.throws(format('insert into public.follows (followee) values (%L)', tst.uid('bob')), 'banned', 'banned user cannot follow');
  perform tst.throws($q$update public.profiles set bio = 'new bio' where id = auth.uid()$q$, 'banned', 'banned user cannot edit their profile');
  perform tst.throws(format('select public.vote_duel(%s, %L)', (select min(id) from public.duels), 'a'), 'banned', 'banned user cannot vote');
  perform tst.lives(format('insert into public.blocks (blocked) values (%L)', tst.uid('carol')), 'banned user can still block');
  perform tst.lives(format('insert into public.reports (post_id, reason) values (%s, %L)', vb, 'spam'), 'banned user can still report');
  perform tst.lives('select public.mark_notifications_read()', 'banned user can still clear notifications');
  perform tst.login('dave');
  perform public.mod_set_banned(tst.uid('alice'), false);
  perform tst.login('alice');
  perform tst.lives($q$insert into public.posts (body) values ('back again')$q$, 'unbanned user can post again');
  perform tst.lives(format('insert into public.reactions (post_id, kind) values (%s, %L)', vb, 'like'), 'unbanned user can react again');
  perform tst.lives($q$update public.profiles set bio = 'reformed' where id = auth.uid()$q$, 'unbanned user can edit their profile again');

  perform tst.login('dave');
  perform tst.throws(format('select public.mod_set_banned(%L, true)', tst.uid('dave')), 'not_allowed', 'admins cannot ban themselves');
  perform tst.throws(format('select public.mod_set_banned(%L, false)', tst.uid('dave')), 'not_allowed', 'admins cannot unban themselves either');
  perform tst.throws(format('select public.mod_set_banned(%L, true)', gen_random_uuid()), 'not_found', 'banning a missing user is not_found');

  -- Resolve
  perform public.mod_resolve_report(v_post_report, 'actioned');
  perform tst.eq((select status from public.reports where id = v_post_report), 'actioned', 'report marked actioned');
  perform tst.ok(not exists (select 1 from public.mod_open_reports() where report_id = v_post_report), 'resolved reports leave the queue');
  perform public.mod_resolve_report(v_post_report, 'open');
  perform tst.ok(exists (select 1 from public.mod_open_reports() where report_id = v_post_report), 'reopened report returns');
  perform public.mod_resolve_report(v_post_report, 'dismissed');
  perform tst.eq((select status from public.reports where id = v_post_report), 'dismissed', 'report dismissed');
  perform tst.throws(format('select public.mod_resolve_report(%s, %L)', v_post_report, 'deleted'), 'bad_status', 'unknown status is bad_status');
  perform tst.throws('select public.mod_resolve_report(999999999, ''dismissed'')', 'not_found', 'missing report is not_found');

  -- Reports whose content is gone show as 'gone'
  perform tst.login('bob');
  delete from public.replies where id = rid;
  perform tst.login('dave');
  perform tst.eq((select target_kind from public.mod_open_reports() where report_id <> v_post_report and post_id is null and reply_id is null and profile_id is null),
                 'gone', 'report whose reply was deleted shows target_kind gone');
end $$;
rollback;

-- Create duels
begin;
do $$
declare
  d bigint;
  r record;
begin
  perform tst.login('dave');
  d := public.mod_create_duel('Tabs or spaces?', 'Tabs', 'One character, any width.', 'Spaces', 'What you see is what you get.', 6,
                              '@Alice', 'bob');
  select * into r from public.duels where id = d;
  perform tst.eq(r.a_user, tst.uid('alice'), 'side A handle resolves (with @ and caps)');
  perform tst.eq(r.b_user, tst.uid('bob'), 'side B handle resolves');
  perform tst.eq(r.created_by, tst.uid('dave'), 'created_by is the admin');
  perform tst.eq(r.ends_at, now() + interval '6 hours', 'duel runs for the given hours');
  perform tst.ok(exists (select 1 from public.list_duels() l where l.id = d and l.a_handle = 'alice' and l.b_name = 'Bob'),
                 'new duel shows in list_duels with people attached');

  d := public.mod_create_duel('No people', 'Yes', 'Take one', 'No', 'Take two', 1);
  perform tst.ok((select a_user is null and b_user is null from public.duels where id = d), 'handles are optional');
  d := public.mod_create_duel('Label from name', '', 'Take one', '  ', 'Take two', 72, 'carol', 'frank');
  perform tst.ok((select a_label = 'Carol' and b_label = 'Frank' from public.duels where id = d), 'blank labels fall back to names');

  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 0)$q$, 'bad_amount', '0 hours is bad_amount');
  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 73)$q$, 'bad_amount', '73 hours is bad_amount');
  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 5, 'nobody_here')$q$, 'not_found', 'unknown side A handle is not_found');
  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 5, null, 'nobody_here')$q$, 'not_found', 'unknown side B handle is not_found');
  perform tst.throws($q$select public.mod_create_duel('', 'a', 'a', 'b', 'b', 5)$q$, '23514', 'empty title rejected');
  perform tst.throws(format('select public.mod_create_duel(%L, %L, %L, %L, %L, 5)', repeat('t', 121), 'a', 'a', 'b', 'b'), '23514',
                     'title over 120 characters rejected');

  -- Admins manage ads directly
  perform tst.lives($q$insert into public.ads (brand, bid_cents, copy) values ('House ad', 5, 'Try duels')$q$, 'admins can create ads');
  perform tst.ok((select not active from public.ads where brand = 'House ad'), 'new ads start inactive (held)');
  perform tst.eq(tst.count('select * from public.ads'), 4::bigint, 'admins see inactive ads');
end $$;
rollback;

-- Deleting reported content does not shake off moderation: the report keeps
-- what was said and who said it, and the author can still be banned.
begin;
do $$
declare
  v bigint;
  rid bigint;
  rep bigint;
  r record;
begin
  v := tst.post('bob', 'bob asks a question');
  perform tst.login('frank');
  insert into public.replies (post_id, body) values (v, 'abusive reply') returning id into rid;
  perform tst.login('bob');
  insert into public.reports (reply_id, reason) values (rid, 'harassment') returning id into rep;
  perform tst.login('frank');
  delete from public.replies where id = rid;
  perform tst.login('dave');
  select * into r from public.mod_open_reports() where report_id = rep;
  perform tst.eq(r.target_kind, 'gone', 'a deleted reply''s report shows as gone');
  perform tst.eq(r.content, 'abusive reply', 'it still shows what the reply said');
  perform tst.eq(r.target_user, tst.uid('frank'), 'and who wrote it');
  perform tst.eq(r.target_handle, 'frank', 'with their handle');
  perform public.mod_set_banned(r.target_user, true);
  perform tst.ok((select is_banned from public.profiles where id = tst.uid('frank')), 'the author of deleted content can be banned');
  -- Deleting the whole post does the same.
  perform tst.logout();
  v := tst.post('erin', 'erin says something awful');
  perform tst.login('carol');
  insert into public.reports (post_id, reason) values (v, 'hate') returning id into rep;
  perform tst.login('erin');
  delete from public.posts where id = v;
  perform tst.login('dave');
  select * into r from public.mod_open_reports() where report_id = rep;
  perform tst.ok(r.target_kind = 'gone' and r.content = 'erin says something awful' and r.target_user = tst.uid('erin'),
                 'a deleted post''s report keeps its body and author');
end $$;
rollback;

-- Removing one reply, and resetting a profile.
begin;
do $$
declare
  v bigint;
  rid bigint;
  rep bigint;
  n int;
begin
  v := tst.post('bob', 'thread for reply removal');
  perform tst.login('erin');
  insert into public.replies (post_id, body) values (v, 'rude reply') returning id into rid;
  perform tst.login('bob');
  insert into public.reports (reply_id, reason) values (rid, 'harassment') returning id into rep;
  perform tst.eq((select replies from public.posts where id = v), 1, 'setup: one reply');

  perform tst.login('carol');
  perform tst.throws(format('select public.mod_set_reply_removed(%s, true)', rid), 'not_admin', 'members cannot remove replies');
  perform tst.throws(format('select public.mod_reset_profile(%L)', tst.uid('erin')), 'not_admin', 'members cannot reset profiles');

  perform tst.login('dave');
  perform tst.throws(format('update public.replies set removed = true where id = %s', rid), '42501',
                     'admins change replies only through the RPC');
  perform public.mod_set_reply_removed(rid, true);
  perform tst.ok((select post_removed from public.mod_open_reports() where report_id = rep), 'the report shows the reply as removed');
  perform tst.ok(exists (select 1 from public.mod_open_reports() where report_id = rep and content = 'rude reply'),
                 'moderators still see the removed reply in the report');
  perform tst.login('bob');
  perform tst.eq(tst.count(format('select id from public.replies where id = %s', rid)), 0::bigint, 'a removed reply is hidden');
  perform tst.eq((select replies from public.posts where id = v), 0, 'a removed reply leaves the count');
  perform tst.login('erin');
  perform tst.eq((select data->>'action' from public.notifications where kind = 'mod'), 'reply_removed', 'its author is told');
  perform tst.login('dave');
  perform public.mod_set_reply_removed(rid, true);
  perform tst.eq((select replies from public.posts where id = v), 0, 'removing twice changes nothing');
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.notifications where kind = 'mod' and user_id = tst.uid('erin')), 1, 'and tells them once');
  perform tst.login('dave');
  perform public.mod_set_reply_removed(rid, false);
  perform tst.login('bob');
  perform tst.eq(tst.count(format('select id from public.replies where id = %s', rid)), 1::bigint, 'a restored reply is back');
  perform tst.eq((select replies from public.posts where id = v), 1, 'and counts again');
  perform tst.login('dave');
  perform public.mod_set_reply_removed(rid, true);
  perform tst.login('erin');
  delete from public.replies where id = rid;
  perform tst.eq((select replies from public.posts where id = v), 0, 'deleting a removed reply does not count it twice');
  perform tst.login('dave');
  perform tst.throws('select public.mod_set_reply_removed(999999999, true)', 'not_found', 'a missing reply is not_found');

  -- Reset a profile
  perform tst.login('erin');
  update public.profiles set name = 'Offensive Name', bio = 'offensive bio' where id = auth.uid();
  perform tst.login('dave');
  perform public.mod_reset_profile(tst.uid('erin'));
  perform tst.ok((select name = 'erin' and bio = '' from public.profiles where id = tst.uid('erin')),
                 'resetting a profile puts the name back to the handle and clears the bio');
  perform tst.logout();
  perform tst.eq((select data->>'action' from public.notifications where user_id = tst.uid('erin') and data->>'action' = 'profile_reset'),
                 'profile_reset', 'the person is told');
  perform tst.login('dave');
  perform tst.throws(format('select public.mod_reset_profile(%L)', gen_random_uuid()), 'not_found', 'a missing profile is not_found');
end $$;
rollback;

-- Blocking a moderator does not hide anything from them. Members are still protected.
begin;
do $$
declare
  v bigint;
  va bigint;
  rid bigint;
begin
  v := tst.post('frank', 'frank posts after blocking the mods');
  va := tst.post('alice', 'alice thread');
  perform tst.login('frank');
  insert into public.replies (post_id, body) values (va, 'frank reply') returning id into rid;
  insert into public.blocks (blocked) values (tst.uid('dave'));
  insert into public.blocks (blocked) values (tst.uid('carol'));
  perform tst.login('dave');
  perform tst.ok(exists (select 1 from public.posts where id = v), 'a moderator can read posts by someone who blocked them');
  perform tst.ok(exists (select 1 from public.feed() f where f.id = v), 'and sees them in their feed');
  perform tst.ok(exists (select 1 from public.posts_by(tst.uid('frank')) f where f.id = v), 'and on their profile');
  perform tst.ok(exists (select 1 from public.replies where id = rid), 'and their replies');
  perform tst.login('carol');
  perform tst.ok(not exists (select 1 from public.posts where id = v), 'a member who was blocked still cannot');
  perform tst.ok(not exists (select 1 from public.replies where id = rid), 'nor read their replies');
end $$;
rollback;

-- A banned admin loses every moderation power and cannot unban themselves.
begin;
do $$
declare
  v bigint;
begin
  update public.profiles set is_admin = true where handle = 'erin';
  v := tst.post('alice', 'post for banned-admin checks');

  perform tst.login('dave');
  perform public.mod_set_banned(tst.uid('erin'), true);
  perform tst.throws(format('select public.mod_set_banned(%L, false)', tst.uid('dave')), 'not_allowed',
                     'an admin cannot unban themselves');

  perform tst.login('erin');
  perform tst.eq(public.is_admin(), false, 'is_admin() is false for a banned admin');
  perform tst.throws(format('select public.mod_set_banned(%L, false)', tst.uid('erin')), 'not_admin',
                     'a banned admin cannot unban themselves');
  perform tst.throws('select * from public.mod_open_reports()', 'not_admin', 'a banned admin cannot list reports');
  perform tst.throws(format('select public.mod_set_post_removed(%s, true)', v), 'not_admin',
                     'a banned admin cannot remove posts');
  perform tst.throws($q$select public.mod_set_switch('ads', true)$q$, 'not_admin',
                     'a banned admin cannot flip the ads switch');
  perform tst.throws($q$select public.mod_create_duel('t', 'a', 'a', 'b', 'b', 5)$q$, 'not_admin',
                     'a banned admin cannot create duels');
  perform tst.throws($q$insert into public.ads (brand, bid_cents, copy) values ('Sneaky', 5, 'buy')$q$, '42501',
                     'a banned admin cannot create ads');

  perform tst.login('dave');
  perform public.mod_set_banned(tst.uid('erin'), false);
  perform tst.login('erin');
  perform tst.eq(public.is_admin(), true, 'an unbanned admin gets moderation back');
end $$;
rollback;
