-- Fixture accounts shared by every test file (committed). They are made
-- the way GoTrue makes them, so the sign-up trigger creates the profiles.
-- dave is the admin.
begin;
select tst.signup('alice', 'a0000000-0000-4000-8000-000000000001', '{"handle":"Alice","name":"Alice Adams"}');
select tst.signup('bob',   'b0000000-0000-4000-8000-000000000002', '{"handle":"bob","name":"Bob"}');
select tst.signup('carol', 'c0000000-0000-4000-8000-000000000003', '{"handle":"carol","name":"Carol"}');
select tst.signup('dave',  'd0000000-0000-4000-8000-000000000004', '{"handle":"dave","name":"Dave the Mod"}');
select tst.signup('erin',  'e0000000-0000-4000-8000-000000000005', '{"handle":"erin","name":"Erin"}');
select tst.signup('frank', 'f0000000-0000-4000-8000-000000000006', '{"handle":"frank","name":"Frank"}');
select tst.signup('gina',  '1a000000-0000-4000-8000-000000000007', '{"handle":"gina","name":"Gina"}');
-- The owner makes themselves admin in the SQL editor:
update public.profiles set is_admin = true where handle = 'dave';
commit;

