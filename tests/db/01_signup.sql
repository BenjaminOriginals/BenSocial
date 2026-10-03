-- Sign-up trigger.

-- The fixture accounts are created by fixtures.sql, through the same
-- sign-up trigger. These checks look at what it made.
do $$
declare
  n int;
begin
  select count(*) into n from public.profiles where handle in ('alice','bob','carol','dave','erin','frank','gina');
  perform tst.eq(n, 7, 'every fixture sign-up created a profile');
  perform tst.eq((select handle from public.profiles where id = tst.uid('alice')), 'alice',
                 'handle from metadata is lowercased');
  perform tst.eq((select name from public.profiles where id = tst.uid('alice')), 'Alice Adams',
                 'name comes from metadata');
  perform tst.ok((select accepted_terms_at is not null from public.profiles where id = tst.uid('alice')),
                 'accepted_terms_at is set at sign-up');
  perform tst.ok((select hue between 0 and 359 from public.profiles where id = tst.uid('bob')),
                 'hue is in range');
  perform tst.eq((select hue from public.profiles where id = tst.uid('bob')),
                 ((hashtext(tst.uid('bob')::text) % 360) + 360) % 360,
                 'hue is deterministic from the id');
  perform tst.eq((select clout from public.profiles where id = tst.uid('bob')), 500.00::numeric,
                 'new accounts start with 500 clout');
  perform tst.eq((select xp from public.profiles where id = tst.uid('bob')), 0, 'new accounts start with 0 xp');
  perform tst.eq((select ad_price_cents from public.profiles where id = tst.uid('bob')), 4,
                 'attention price defaults to 4');
  perform tst.ok((select not is_admin and not is_banned and not pro from public.profiles where id = tst.uid('bob')),
                 'new accounts are not admin, banned or pro');
end $$;

-- ---------------------------------------------------------------------
-- Edge cases (rolled back)
-- ---------------------------------------------------------------------
begin;
do $$
declare
  v uuid;
  p public.profiles%rowtype;
begin
  -- Invalid handle -> fallback
  v := tst.signup(null, '12345678-aaaa-4bbb-8ccc-000000000010', '{"handle":"No Spaces!","name":"Spacey"}');
  select * into p from public.profiles where id = v;
  perform tst.eq(p.handle, 'user12345678', 'invalid handle falls back to user + 8 hex');
  perform tst.eq(p.name, 'Spacey', 'name kept when handle falls back');

  -- Too short
  v := tst.signup(null, '22345678-aaaa-4bbb-8ccc-000000000011', '{"handle":"ab"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user22345678', 'short handle falls back');
  perform tst.eq((select name from public.profiles where id = v), 'user22345678', 'missing name becomes the handle');

  -- Taken handle -> fallback
  v := tst.signup(null, '9abcdef0-aaaa-4bbb-8ccc-000000000012', '{"handle":"alice","name":"Other Alice"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user9abcdef0', 'taken handle falls back');

  -- Taken handle with different case -> fallback
  v := tst.signup(null, '8abcdef0-aaaa-4bbb-8ccc-000000000013', '{"handle":"BOB","name":"Bob 2"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user8abcdef0', 'taken handle in other case falls back');

  -- Leading @ is dropped, mixed case lowered
  v := tst.signup(null, '7abcdef0-aaaa-4bbb-8ccc-000000000014', '{"handle":"@Mixed.Case_9"}');
  perform tst.eq((select handle from public.profiles where id = v), 'mixed.case_9', 'leading @ dropped and case lowered');

  -- Fallback itself taken -> longer fallback, still no failure
  v := tst.signup(null, '6abcdef0-aaaa-4bbb-8ccc-000000000015', '{"handle":"user13572468"}');
  v := tst.signup(null, '13572468-9abc-4def-8000-000000000016', '{"handle":"!!"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user135724689abc',
                 'fallback that is taken grows to 12 hex characters');

  -- Metadata missing or the wrong shape: never fails
  v := tst.signup(null, '5abcdef0-aaaa-4bbb-8ccc-000000000017', null);
  perform tst.eq((select handle from public.profiles where id = v), 'user5abcdef0', 'null metadata falls back');
  v := tst.signup(null, '4abcdef0-aaaa-4bbb-8ccc-000000000018', '"just a string"');
  perform tst.eq((select handle from public.profiles where id = v), 'user4abcdef0', 'string metadata falls back');
  v := tst.signup(null, '3abcdef0-aaaa-4bbb-8ccc-000000000019', '[1, 2, 3]');
  perform tst.eq((select handle from public.profiles where id = v), 'user3abcdef0', 'array metadata falls back');
  v := tst.signup(null, '2abcdef0-aaaa-4bbb-8ccc-000000000020', '{"handle": {"nested": true}, "name": 42}');
  perform tst.eq((select handle from public.profiles where id = v), 'user2abcdef0', 'object handle falls back');
  perform tst.eq((select name from public.profiles where id = v), '42', 'numeric name is used as text');

  -- Long and blank names
  v := tst.signup(null, '1abcdef0-aaaa-4bbb-8ccc-000000000021',
                  jsonb_build_object('handle', 'longname', 'name', repeat('n', 60)));
  perform tst.eq((select char_length(name) from public.profiles where id = v), 40, 'long name is cut to 40');
  v := tst.signup(null, '0abcdef0-aaaa-4bbb-8ccc-000000000022', '{"handle":"blankname","name":"    "}');
  perform tst.eq((select name from public.profiles where id = v), 'blankname', 'blank name becomes the handle');
  v := tst.signup(null, '0bbcdef0-aaaa-4bbb-8ccc-000000000023', '{"handle":"padded","name":"  Pat  "}');
  perform tst.eq((select name from public.profiles where id = v), 'Pat', 'name is trimmed');

  -- 20-character handle is fine, 21 falls back
  v := tst.signup(null, '0cbcdef0-aaaa-4bbb-8ccc-000000000024', '{"handle":"abcdefghij0123456789"}');
  perform tst.eq((select handle from public.profiles where id = v), 'abcdefghij0123456789', '20-character handle accepted');
  v := tst.signup(null, '0dbcdef0-aaaa-4bbb-8ccc-000000000025', '{"handle":"abcdefghij0123456789x"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user0dbcdef0', '21-character handle falls back');
end $$;
rollback;

-- The trigger runs as supabase_auth_admin with search_path = auth, like GoTrue.
begin;
set local role supabase_auth_admin;
set local search_path = auth;
insert into users (id, email, raw_user_meta_data)
values ('0ebcdef0-aaaa-4bbb-8ccc-000000000026', 'gotrue@example.test', '{"handle":"viagotrue","name":"Via GoTrue"}');
reset role;
reset search_path;
select tst.eq((select handle from public.profiles where id = '0ebcdef0-aaaa-4bbb-8ccc-000000000026'),
              'viagotrue', 'sign-up works as supabase_auth_admin with search_path auth');
rollback;

-- Sign-up never fails, even if profile creation breaks.
begin;
alter table public.profiles add constraint tst_break_signup check (handle <> handle) not valid;
select tst.lives($q$
  insert into auth.users (id, email, raw_user_meta_data)
  values ('0fbcdef0-aaaa-4bbb-8ccc-000000000027', 'broken@example.test', '{"handle":"broken"}')
$q$, 'sign-up still succeeds when the profile insert fails');
select tst.eq((select count(*)::int from auth.users where id = '0fbcdef0-aaaa-4bbb-8ccc-000000000027'), 1,
              'the auth user exists after a failed profile insert');
rollback;

-- Schema backfill creates profiles for accounts that predate the trigger.
begin;
alter table auth.users disable trigger bensocial_on_auth_user_created;
insert into auth.users (id, email, raw_user_meta_data)
values ('0abbcdef-aaaa-4bbb-8ccc-000000000028', 'early@example.test', '{"handle":"earlybird","name":"Early"}');
alter table auth.users enable trigger bensocial_on_auth_user_created;
select tst.eq((select count(*)::int from public.profiles where id = '0abbcdef-aaaa-4bbb-8ccc-000000000028'), 0,
              'no profile while the trigger was off');
do $$
begin
  perform public.create_profile(u.id, u.raw_user_meta_data)
     from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id);
end $$;
select tst.eq((select handle from public.profiles where id = '0abbcdef-aaaa-4bbb-8ccc-000000000028'), 'earlybird',
              'backfill creates the missing profile');
rollback;

-- touch_streak (called on every app start) repairs a missing profile.
begin;
select tst.signup('healme', '0acbcdef-aaaa-4bbb-8ccc-000000000029', '{"handle":"healme","name":"Heal Me"}');
delete from public.profiles where id = '0acbcdef-aaaa-4bbb-8ccc-000000000029';
select tst.login('healme');
select tst.eq((select count(*)::int from public.profiles where id = auth.uid()), 0, 'setup: profile is missing');
select tst.eq((public.touch_streak(current_date)->>'streak')::int, 1, 'touch_streak works without a profile');
select tst.eq((select handle from public.profiles where id = auth.uid()), 'healme', 'touch_streak recreated the profile');
select tst.lives($q$update public.profiles set name = 'Healed' where id = auth.uid()$q$, 'the finish-your-profile update now works');
select tst.eq((select name from public.profiles where id = auth.uid()), 'Healed', 'profile update landed');
rollback;
