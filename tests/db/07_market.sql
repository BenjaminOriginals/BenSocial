-- Clout Market: price curve, back_post, sell_position, refunds.

-- Price curve
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'curve');
  update public.posts set likes = 4 where id = v;
  perform tst.eq((select price from public.posts where id = v), 6.6::numeric, 'price = 5 + 0.8*sqrt(4) with 4 likes');
  update public.posts set likes = 4, reposts = 1, replies = 2, dislikes = 2 where id = v;
  perform tst.eq((select price from public.posts where id = v), round(5 + 0.8 * sqrt(8::numeric), 4),
                 'e = likes + 2*reposts + 1.5*replies - 0.5*dislikes');
  update public.posts set likes = 0, reposts = 0, replies = 0, dislikes = 50 where id = v;
  perform tst.eq((select price from public.posts where id = v), 5.0000::numeric, 'engagement floors at zero');
  update public.posts set dislikes = 0, shares_outstanding = 10 where id = v;
  perform tst.eq((select price from public.posts where id = v), 5.5::numeric, 'each outstanding share adds 0.05');
end $$;
rollback;

-- Errors
begin;
do $$
declare
  v bigint;
  vb bigint;
  vr bigint;
begin
  v := tst.post('alice', 'back me');
  vr := tst.post('alice', 'removed');
  vb := tst.post('carol', 'carol blocks bob');
  update public.posts set removed = true where id = vr;

  perform tst.login('alice');
  perform tst.throws(format('select public.back_post(%s, 100)', v), 'own_post', 'cannot back your own post');

  perform tst.login('carol');
  insert into public.blocks (blocked) values (tst.uid('bob'));

  perform tst.login('bob');
  perform tst.throws(format('select public.back_post(%s, 9.99)', v), 'bad_amount', 'below 10 is bad_amount');
  perform tst.throws(format('select public.back_post(%s, 0)', v), 'bad_amount', 'zero is bad_amount');
  perform tst.throws(format('select public.back_post(%s, -50)', v), 'bad_amount', 'negative is bad_amount');
  perform tst.throws(format('select public.back_post(%s, 100000.01)', v), 'bad_amount', 'above 100000 is bad_amount');
  perform tst.throws(format('select public.back_post(%s, null)', v), 'bad_amount', 'null is bad_amount');
  perform tst.throws(format('select public.back_post(%s, 501)', v), 'insufficient_clout', 'more than you have is insufficient_clout');
  perform tst.throws('select public.back_post(999999999, 100)', 'not_found', 'missing post is not_found');
  perform tst.throws(format('select public.back_post(%s, 100)', vr), 'not_found', 'removed post is not_found');
  perform tst.throws(format('select public.back_post(%s, 100)', vb), 'blocked', 'post of someone who blocked you is blocked');
  perform tst.throws(format('select public.sell_position(%s)', v), 'not_found', 'selling with no position is not_found');
  perform tst.throws(format('insert into public.positions (user_id, post_id, shares, cost) values (auth.uid(), %s, 1000, 0)', v),
                     '42501', 'clients cannot write positions');

  perform tst.logout();
  update public.profiles set is_banned = true where id = tst.uid('erin');
  perform tst.login('erin');
  perform tst.throws(format('select public.back_post(%s, 100)', v), 'banned', 'banned users cannot back posts');

  perform tst.anon();
  perform tst.throws(format('select public.back_post(%s, 100)', v), '42501', 'anon cannot back posts');
end $$;
rollback;

-- Buy -> sell round trip returns the same clout (within 0.01, never more)
begin;
do $$
declare
  v bigint;
  r json;
  s json;
  a numeric := 5;
  expect_shares numeric;
  nt public.notifications%rowtype;
  v_xp int;
begin
  v := tst.post('alice', 'round trip');
  perform tst.login('bob');
  v_xp := (select xp from tst.profiles where id = auth.uid());
  r := public.back_post(v, 100);
  -- delta = (-(a+b*s) + sqrt((a+b*s)^2 + 2*b*M)) / b with s = 0
  expect_shares := (-(a) + sqrt(a * a + 2 * 0.05 * 100)) / 0.05;
  perform tst.near((r->>'shares')::numeric, expect_shares, 0.000001, 'shares follow the bonding curve');
  perform tst.eq((r->>'spent')::numeric, 100::numeric, 'spent is the amount');
  perform tst.eq((r->>'clout')::numeric, 400::numeric, 'clout drops by the amount');
  perform tst.eq((r->>'price')::numeric, round(a + 0.05 * (r->>'shares')::numeric, 4), 'returned price is the new price');
  perform tst.eq((select shares_outstanding from public.posts where id = v), (r->>'shares')::numeric, 'shares_outstanding grows');
  perform tst.eq((select price from public.posts where id = v), (r->>'price')::numeric, 'post price updated');
  perform tst.eq((select cost from public.positions where post_id = v), 100.00::numeric, 'position cost recorded');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 10, 'backing earns 10 XP');
  perform tst.eq((select backs from json_to_record(public.my_stats()) as t(backs int)), 1, 'my_stats counts backs');

  s := public.sell_position(v);
  perform tst.near((s->>'proceeds')::numeric, 100, 0.01, 'selling right away returns the amount within 0.01');
  perform tst.ok((s->>'proceeds')::numeric <= 100, 'a round trip never makes clout');
  perform tst.near((s->>'profit')::numeric, 0, 0.01, 'round trip profit is about zero');
  perform tst.near((s->>'clout')::numeric, 500, 0.01, 'clout is back where it started');
  perform tst.eq((select shares_outstanding from public.posts where id = v), 0::numeric, 'shares_outstanding back to 0');
  perform tst.eq((select price from public.posts where id = v), 5.0000::numeric, 'price back to 5');
  perform tst.eq(tst.count('select * from public.positions'), 0::bigint, 'position closed');
  perform tst.throws(format('select public.sell_position(%s)', v), 'not_found', 'selling twice is not_found');

  r := public.back_post(v, 50);
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 10, 'backing the same post again gives no more XP');

  perform tst.login('alice');
  select * into nt from public.notifications where kind = 'back' and post_id = v order by id limit 1;
  perform tst.eq(nt.actor_id, tst.uid('bob'), 'author is notified of a back');
  perform tst.eq((nt.data->>'amount')::numeric, 100::numeric, 'back notification carries the amount');
end $$;
rollback;

-- Many small round trips cannot farm clout
begin;
do $$
declare
  v bigint;
  start numeric;
begin
  v := tst.post('alice', 'farm attempt');
  perform tst.login('bob');
  start := (select clout from tst.profiles where id = auth.uid());
  for i in 1..25 loop
    perform public.back_post(v, 10 + i * 3.37);
    perform public.sell_position(v);
  end loop;
  perform tst.ok((select clout from tst.profiles where id = auth.uid()) <= start, '25 round trips never gain clout');
end $$;
rollback;

-- Early backers profit when others buy later; the market never creates clout.
begin;
do $$
declare
  v bigint;
  b json; c json; sb json; sc json;
begin
  v := tst.post('alice', 'two backers');
  perform tst.login('bob');
  b := public.back_post(v, 200);
  perform tst.login('carol');
  c := public.back_post(v, 200);
  perform tst.ok((c->>'shares')::numeric < (b->>'shares')::numeric, 'later buyer gets fewer shares');
  perform tst.login('bob');
  sb := public.sell_position(v);
  perform tst.ok((sb->>'profit')::numeric > 0, 'early backer sells at a profit');
  perform tst.login('carol');
  sc := public.sell_position(v);
  perform tst.ok((sc->>'profit')::numeric < 0, 'late backer selling after the early one takes a loss');
  perform tst.ok((sb->>'proceeds')::numeric + (sc->>'proceeds')::numeric <= 400, 'total paid out never exceeds total paid in');
  perform tst.eq((select shares_outstanding from public.posts where id = v), 0::numeric, 'all shares retired');

  perform tst.login('bob');
  perform tst.eq(tst.count('select * from public.positions'), 0::bigint, 'positions are private (none of carol''s visible)');
end $$;
rollback;

-- Engagement lifts the price for holders
begin;
do $$
declare
  v bigint;
  s json;
begin
  v := tst.post('alice', 'about to go viral');
  perform tst.login('bob');
  perform public.back_post(v, 100);
  perform tst.logout();
  update public.posts set likes = likes + 100 where id = v;
  perform tst.login('bob');
  s := public.sell_position(v);
  perform tst.ok((s->>'profit')::numeric > 50, 'likes after backing make the position profitable');
end $$;
rollback;

-- Refunds: deleting a post pays holders their cost back
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'to be deleted');
  perform tst.login('bob');
  perform public.back_post(v, 120);
  perform tst.login('carol');
  perform public.back_post(v, 80);
  perform tst.eq((select clout from tst.profiles where id = tst.uid('bob')), 380::numeric, 'setup: bob spent 120');
  perform tst.login('alice');
  delete from public.posts where id = v;
  perform tst.eq((select clout from tst.profiles where id = tst.uid('bob')), 500::numeric, 'deleting refunds bob''s cost');
  perform tst.eq((select clout from tst.profiles where id = tst.uid('carol')), 500::numeric, 'deleting refunds carol''s cost');
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.positions where post_id = v), 0, 'positions removed with the post');
end $$;
rollback;

-- Refunds: moderator removal pays holders their cost back
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'to be removed');
  perform tst.login('bob');
  perform public.back_post(v, 150);
  perform tst.login('dave');
  perform public.mod_set_post_removed(v, true);
  perform tst.logout();
  perform tst.eq((select clout from tst.profiles where id = tst.uid('bob')), 500::numeric, 'removal refunds the cost');
  perform tst.eq((select count(*)::int from public.positions where post_id = v), 0, 'removal closes positions');
  perform tst.eq((select shares_outstanding from public.posts where id = v), 0::numeric, 'removal resets shares_outstanding');
  perform tst.eq((select price from public.posts where id = v), 5.0000::numeric, 'removal resets the price to its engagement part');
end $$;
rollback;

-- Backing and selling over and over notifies the author once.
begin;
do $$
declare
  v bigint := tst.post('erin', 'flood target');
begin
  perform tst.login('frank');
  for i in 1..25 loop
    perform public.back_post(v, 10);
    perform public.sell_position(v);
  end loop;
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.notifications where user_id = tst.uid('erin') and kind = 'back'), 1,
                 '25 back-and-sell rounds send one back notification');
end $$;
rollback;

-- The pot: what backers paid in minus what sellers took out.
begin;
do $$
declare
  v bigint := tst.post('alice', 'pot');
  s json;
begin
  perform tst.login('bob');
  perform public.back_post(v, 120);
  perform tst.eq((select reserve from public.posts where id = v), 120.00::numeric, 'backing adds to the pot');
  perform tst.login('carol');
  perform public.back_post(v, 80);
  perform tst.eq((select reserve from public.posts where id = v), 200.00::numeric, 'every back adds to the pot');
  perform tst.login('bob');
  s := public.sell_position(v);
  perform tst.eq((select reserve from public.posts where id = v), 200 - (s->>'proceeds')::numeric, 'selling takes out of the pot');
  perform tst.throws(format('update public.posts set reserve = 1e9 where id = %s', v), '42501', 'clients cannot touch the pot');
end $$;
rollback;

-- No clout from nothing: an early backer sells at a profit paid by a later
-- backer, then the author deletes the post. The later backer is refunded from
-- what is left, not their full cost, so the three together end where they began.
begin;
do $$
declare
  v bigint := tst.post('alice', 'mint attempt');
  start numeric := (select sum(clout) from tst.profiles where id in (tst.uid('alice'), tst.uid('bob'), tst.uid('carol')));
  sb json;
  pot numeric;
begin
  perform tst.login('bob');
  perform public.back_post(v, 490);
  perform tst.login('carol');
  perform public.back_post(v, 490);
  perform tst.login('bob');
  sb := public.sell_position(v);
  perform tst.ok((sb->>'profit')::numeric > 100, 'setup: the early backer sold at a profit');
  pot := (select reserve from public.posts where id = v);
  perform tst.login('alice');
  delete from public.posts where id = v;
  perform tst.logout();
  perform tst.near((select clout from tst.profiles where id = tst.uid('carol')), 500 - 490 + pot, 0.01,
                   'the later backer gets back what is left in the pot');
  perform tst.ok((select sum(clout) from tst.profiles where id in (tst.uid('alice'), tst.uid('bob'), tst.uid('carol'))) <= start,
                 'deleting the post creates no clout');
end $$;
rollback;

-- Engagement still pays holders on deletion up to their cost: the market
-- would pay at least that if they sold now.
begin;
do $$
declare
  v bigint := tst.post('alice', 'popular then deleted');
begin
  perform tst.login('bob');
  perform public.back_post(v, 100);
  perform tst.login('carol');
  perform public.back_post(v, 100);
  perform tst.logout();
  update public.posts set likes = 400 where id = v;
  perform tst.login('bob');
  perform public.sell_position(v);
  perform tst.login('alice');
  delete from public.posts where id = v;
  perform tst.logout();
  perform tst.eq((select clout from tst.profiles where id = tst.uid('carol')), 500::numeric,
                 'a holder whose position is worth more than its cost gets the cost back');
end $$;
rollback;
