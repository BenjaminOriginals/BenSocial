-- Runs (committed) just before schema.sql is applied again on a database
-- with data in it. after_rerun.sql checks that none of this was undone.
update public.settings set ads_enabled = true, payments_enabled = true;
insert into public.bans (user_id, email_hash, handle)
values (null, public.email_hash('gone@example.test'), 'gone_banned');
