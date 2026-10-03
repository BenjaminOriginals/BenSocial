-- touch_streak and claim_daily_drop.

begin;
do $$
declare
  r json;
begin
  perform tst.login('alice');
  r := public.touch_streak(current_date);
  perform tst.eq((r->>'streak')::int, 1, 'first visit starts a streak of 1');
  perform tst.eq((r->>'last_active')::date, current_date, 'last_active is today');
  perform tst.eq((select array_agg(x::date) from json_array_elements_text(r->'active_days') x), array[current_date],
                 'active_days holds today');

  r := public.touch_streak(current_date);
  perform tst.eq((r->>'streak')::int, 1, 'second visit the same day changes nothing');
  perform tst.eq(json_array_length(r->'active_days'), 1, 'same day is not added twice');

  perform tst.throws(format('select public.touch_streak(%L)', current_date + 2), 'bad_date', 'two days ahead is bad_date');
  perform tst.throws(format('select public.touch_streak(%L)', current_date - 2), 'bad_date', 'two days back is bad_date');
  perform tst.throws('select public.touch_streak(null)', 'bad_date', 'null date is bad_date');
  perform tst.lives(format('select public.touch_streak(%L)', current_date + 1), 'tomorrow (time zones) is accepted');
end $$;
rollback;

begin;
-- Yesterday -> +1
update public.profiles set streak = 3, last_active = current_date - 1,
       active_days = array[current_date - 3, current_date - 2, current_date - 1]
 where id = tst.uid('alice');
select tst.login('alice');
select tst.eq((public.touch_streak(current_date)->>'streak')::int, 4, 'visiting the day after continues the streak');
select tst.eq((select active_days from public.profiles where id = auth.uid()),
              array[current_date - 3, current_date - 2, current_date - 1, current_date],
              'active_days appends today in order');
rollback;

begin;
-- Gap -> reset to 1
update public.profiles set streak = 9, last_active = current_date - 3 where id = tst.uid('alice');
select tst.login('alice');
select tst.eq((public.touch_streak(current_date)->>'streak')::int, 1, 'missing a day resets the streak to 1');
rollback;

begin;
-- A date already counted (client clock moved back) changes nothing
update public.profiles set streak = 5, last_active = current_date + 1 where id = tst.uid('alice');
select tst.login('alice');
select tst.eq((public.touch_streak(current_date)->>'streak')::int, 5, 'an earlier date than last_active changes nothing');
rollback;

begin;
-- Keeps the last 30 active days
update public.profiles
   set streak = 40, last_active = current_date - 1,
       active_days = (select array_agg(d::date order by d) from generate_series(current_date - 40, current_date - 1, interval '1 day') d)
 where id = tst.uid('alice');
select tst.login('alice');
select tst.eq((select array_length(active_days, 1) from public.profiles where id = auth.uid()), 40, 'setup: 40 active days');
select public.touch_streak(current_date);
select tst.eq((select array_length(active_days, 1) from public.profiles where id = auth.uid()), 30, 'active_days keeps 30');
select tst.eq((select active_days[30] from public.profiles where id = auth.uid()), current_date, 'newest day is last');
select tst.eq((select active_days[1] from public.profiles where id = auth.uid()), current_date - 29, 'oldest days drop off');
rollback;

-- Daily drop
begin;
do $$
declare
  r json;
  v_clout numeric;
  v_xp int;
begin
  perform tst.login('alice');
  select clout, xp into v_clout, v_xp from public.profiles where id = auth.uid();
  r := public.claim_daily_drop(current_date);
  perform tst.ok((r->>'amount')::int between 40 and 160, 'drop amount is 40 to 160');
  perform tst.eq((r->>'clout')::numeric, v_clout + (r->>'amount')::int, 'drop adds the amount to clout');
  perform tst.eq((r->>'xp')::int, v_xp + 20, 'drop gives 20 XP');
  perform tst.eq((select drop_day from public.profiles where id = auth.uid()), current_date, 'drop_day recorded');
  perform tst.throws(format('select public.claim_daily_drop(%L)', current_date), 'already_claimed', 'second claim the same day');
  perform tst.throws(format('select public.claim_daily_drop(%L)', current_date - 1), 'already_claimed',
                     'claiming an earlier day after today is already_claimed');
  perform tst.throws(format('select public.claim_daily_drop(%L)', current_date + 2), 'bad_date', 'drop two days ahead is bad_date');
  perform tst.throws(format('select public.claim_daily_drop(%L)', current_date - 2), 'bad_date', 'drop two days back is bad_date');
  perform tst.throws('select public.claim_daily_drop(null)', 'bad_date', 'drop with null date is bad_date');
end $$;
rollback;

begin;
-- Next day works again
update public.profiles set drop_day = current_date - 1 where id = tst.uid('alice');
select tst.login('alice');
select tst.lives(format('select public.claim_daily_drop(%L)', current_date), 'a new day can be claimed');
rollback;

begin;
-- Pro doubles the drop (held with payments, but the rule is in place)
update public.profiles set pro = true where id = tst.uid('alice');
select tst.login('alice');
do $$
declare
  a int := (public.claim_daily_drop(current_date)->>'amount')::int;
begin
  perform tst.ok(a between 80 and 320 and a % 2 = 0, 'pro drop is doubled');
end $$;
rollback;

begin;
update public.profiles set is_banned = true where id = tst.uid('erin');
select tst.login('erin');
select tst.throws(format('select public.claim_daily_drop(%L)', current_date), 'banned', 'banned users get no drop');
select tst.anon();
select tst.throws(format('select public.claim_daily_drop(%L)', current_date), '42501', 'anon cannot claim a drop');
select tst.throws(format('select public.touch_streak(%L)', current_date), '42501', 'anon cannot touch a streak');
rollback;
