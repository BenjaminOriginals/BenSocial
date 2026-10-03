-- Reports: one target, reasons, limits, privacy, survives deleted content.

begin;
do $$
declare
  v bigint;
  rid bigint;
  rp public.reports%rowtype;
  v_rep bigint;
  n int;
begin
  v := tst.post('alice', 'reportable');
  perform tst.login('bob');
  insert into public.replies (post_id, body) values (v, 'a reply') returning id into rid;

  perform tst.login('carol');
  insert into public.reports (post_id, reason, details) values (v, 'spam', 'Looks like spam') returning id into v_rep;
  select * into rp from tst.reports where id = v_rep;
  perform tst.eq(rp.reporter, tst.uid('carol'), 'reporter is the caller');
  perform tst.eq(rp.status, 'open', 'new reports are open');
  perform tst.lives(format('insert into public.reports (reply_id, reason) values (%s, %L)', rid, 'harassment'),
                    'can report a reply');
  perform tst.lives(format('insert into public.reports (profile_id, reason, details) values (%L, %L, %L)', tst.uid('alice'), 'other', ''),
                    'can report a profile');
  perform tst.lives(format('insert into public.reports (post_id, reason, details) values (%s, %L, null)', v, 'self_harm'),
                    'details may be null');

  perform tst.throws($q$insert into public.reports (reason) values ('spam')$q$, '42501', 'a report needs a target');
  perform tst.throws(format('insert into public.reports (post_id, reply_id, reason) values (%s, %s, %L)', v, rid, 'spam'),
                     '42501', 'a report cannot have two targets');
  perform tst.throws(format('insert into public.reports (post_id, profile_id, reason) values (%s, %L, %L)', v, tst.uid('alice'), 'spam'),
                     '42501', 'a report cannot target a post and a profile');
  perform tst.throws(format('insert into public.reports (post_id, reason) values (%s, %L)', v, 'boring'),
                     '23514', 'unknown reason rejected');
  perform tst.throws(format('insert into public.reports (post_id, reason, details) values (%s, %L, %L)', v, 'spam', repeat('d', 501)),
                     '23514', 'details over 500 characters rejected');
  perform tst.lives(format('insert into public.reports (post_id, reason, details) values (%s, %L, %L)', v, 'misinformation', repeat('d', 500)),
                    'details of 500 characters accepted');
  perform tst.throws(format('insert into public.reports (post_id, reason, reporter) values (%s, %L, %L)', v, 'spam', tst.uid('dave')),
                     '42501', 'cannot file a report as someone else');
  perform tst.throws(format('insert into public.reports (post_id, reason, status) values (%s, %L, %L)', v, 'spam', 'actioned'),
                     '42501', 'cannot set the status when filing');

  -- every documented reason is accepted
  perform tst.lives(format($f$insert into public.reports (profile_id, reason)
                            select %L, r from unnest(array['spam','harassment','hate','violence','sexual','self_harm','misinformation','other']) r$f$,
                           tst.uid('bob')),
                    'all eight reasons accepted');

  perform tst.eq(tst.count('select id, reporter, post_id, reply_id, profile_id, reason, details, status, created_at from public.reports'),
                 13::bigint, 'reporter sees their reports');
  perform tst.throws('select content from public.reports', '42501', 'reporters cannot read the server''s copy of the content');
  perform tst.throws('select target_user from public.reports', '42501', 'reporters cannot read the reported author from the copy');
  update public.reports set status = 'dismissed' where reporter = auth.uid();
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'non-admins cannot change report status');
  perform tst.throws($q$delete from public.reports$q$, '42501', 'reports cannot be deleted by clients');

  perform tst.login('alice');
  perform tst.eq(tst.count('select id from public.reports'), 0::bigint, 'reports are private to the reporter');

  perform tst.login('dave');
  perform tst.eq(tst.count('select id from public.reports'), 13::bigint, 'admins see all reports');
  update public.reports set status = 'dismissed' where id = rp.id;
  get diagnostics n = row_count;
  perform tst.eq(n, 1, 'admins can change report status');
  perform tst.throws(format('update public.reports set reason = %L where id = %s', 'other', rp.id), '42501',
                     'even admins cannot rewrite the reason');

  -- Deleting the reported content keeps the report.
  perform tst.login('bob');
  delete from public.replies where id = rid;
  perform tst.login('alice');
  delete from public.posts where id = v;
  get diagnostics n = row_count;
  perform tst.eq(n, 1, 'a reported post can still be deleted');
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.reports where reporter = tst.uid('carol')), 13, 'reports survive deleted content');
  perform tst.eq((select post_id from public.reports where id = rp.id), null::bigint, 'deleted target becomes null');
  perform tst.eq((select content from tst.reports where id = rp.id), 'reportable', 'the report keeps a copy of the deleted post');
  perform tst.eq((select target_user from tst.reports where id = rp.id), tst.uid('alice'), 'the report keeps the deleted post''s author');
end $$;
rollback;

-- The copy taken when a report is filed: author, handle and content.
begin;
do $$
declare
  v bigint;
  rid bigint;
  r public.reports%rowtype;
  rep bigint;
begin
  v := tst.post('alice', 'post body to copy');
  perform tst.login('bob');
  insert into public.replies (post_id, body) values (v, 'reply body to copy') returning id into rid;
  perform tst.login('carol');
  insert into public.reports (post_id, reason) values (v, 'spam') returning id into rep;
  select * into r from tst.reports where id = rep;
  perform tst.ok(r.target_user = tst.uid('alice') and r.target_handle = 'alice' and r.content = 'post body to copy',
                 'post report copies author, handle and body');
  insert into public.reports (reply_id, reason) values (rid, 'harassment') returning id into rep;
  select * into r from tst.reports where id = rep;
  perform tst.ok(r.target_user = tst.uid('bob') and r.target_handle = 'bob' and r.content = 'reply body to copy',
                 'reply report copies author, handle and body');
  perform tst.logout();
  update public.profiles set bio = 'my bio' where id = tst.uid('erin');
  perform tst.login('carol');
  insert into public.reports (profile_id, reason) values (tst.uid('erin'), 'other') returning id into rep;
  select * into r from tst.reports where id = rep;
  perform tst.ok(r.target_user = tst.uid('erin') and r.content = E'Erin\nmy bio', 'profile report copies name and bio');
  perform tst.throws(format('insert into public.reports (post_id, reason, content) values (%s, %L, %L)', v, 'spam', 'forged'),
                     '42501', 'clients cannot write the copy');
  perform tst.throws(format('insert into public.reports (post_id, reason, target_user) values (%s, %L, %L)', v, 'spam', tst.uid('dave')),
                     '42501', 'clients cannot pick the reported author');
end $$;
rollback;

-- 20 reports per reporter per day
begin;
do $$
begin
  perform tst.login('carol');
  perform tst.lives(format($f$insert into public.reports (profile_id, reason) select %L, 'spam' from generate_series(1, 20)$f$, tst.uid('alice')),
                    'twenty reports in a day are fine');
  perform tst.throws(format('insert into public.reports (profile_id, reason) values (%L, %L)', tst.uid('alice'), 'spam'),
                     'slow_down', 'report 21 in a day is slow_down');
end $$;
rollback;

begin;
select tst.anon();
select tst.throws($q$insert into public.reports (profile_id, reason) values (gen_random_uuid(), 'spam')$q$, '42501',
                  'anon cannot file reports');
rollback;
