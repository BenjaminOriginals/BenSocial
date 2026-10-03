-- Profiles: column privileges, own-row updates, handle rules, handle_available.

begin;
select tst.login('alice');

-- Allowed columns
select tst.lives($q$update public.profiles set name = 'Alice A.', hue = 200, bio = 'Hi there',
                     dial = '{"recency":50}', ad_price_cents = 9
                   where id = auth.uid()$q$,
                 'can update name, hue, bio, dial, ad_price_cents on own row');
select tst.eq((select name from public.profiles where id = auth.uid()), 'Alice A.', 'name updated');
select tst.eq((select bio from public.profiles where id = auth.uid()), 'Hi there', 'bio updated');
select tst.eq((select dial->>'recency' from tst.profiles where id = auth.uid()), '50', 'dial updated');
select tst.eq((select ad_price_cents from tst.profiles where id = auth.uid()), 9, 'ad price updated');
select tst.lives($q$update public.profiles set handle = 'Alice.New' where id = auth.uid()$q$,
                 'can update own handle');
select tst.eq((select handle from public.profiles where id = auth.uid()), 'alice.new', 'handle is lowercased on update');
select tst.lives($q$update public.profiles set name = '  Spaced  ' where id = auth.uid()$q$, 'name with spaces accepted');
select tst.eq((select name from public.profiles where id = auth.uid()), 'Spaced', 'name is trimmed on update');

-- Handle rules
select tst.throws($q$update public.profiles set handle = 'bob' where id = auth.uid()$q$,
                  'handle_taken', 'taking another handle raises handle_taken');
select tst.throws($q$update public.profiles set handle = 'BOB' where id = auth.uid()$q$,
                  'handle_taken', 'taking another handle in other case raises handle_taken');
select tst.throws($q$update public.profiles set handle = 'a b' where id = auth.uid()$q$,
                  '23514', 'invalid handle rejected');
select tst.throws($q$update public.profiles set handle = 'ab' where id = auth.uid()$q$,
                  '23514', 'two-character handle rejected');
select tst.throws($q$update public.profiles set bio = repeat('x', 161) where id = auth.uid()$q$,
                  '23514', 'bio over 160 characters rejected');
select tst.lives($q$update public.profiles set bio = repeat('x', 160) where id = auth.uid()$q$,
                 'bio of 160 characters accepted');
select tst.throws($q$update public.profiles set name = '' where id = auth.uid()$q$,
                  '23514', 'empty name rejected');
select tst.throws($q$update public.profiles set name = repeat('n', 41) where id = auth.uid()$q$,
                  '23514', 'name over 40 characters rejected');
select tst.throws($q$update public.profiles set ad_price_cents = 21 where id = auth.uid()$q$,
                  '23514', 'attention price above 20 rejected');
select tst.throws($q$update public.profiles set ad_price_cents = 0 where id = auth.uid()$q$,
                  '23514', 'attention price below 1 rejected');
select tst.throws($q$update public.profiles set hue = 360 where id = auth.uid()$q$,
                  '23514', 'hue 360 rejected');
select tst.throws($q$update public.profiles set dial = to_jsonb(repeat('x', 5000)) where id = auth.uid()$q$,
                  '23514', 'oversized dial rejected');

-- Forbidden columns
select tst.throws($q$update public.profiles set xp = 99999 where id = auth.uid()$q$, '42501', 'cannot update xp');
select tst.throws($q$update public.profiles set clout = 99999 where id = auth.uid()$q$, '42501', 'cannot update clout');
select tst.throws($q$update public.profiles set is_admin = true where id = auth.uid()$q$, '42501', 'cannot update is_admin');
select tst.throws($q$update public.profiles set is_banned = false where id = auth.uid()$q$, '42501', 'cannot update is_banned');
select tst.throws($q$update public.profiles set pro = true where id = auth.uid()$q$, '42501', 'cannot update pro');
select tst.throws($q$update public.profiles set earnings_cents = 1000 where id = auth.uid()$q$, '42501', 'cannot update earnings_cents');
select tst.throws($q$update public.profiles set streak = 100 where id = auth.uid()$q$, '42501', 'cannot update streak');
select tst.throws($q$update public.profiles set drop_day = null where id = auth.uid()$q$, '42501', 'cannot update drop_day');
select tst.throws($q$update public.profiles set followers_count = 1000 where id = auth.uid()$q$, '42501', 'cannot update followers_count');
select tst.throws($q$update public.profiles set id = gen_random_uuid() where id = auth.uid()$q$, '42501', 'cannot update id');
select tst.throws($q$update public.profiles set accepted_terms_at = null where id = auth.uid()$q$, '42501', 'cannot update accepted_terms_at');
select tst.throws($q$insert into public.profiles (id, handle, name) values (gen_random_uuid(), 'sneaky', 'Sneaky')$q$,
                  '42501', 'cannot insert profiles');
select tst.throws($q$delete from public.profiles where id = auth.uid()$q$, '42501', 'cannot delete profiles');

-- Another user's row
update public.profiles set name = 'Hacked', bio = 'pwned' where id = tst.uid('bob');
select tst.eq((select name from public.profiles where id = tst.uid('bob')), 'Bob', 'cannot update another user''s row');

-- Reading
select tst.eq((select handle from public.profiles where id = tst.uid('bob')), 'bob', 'can read other profiles');
select tst.eq(tst.count('select id from public.profiles'), 7::bigint, 'can list profiles');
rollback;

-- Privacy: other people see only the public columns. Your own private
-- columns (XP, clout, streak, dial, earnings, admin flag) come from my_profile().
begin;
update public.profiles set earnings_cents = 14, clout = 777, dial = '{"spicy":80}' where id = tst.uid('bob');
select tst.login('carol');
select tst.lives($q$select id, handle, name, hue, bio, pro, followers_count, following_count, is_banned, created_at
                     from public.profiles$q$, 'public profile columns are readable');
do $$
declare
  c text;
begin
  foreach c in array array['xp', 'clout', 'streak', 'last_active', 'active_days', 'drop_day', 'dial',
                           'ad_price_cents', 'earnings_cents', 'is_admin', 'accepted_terms_at'] loop
    perform tst.throws(format('select %I from public.profiles where id = %L', c, tst.uid('bob')), '42501',
                       'members cannot read ' || c || ' of other people');
  end loop;
end $$;
select tst.throws($q$select * from public.profiles$q$, '42501', 'select * on profiles is refused (it includes private columns)');
select tst.throws($q$select handle from public.profiles where is_admin$q$, '42501', 'members cannot list the moderators');
select tst.throws($q$select handle from public.profiles where earnings_cents > 0$q$, '42501', 'members cannot filter on earnings');
select tst.login('bob');
select tst.throws($q$select clout from public.profiles where id = auth.uid()$q$, '42501', 'even your own private columns are not in the table API');
select tst.eq((public.my_profile()->>'clout')::numeric, 777::numeric, 'my_profile returns your clout');
select tst.eq((public.my_profile()->>'earnings_cents')::numeric, 14::numeric, 'my_profile returns your earnings');
select tst.eq(public.my_profile()->'dial'->>'spicy', '80', 'my_profile returns your dial');
select tst.eq(public.my_profile()->>'handle', 'bob', 'my_profile is your own row');
select tst.eq((select count(*)::int from json_object_keys(public.my_profile())),
              (select count(*)::int from pg_attribute where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped),
              'my_profile has every column');
select tst.lives($q$update public.profiles set dial = '{"spicy":10}', ad_price_cents = 5 where id = auth.uid()$q$,
                 'saving the dial and attention price still works with column privileges');
select tst.eq(public.my_profile()->'dial'->>'spicy', '10', 'dial saved');
select tst.login_id('99999999-9999-4999-8999-999999999999');
select tst.ok(public.my_profile() is null, 'my_profile is null without a profile');
select tst.anon();
select tst.throws($q$select public.my_profile()$q$, '42501', 'anon cannot call my_profile');
rollback;

-- Reserved handles and names
begin;
select tst.login('alice');
do $$
declare
  h text;
begin
  foreach h in array array['admin', 'bensocial', 'support', 'moderator', 'official', 'root', 'staff', 'help',
                           'security', 'ben.social', 'bensocial_team', 'the_ben_social'] loop
    perform tst.eq(public.handle_available(h), false, 'handle_available: ' || h || ' is reserved');
    perform tst.throws(format('update public.profiles set handle = %L where id = auth.uid()', h), 'handle_taken',
                       'members cannot take the reserved handle ' || h);
  end loop;
end $$;
select tst.eq(public.handle_available('benjamin'), true, 'handles merely starting with ben are free');
select tst.throws($q$update public.profiles set name = 'BenSocial Support' where id = auth.uid()$q$, 'name_reserved',
                  'members cannot use BenSocial in their name');
select tst.throws($q$update public.profiles set name = 'Ben.Social team' where id = auth.uid()$q$, 'name_reserved',
                  'BenSocial with punctuation is caught too');
select tst.lives($q$update public.profiles set name = 'Ben from Social Club' where id = auth.uid()$q$, 'ordinary names are fine');
select tst.login('dave');
select tst.lives($q$update public.profiles set handle = 'bensocial', name = 'BenSocial' where id = auth.uid()$q$,
                 'admins can take a reserved handle and the BenSocial name');
select tst.logout();
select tst.lives($q$update public.profiles set handle = 'support' where id = tst.uid('erin')$q$,
                 'the owner can hand out a reserved handle in the SQL editor');
rollback;

begin;
do $$
declare
  v uuid;
begin
  v := tst.signup(null, '2c000000-0000-4000-8000-0000000000aa', '{"handle":"bensocial","name":"BenSocial Support"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user2c000000', 'sign-up with a reserved handle falls back');
  perform tst.eq((select name from public.profiles where id = v), 'user2c000000', 'sign-up with BenSocial in the name falls back to the handle');
  v := tst.signup(null, '2d000000-0000-4000-8000-0000000000ab', '{"handle":"admin"}');
  perform tst.eq((select handle from public.profiles where id = v), 'user2d000000', 'sign-up with admin falls back');
end $$;
rollback;

-- handle_available
begin;
select tst.login('alice');
select tst.eq(public.handle_available('bob'), false, 'handle_available: taken handle is false');
select tst.eq(public.handle_available('BOB'), false, 'handle_available: taken handle in caps is false');
select tst.eq(public.handle_available('brand.new_1'), true, 'handle_available: free valid handle is true');
select tst.eq(public.handle_available('ab'), false, 'handle_available: too short is false');
select tst.eq(public.handle_available('has space'), false, 'handle_available: invalid characters is false');
select tst.eq(public.handle_available(repeat('a', 21)), false, 'handle_available: too long is false');
select tst.eq(public.handle_available(null), false, 'handle_available: null is false');
select tst.eq(public.handle_available(''), false, 'handle_available: empty is false');
rollback;

begin;
select tst.anon();
select tst.eq(public.handle_available('brand.new_1'), true, 'anon can call handle_available');
select tst.eq(public.handle_available('carol'), false, 'anon sees taken handles as unavailable');
select tst.throws($q$select * from public.profiles$q$, '42501', 'anon cannot read profiles');
rollback;
