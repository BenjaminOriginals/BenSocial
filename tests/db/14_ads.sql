-- HELD: ads and record_ad_view, behind the server switch in public.settings.

select tst.eq((select count(*)::int from public.ads), 3, 'seed added three example ads');
select tst.eq((select count(*)::int from public.ads where active), 0, 'every seeded ad is held (inactive)');
select tst.eq((select count(*)::int from public.duels), 3, 'seed added three duels, once');

begin;
do $$
declare
  ad bigint := (select id from public.ads where brand = 'Atlas Languages');
  held bigint := (select id from public.ads where brand = 'Pebble Bank');
  r json;
begin
  perform tst.login('alice');
  perform tst.eq(tst.count('select * from public.ads'), 0::bigint, 'members see no held ads');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'ads_off', 'held ads pay nothing');

  -- An active ad while ads are still off on the server: the app's switch
  -- alone (or a forgotten ad row) never pays anyone.
  perform tst.logout();
  update public.ads set active = true, bid_cents = 10 where id = ad;
  perform tst.login('alice');
  perform tst.eq(tst.count('select * from public.ads'), 0::bigint, 'active ads stay hidden while ads are off on the server');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'ads_off',
                     'active ads pay nothing while ads are off on the server');
  perform tst.eq((select earnings_cents from tst.profiles where id = auth.uid()), 0::numeric, 'no earnings while ads are off');

  perform tst.logout();
  update public.settings set ads_enabled = true;
  perform tst.login('alice');
  perform tst.eq(tst.count('select * from public.ads'), 1::bigint, 'active ads are visible once ads are on');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', held, current_date), 'not_found', 'inactive ads pay nothing');

  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 7.00::numeric, 'viewer earns 70% of the bid');
  perform tst.eq((r->>'earnings_cents')::numeric, 7.00::numeric, 'earnings total returned');
  perform tst.eq((select earnings_cents from tst.profiles where id = auth.uid()), 7.00::numeric, 'earnings stored on the profile');

  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 0::numeric, 'second view the same day earns 0');
  perform tst.eq((r->>'earnings_cents')::numeric, 7.00::numeric, 'total unchanged on a repeat view');

  r := public.record_ad_view(ad, current_date + 1);
  perform tst.eq((r->>'earned_cents')::numeric, 7.00::numeric, 'a new day pays again');
  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 0::numeric, 'going back a day does not pay again');
  perform tst.eq(tst.count('select * from public.ad_views'), 2::bigint, 'one ad_views row per paid day');

  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date + 2), 'bad_date', 'far dates are bad_date');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', 999999999, current_date), 'not_found', 'missing ad is not_found');
  perform tst.throws(format('insert into public.ad_views (user_id, ad_id, day, earned_cents) values (auth.uid(), %s, %L, 1000)',
                            ad, current_date - 1), '42501', 'clients cannot write ad_views');
  update public.ads set bid_cents = 1000 where id = ad;
  perform tst.eq((select bid_cents from public.ads where id = ad), 10.00::numeric, 'members cannot edit ads');
  delete from public.ads where id = ad;
  perform tst.eq(tst.count('select * from public.ads'), 1::bigint, 'members cannot delete ads');

  -- Attention price: bids below it pay nothing.
  update public.profiles set ad_price_cents = 15 where id = auth.uid();
  perform tst.login('bob');
  update public.profiles set ad_price_cents = 15 where id = auth.uid();
  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 0::numeric, 'bid below the attention price pays nothing');
  update public.profiles set ad_price_cents = 10 where id = auth.uid();
  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 7.00::numeric, 'bid equal to the attention price pays');
  perform tst.eq(tst.count('select * from public.ad_views'), 1::bigint, 'ad_views are private');

  perform tst.logout();
  update public.profiles set is_banned = true where id = tst.uid('erin');
  perform tst.login('erin');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'banned', 'banned users earn nothing');
  perform tst.anon();
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), '42501', 'anon cannot record ad views');

  -- Parking ads again: turning the server switch off stops every payout at once.
  perform tst.logout();
  update public.settings set ads_enabled = false;
  perform tst.login('carol');
  perform tst.eq(tst.count('select * from public.ads'), 0::bigint, 'ads disappear when the server switch goes off');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'ads_off', 'and nothing pays');
end $$;
rollback;

-- A date a day either side cannot turn one real day into three ad credits.
begin;
update public.settings set ads_enabled = true;
update public.ads set active = true, bid_cents = 10 where brand = 'Atlas Languages';
select tst.login('erin');
do $$
declare
  ad bigint := (select id from public.ads where brand = 'Atlas Languages');
begin
  perform tst.eq((public.record_ad_view(ad, current_date - 1)->>'earned_cents')::numeric, 7.00::numeric, 'yesterday''s date pays');
  perform tst.eq((public.record_ad_view(ad, current_date)->>'earned_cents')::numeric, 7.00::numeric, 'today''s date pays (a new local day)');
  perform tst.eq((public.record_ad_view(ad, current_date + 1)->>'earned_cents')::numeric, 0::numeric,
                 'a third date within 20 hours pays nothing');
  perform tst.eq((select earnings_cents from tst.profiles where id = auth.uid()), 14.00::numeric, 'two credits, not three');
end $$;
rollback;

begin;
update public.settings set ads_enabled = true;
update public.ads set active = true, bid_cents = 10 where brand = 'Atlas Languages';
-- A view from yesterday, 21 hours ago, then today: both fine.
insert into public.ad_views (user_id, ad_id, day, earned_cents, created_at)
select tst.uid('erin'), id, current_date - 1, 7, now() - interval '21 hours' from public.ads where brand = 'Atlas Languages';
select tst.login('erin');
select tst.eq((public.record_ad_view((select id from public.ads where brand = 'Atlas Languages'), current_date)->>'earned_cents')::numeric,
              7.00::numeric, 'a new day after 20 hours pays');
rollback;

-- Fractional bids round to the cent
begin;
update public.settings set ads_enabled = true;
update public.ads set active = true, bid_cents = 3.33 where brand = 'Fieldnote Paper Co.';
update public.profiles set ad_price_cents = 1 where id = tst.uid('carol');
select tst.login('carol');
select tst.eq((public.record_ad_view((select id from public.ads where brand = 'Fieldnote Paper Co.'), current_date)->>'earned_cents')::numeric,
              2.33::numeric, '70% of 3.33 rounds to 2.33');
rollback;
