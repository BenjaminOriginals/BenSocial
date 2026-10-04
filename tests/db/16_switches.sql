-- The monetization switchboard in live mode: app_switches() tells the app
-- what is on, and mod_set_switch() lets admins turn ads on and off.
-- public.settings is the only authority; nothing in the browser counts.

-- app_switches(): what the app reads at start and every 30 seconds.
begin;
select tst.login('alice');
select tst.eq(public.app_switches()::jsonb, '{"ads": false, "payments": false}'::jsonb, 'members read both switches, off to start');
select tst.logout();
update public.settings set ads_enabled = true;
select tst.login('alice');
select tst.eq(public.app_switches()::jsonb, '{"ads": true, "payments": false}'::jsonb, 'app_switches follows ads_enabled');
select tst.logout();
update public.settings set ads_enabled = false, payments_enabled = true;
select tst.login('erin');
select tst.eq(public.app_switches()::jsonb, '{"ads": false, "payments": true}'::jsonb, 'app_switches follows payments_enabled');
select tst.anon();
select tst.throws('select public.app_switches()', '42501', 'anon cannot read the switches');
rollback;

-- An empty settings table reads as everything off.
begin;
delete from public.settings;
select tst.login('bob');
select tst.eq(public.app_switches()::jsonb, '{"ads": false, "payments": false}'::jsonb, 'no settings row reads as both off');
rollback;

-- mod_set_switch(): admins only.
begin;
select tst.login('alice');
select tst.throws($q$select public.mod_set_switch('ads', true)$q$, 'not_admin', 'members cannot turn ads on');
select tst.throws($q$select public.mod_set_switch('ads', false)$q$, 'not_admin', 'members cannot turn ads off');
select tst.anon();
select tst.throws($q$select public.mod_set_switch('ads', true)$q$, '42501', 'anon cannot call mod_set_switch');
select tst.logout();
select tst.ok((select not ads_enabled from public.settings), 'refused calls changed nothing');
rollback;

begin;
set local role authenticated;
select tst.throws($q$select public.mod_set_switch('ads', true)$q$, 'not_authenticated', 'mod_set_switch needs a user');
rollback;

-- Only ads can be switched here, and only to true or false.
begin;
select tst.login('dave');
select tst.throws($q$select public.mod_set_switch('payments', true)$q$, 'bad_switch', 'payments cannot be turned on from the app');
select tst.throws($q$select public.mod_set_switch('payments', false)$q$, 'bad_switch', 'payments cannot be turned off from the app either');
select tst.throws($q$select public.mod_set_switch('Ads', true)$q$, 'bad_switch', 'switch names are exact');
select tst.throws($q$select public.mod_set_switch('everything', true)$q$, 'bad_switch', 'unknown switches are refused');
select tst.throws($q$select public.mod_set_switch(null, true)$q$, 'bad_switch', 'a missing name is refused');
select tst.throws($q$select public.mod_set_switch('ads', null)$q$, 'bad_switch', 'a missing value is refused');
select tst.logout();
select tst.ok((select not ads_enabled and not payments_enabled from public.settings), 'refused switches changed nothing');
rollback;

-- An admin turns ads on: ads show and pay. Off again: they stop at once.
begin;
update public.ads set active = true, bid_cents = 10 where brand = 'Atlas Languages';
update public.settings set updated_at = now() - interval '1 day';
do $$
declare
  ad bigint := (select id from public.ads where brand = 'Atlas Languages');
  r json;
begin
  perform tst.login('carol');
  perform tst.eq(tst.count('select * from public.ads'), 0::bigint, 'before: members see no ads');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'ads_off', 'before: no ad pays');

  perform tst.login('dave');
  r := public.mod_set_switch('ads', true);
  perform tst.eq(r::jsonb, '{"ads": true, "payments": false}'::jsonb, 'turning ads on returns the new switches');
  perform tst.eq(public.app_switches()::jsonb, r::jsonb, 'and app_switches agrees');

  perform tst.logout();
  perform tst.ok((select ads_enabled from public.settings), 'settings.ads_enabled is on');
  perform tst.ok((select updated_at > now() - interval '1 minute' from public.settings), 'settings.updated_at moved');
  perform tst.ok((select not payments_enabled from public.settings), 'payments stay off');
  perform tst.eq((select count(*)::int from public.settings), 1, 'still one settings row');

  perform tst.login('carol');
  perform tst.eq(public.app_switches()::jsonb, '{"ads": true, "payments": false}'::jsonb, 'members see ads on');
  perform tst.eq(tst.count('select * from public.ads'), 1::bigint, 'members see the one active ad');
  r := public.record_ad_view(ad, current_date);
  perform tst.eq((r->>'earned_cents')::numeric, 7.00::numeric, 'the active ad pays 70% of its bid');
  perform tst.eq(tst.count('select * from public.ads where not active'), 0::bigint, 'held ads stay hidden with ads on');

  perform tst.login('dave');
  r := public.mod_set_switch('ads', true);
  perform tst.eq(r::jsonb, '{"ads": true, "payments": false}'::jsonb, 'turning ads on twice is harmless');

  r := public.mod_set_switch('ads', false);
  perform tst.eq(r::jsonb, '{"ads": false, "payments": false}'::jsonb, 'turning ads off returns the new switches');
  perform tst.login('bob');
  perform tst.eq(tst.count('select * from public.ads'), 0::bigint, 'after: ads disappear for members');
  perform tst.throws(format('select public.record_ad_view(%s, %L)', ad, current_date), 'ads_off', 'after: nothing pays');
  perform tst.logout();
  perform tst.eq((select earnings_cents from public.profiles where id = tst.uid('carol')), 7.00::numeric,
                 'earnings already made stay when ads go off');
end $$;
rollback;

-- The ads switch leaves payments alone, whichever way payments are set.
begin;
update public.settings set payments_enabled = true;
select tst.login('dave');
select tst.eq(public.mod_set_switch('ads', true)::jsonb, '{"ads": true, "payments": true}'::jsonb, 'payments on stays on when ads turn on');
select tst.eq(public.mod_set_switch('ads', false)::jsonb, '{"ads": false, "payments": true}'::jsonb, 'and when ads turn off');
select tst.logout();
select tst.ok((select payments_enabled and not ads_enabled from public.settings), 'only ads_enabled changed');
rollback;

-- A missing settings row comes back when an admin flips the switch.
begin;
delete from public.settings;
select tst.login('dave');
select tst.eq(public.mod_set_switch('ads', true)::jsonb, '{"ads": true, "payments": false}'::jsonb, 'mod_set_switch works without a settings row');
select tst.logout();
select tst.eq((select count(*)::int from public.settings), 1, 'and puts the one row back');
select tst.ok((select ads_enabled and not payments_enabled from public.settings), 'with ads on and payments off');
rollback;

-- Members still cannot write the switches directly.
begin;
select tst.login('alice');
select tst.throws($q$update public.settings set ads_enabled = true$q$, '42501', 'members cannot write settings directly');
select tst.throws($q$insert into public.settings (id, ads_enabled) values (true, true) on conflict (id) do update set ads_enabled = true$q$,
                  '42501', 'members cannot upsert settings');
rollback;

select tst.ok((select not ads_enabled and not payments_enabled from public.settings), 'every switch test rolled back: both still off');
