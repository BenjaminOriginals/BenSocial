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
select tst.eq((select dial->>'recency' from public.profiles where id = auth.uid()), '50', 'dial updated');
select tst.eq((select ad_price_cents from public.profiles where id = auth.uid()), 9, 'ad price updated');
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
select tst.eq(tst.count('select * from public.profiles'), 7::bigint, 'can list profiles');
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
