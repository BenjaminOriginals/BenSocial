-- Reactions, reposts, replies, follows, blocks, mutes: counters, notifications, XP, privacy.

-- Reactions
begin;
do $$
declare
  v bigint;
  p public.posts%rowtype;
  v_xp int;
  n int;
begin
  v := tst.post('alice', 'React to me');
  perform tst.login('bob');
  v_xp := (select xp from tst.profiles where id = auth.uid());

  -- The exact statement PostgREST runs for supabase-js upsert({post_id, kind}, {onConflict: 'user_id,post_id'})
  insert into public.reactions (post_id, kind) values (v, 'like')
  on conflict (user_id, post_id) do update set post_id = excluded.post_id, kind = excluded.kind;
  select * into p from public.posts where id = v;
  perform tst.eq(p.likes, 1, 'like increments likes');
  perform tst.eq(p.dislikes, 0, 'like leaves dislikes');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 2, 'giving a like earns 2 XP');
  perform tst.eq(p.price, round(5 + 0.8 * sqrt(1::numeric), 4), 'price follows the curve after a like');
  perform tst.eq(p.price_history, array[5, 5.8]::numeric[], 'price change is appended to price_history');

  insert into public.reactions (post_id, kind) values (v, 'dislike')
  on conflict (user_id, post_id) do update set post_id = excluded.post_id, kind = excluded.kind;
  select * into p from public.posts where id = v;
  perform tst.eq(p.likes, 0, 'switching like to dislike decrements likes');
  perform tst.eq(p.dislikes, 1, 'switching like to dislike increments dislikes');
  perform tst.eq(p.price, 5.0000::numeric, 'price floors at 5 when dislikes outweigh likes');

  insert into public.reactions (post_id, kind) values (v, 'dislike')
  on conflict (user_id, post_id) do update set post_id = excluded.post_id, kind = excluded.kind;
  select * into p from public.posts where id = v;
  perform tst.ok(p.likes = 0 and p.dislikes = 1, 'repeating the same reaction changes nothing');

  delete from public.reactions where post_id = v;
  select * into p from public.posts where id = v;
  perform tst.ok(p.likes = 0 and p.dislikes = 0, 'deleting a reaction decrements the counter');

  insert into public.reactions (post_id, kind) values (v, 'like');
  perform tst.eq((select likes from public.posts where id = v), 1, 'liking again counts again');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 2, 'liking the same post again gives no more XP');

  perform tst.eq(tst.count('select * from public.reactions'), 1::bigint, 'I can see my reaction');
  perform tst.eq((select likes_given from json_to_record(public.my_stats()) as s(likes_given int)), 1, 'my_stats counts likes given');

  -- Notifications for the author: one, from bob, for the first like only.
  perform tst.login('alice');
  select count(*) into n from public.notifications where kind = 'like' and post_id = v and actor_id = tst.uid('bob');
  perform tst.eq(n, 1, 'author gets one like notification even after unlike and relike');
  perform tst.eq(tst.count('select * from public.reactions'), 0::bigint, 'others'' reactions are private');

  -- Self-like: counts, no notification.
  insert into public.reactions (post_id, kind) values (v, 'like');
  perform tst.eq((select likes from public.posts where id = v), 2, 'self-like counts');
  select count(*) into n from public.notifications where actor_id = tst.uid('alice');
  perform tst.eq(n, 0, 'no notification for liking your own post');

  -- Others cannot touch bob's reaction or react as bob.
  update public.reactions set kind = 'dislike' where user_id = tst.uid('bob');
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot change another user''s reaction');
  delete from public.reactions where user_id = tst.uid('bob');
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot delete another user''s reaction');
  perform tst.throws(format('insert into public.reactions (user_id, post_id, kind) values (%L, %s, %L)', tst.uid('bob'), v, 'like'),
                     '42501', 'cannot react as someone else');
  perform tst.throws(format('update public.reactions set user_id = %L where post_id = %s', tst.uid('carol'), v),
                     '42501', 'cannot move a reaction to another user');
  perform tst.throws(format('insert into public.reactions (post_id, kind) values (%s, %L)', v, 'love'),
                     '23514', 'unknown reaction kind rejected');
end $$;
rollback;

-- Upsert cannot move a reaction to another post
begin;
do $$
declare
  v1 bigint;
  v2 bigint;
begin
  v1 := tst.post('alice', 'one');
  v2 := tst.post('alice', 'two');
  perform tst.login('bob');
  insert into public.reactions (post_id, kind) values (v1, 'like');
  update public.reactions set post_id = v2 where post_id = v1;
  perform tst.eq((select post_id from public.reactions where user_id = auth.uid()), v1, 'reaction post_id cannot be changed');
  perform tst.ok((select likes from public.posts where id = v1) = 1 and (select likes from public.posts where id = v2) = 0,
                 'counters stay with the original post');
end $$;
rollback;

-- Reactions need a visible post
begin;
do $$
declare
  v bigint;
  vr bigint;
begin
  v := tst.post('alice', 'Alice blocks bob');
  vr := tst.post('carol', 'Removed one');
  update public.posts set removed = true where id = vr;
  perform tst.login('alice');
  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.login('bob');
  perform tst.throws(format('insert into public.reactions (post_id, kind) values (%s, %L)', v, 'like'),
                     '42501', 'cannot react to the post of someone who blocked you');
  perform tst.throws(format('insert into public.reactions (post_id, kind) values (%s, %L)', vr, 'like'),
                     '42501', 'cannot react to a removed post');
  perform tst.throws(format('insert into public.reposts (post_id) values (%s)', v),
                     '42501', 'cannot repost the post of someone who blocked you');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, 'hi'),
                     '42501', 'cannot reply to the post of someone who blocked you');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', vr, 'hi'),
                     '42501', 'cannot reply to a removed post');
end $$;
rollback;

-- Reposts
begin;
do $$
declare
  v bigint;
  v_xp int;
  n int;
begin
  v := tst.post('alice', 'Repost me');
  perform tst.login('bob');
  v_xp := (select xp from tst.profiles where id = auth.uid());
  insert into public.reposts (post_id) values (v);
  perform tst.eq((select reposts from public.posts where id = v), 1, 'repost increments reposts');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 3, 'reposting earns 3 XP');
  perform tst.eq((select price from public.posts where id = v), round(5 + 0.8 * sqrt(2::numeric), 4),
                 'a repost counts double in the price');
  perform tst.throws(format('insert into public.reposts (post_id) values (%s)', v), '23505', 'cannot repost twice');
  delete from public.reposts where post_id = v;
  perform tst.eq((select reposts from public.posts where id = v), 0, 'un-repost decrements reposts');
  insert into public.reposts (post_id) values (v);
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 3, 'reposting again gives no more XP');
  perform tst.eq((select reposts from json_to_record(public.my_stats()) as s(reposts int)), 1, 'my_stats counts reposts');
  perform tst.throws(format('insert into public.reposts (user_id, post_id) values (%L, %s)', tst.uid('carol'), v),
                     '42501', 'cannot repost as someone else');

  perform tst.login('alice');
  select count(*) into n from public.notifications where kind = 'repost' and actor_id = tst.uid('bob') and post_id = v;
  perform tst.eq(n, 1, 'author gets one repost notification');
  insert into public.reposts (post_id) values (v);
  select count(*) into n from public.notifications where actor_id = tst.uid('alice');
  perform tst.eq(n, 0, 'no notification for reposting yourself');
  perform tst.eq(tst.count('select * from public.reposts'), 1::bigint, 'others'' reposts are private');
end $$;
rollback;

-- Replies
begin;
do $$
declare
  v bigint;
  rid bigint;
  v_xp int;
  nt public.notifications%rowtype;
  n int;
  long_body text := 'This reply is long enough that the notification excerpt has to cut it off at eighty characters exactly.';
begin
  v := tst.post('alice', 'Reply to me');
  perform tst.login('bob');
  v_xp := (select xp from tst.profiles where id = auth.uid());
  insert into public.replies (post_id, body) values (v, long_body) returning id into rid;
  perform tst.eq((select author_id from public.replies where id = rid), tst.uid('bob'), 'reply author is the caller');
  perform tst.eq((select replies from public.posts where id = v), 1, 'reply increments replies');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 8, 'replying earns 8 XP');
  perform tst.eq(tst.count(format('select id, post_id, author_id, body, created_at from public.replies where post_id = %s', v)),
                 1::bigint, 'replies are readable with the columns the client selects');

  perform tst.login('alice');
  select * into nt from public.notifications where kind = 'reply' and post_id = v;
  perform tst.eq(nt.actor_id, tst.uid('bob'), 'author gets a reply notification from the replier');
  perform tst.eq(nt.data->>'excerpt', left(long_body, 80), 'reply notification carries an 80-character excerpt');
  insert into public.replies (post_id, body) values (v, 'Replying to myself');
  select count(*) into n from public.notifications where actor_id = tst.uid('alice');
  perform tst.eq(n, 0, 'no notification for replying to yourself');

  delete from public.replies where id = rid;
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot delete another user''s reply');
  perform tst.login('bob');
  delete from public.replies where id = rid;
  get diagnostics n = row_count;
  perform tst.eq(n, 1, 'can delete own reply');
  perform tst.eq((select replies from public.posts where id = v), 1, 'deleting a reply decrements replies');

  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, repeat('r', 281)),
                     '23514', '281-character reply rejected');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, '  '),
                     '23514', 'blank reply rejected');
  perform tst.throws(format('insert into public.replies (post_id, body, author_id) values (%s, %L, %L)', v, 'x', tst.uid('carol')),
                     '42501', 'cannot reply as someone else');
  perform tst.throws(format('update public.replies set body = %L where post_id = %s', 'edited', v),
                     '42501', 'replies cannot be edited');
end $$;
rollback;

-- Reply rate limit and bans
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'Spam target');
  perform tst.login('bob');
  perform tst.lives(format('insert into public.replies (post_id, body) select %s, %L || g from generate_series(1, 10) g', v, 'r'),
                    'ten replies in a minute are fine');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, 'eleventh'),
                     'slow_down', 'eleventh reply in a minute is slow_down');
end $$;
rollback;

begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'Banned reply target');
  update public.profiles set is_banned = true where id = tst.uid('erin');
  perform tst.login('erin');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, 'hi'),
                     'banned', 'banned user cannot reply');
end $$;
rollback;

-- Replies are hidden for blocks and bans
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'Thread');
  perform tst.login('bob');
  insert into public.replies (post_id, body) values (v, 'bob reply');
  perform tst.login('carol');
  insert into public.replies (post_id, body) values (v, 'carol reply');
  perform tst.login('bob');
  insert into public.blocks (blocked) values (tst.uid('carol'));
  perform tst.eq(tst.count(format('select * from public.replies where post_id = %s', v)), 1::bigint,
                 'replies from someone I blocked are hidden');
  perform tst.login('carol');
  perform tst.eq(tst.count(format('select * from public.replies where post_id = %s', v)), 1::bigint,
                 'replies from someone who blocked me are hidden');
  perform tst.logout();
  update public.profiles set is_banned = true where id = tst.uid('bob');
  perform tst.login('alice');
  perform tst.eq(tst.count(format('select * from public.replies where post_id = %s', v)), 1::bigint,
                 'replies from banned users are hidden');
end $$;
rollback;

-- Follows
begin;
do $$
declare
  v_xp int;
  n int;
begin
  perform tst.login('bob');
  v_xp := (select xp from tst.profiles where id = auth.uid());
  insert into public.follows (followee) values (tst.uid('alice'));
  perform tst.eq((select followers_count from public.profiles where id = tst.uid('alice')), 1, 'follow increments followers_count');
  perform tst.eq((select following_count from public.profiles where id = tst.uid('bob')), 1, 'follow increments following_count');
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 3, 'following earns 3 XP');
  perform tst.eq(tst.count(format('select followee from public.follows where follower = %L', tst.uid('bob'))), 1::bigint,
                 'I can list who I follow');
  perform tst.throws(format('insert into public.follows (followee) values (%L)', tst.uid('alice')), '23505', 'cannot follow twice');
  perform tst.throws(format('insert into public.follows (followee) values (%L)', tst.uid('bob')), '23514', 'cannot follow yourself');
  perform tst.throws(format('insert into public.follows (follower, followee) values (%L, %L)', tst.uid('carol'), tst.uid('alice')),
                     '42501', 'cannot follow on someone else''s behalf');

  delete from public.follows where followee = tst.uid('alice');
  perform tst.eq((select followers_count from public.profiles where id = tst.uid('alice')), 0, 'unfollow decrements followers_count');
  perform tst.eq((select following_count from public.profiles where id = tst.uid('bob')), 0, 'unfollow decrements following_count');
  insert into public.follows (followee) values (tst.uid('alice'));
  perform tst.eq((select xp from tst.profiles where id = auth.uid()), v_xp + 3, 'refollowing gives no more XP');

  perform tst.login('alice');
  select count(*) into n from public.notifications where kind = 'follow' and actor_id = tst.uid('bob');
  perform tst.eq(n, 1, 'one follow notification even after unfollow and refollow');
  perform tst.eq(tst.count('select * from public.follows'), 1::bigint, 'follows are readable by everyone');
  delete from public.follows where follower = tst.uid('bob');
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'cannot remove someone else''s follow');
end $$;
rollback;

-- Blocks
begin;
do $$
declare
  n int;
begin
  perform tst.login('alice');
  insert into public.follows (followee) values (tst.uid('bob'));
  perform tst.login('bob');
  insert into public.follows (followee) values (tst.uid('alice'));
  perform tst.eq((select followers_count from public.profiles where id = tst.uid('alice')), 1, 'setup: bob follows alice');

  perform tst.login('alice');
  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.eq(tst.count(format('select * from public.follows where (follower = %L and followee = %L) or (follower = %L and followee = %L)',
                                  tst.uid('alice'), tst.uid('bob'), tst.uid('bob'), tst.uid('alice'))), 0::bigint,
                 'blocking removes follows both ways');
  perform tst.ok((select followers_count = 0 and following_count = 0 from public.profiles where id = tst.uid('alice')),
                 'blocker counters drop');
  perform tst.ok((select followers_count = 0 and following_count = 0 from public.profiles where id = tst.uid('bob')),
                 'blocked user counters drop');
  perform tst.eq(tst.count('select * from public.blocks'), 1::bigint, 'blocker sees their block');
  perform tst.throws(format('insert into public.follows (followee) values (%L)', tst.uid('bob')), 'blocked', 'blocker cannot follow');
  perform tst.ok(public.is_blocked_with(tst.uid('bob')), 'is_blocked_with is true for the blocker');

  perform tst.login('bob');
  perform tst.eq(tst.count('select * from public.blocks'), 0::bigint, 'blocked user cannot see the block row');
  perform tst.throws(format('insert into public.follows (followee) values (%L)', tst.uid('alice')), 'blocked', 'blocked user cannot follow back');
  perform tst.ok(public.is_blocked_with(tst.uid('alice')), 'is_blocked_with is true for the blocked user');
  delete from public.blocks where blocker = tst.uid('alice');
  get diagnostics n = row_count;
  perform tst.eq(n, 0, 'blocked user cannot remove the block');
  perform tst.throws(format('insert into public.blocks (blocker, blocked) values (%L, %L)', tst.uid('carol'), tst.uid('dave')),
                     '42501', 'cannot block on someone else''s behalf');

  perform tst.login('alice');
  delete from public.blocks where blocked = tst.uid('bob');
  perform tst.lives(format('insert into public.follows (followee) values (%L)', tst.uid('bob')), 'after unblocking you can follow again');
  perform tst.throws(format('insert into public.blocks (blocked) values (%L)', tst.uid('alice')), '23514', 'cannot block yourself');
end $$;
rollback;

-- Mutes
begin;
do $$
declare
  v bigint;
  n int;
begin
  v := tst.post('alice', 'mute test');
  perform tst.login('alice');
  insert into public.mutes (muted_id) values (tst.uid('bob'));
  perform tst.eq(tst.count('select * from public.mutes'), 1::bigint, 'muter sees their mute');
  perform tst.login('bob');
  perform tst.eq(tst.count('select * from public.mutes'), 0::bigint, 'muted user cannot see the mute');
  insert into public.reactions (post_id, kind) values (v, 'like');
  perform tst.eq((select likes from public.posts where id = v), 1, 'muted user can still like');
  perform tst.login('alice');
  select count(*) into n from public.notifications where actor_id = tst.uid('bob');
  perform tst.eq(n, 0, 'no notifications from someone you muted');
  perform tst.throws(format('insert into public.mutes (user_id, muted_id) values (%L, %L)', tst.uid('carol'), tst.uid('dave')),
                     '42501', 'cannot mute on someone else''s behalf');
  perform tst.throws(format('insert into public.mutes (muted_id) values (%L)', tst.uid('alice')), '23514', 'cannot mute yourself');
  delete from public.mutes where muted_id = tst.uid('bob');
  get diagnostics n = row_count;
  perform tst.eq(n, 1, 'can unmute');
end $$;
rollback;

-- Notifications: read-only to clients, own only; unread_count and mark read.
begin;
do $$
declare
  v bigint;
begin
  v := tst.post('alice', 'notify me');
  perform tst.login('bob');
  insert into public.reactions (post_id, kind) values (v, 'like');
  insert into public.reposts (post_id) values (v);
  insert into public.follows (followee) values (tst.uid('alice'));
  perform tst.eq(tst.count('select * from public.notifications'), 0::bigint, 'actor sees none of the notifications they caused');

  perform tst.login('alice');
  perform tst.eq(public.unread_count(), 3, 'unread_count counts unread notifications');
  perform tst.throws($q$update public.notifications set read = true$q$, '42501', 'clients cannot update notifications');
  perform tst.throws(format('insert into public.notifications (user_id, kind) values (%L, %L)', tst.uid('alice'), 'level'),
                     '42501', 'clients cannot insert notifications');
  perform tst.throws($q$delete from public.notifications$q$, '42501', 'clients cannot delete notifications');
  perform public.mark_notifications_read();
  perform tst.eq(public.unread_count(), 0, 'mark_notifications_read clears unread_count');
  perform tst.eq(tst.count('select * from public.notifications where read'), 3::bigint, 'notifications are kept as read');
end $$;
rollback;

-- Price history keeps the last 40 values
begin;
do $$
declare
  v bigint;
  h numeric[];
begin
  v := tst.post('alice', 'volatile');
  for i in 1..50 loop
    update public.posts set likes = i where id = v;
  end loop;
  select price_history into h from public.posts where id = v;
  perform tst.eq(array_length(h, 1), 40, 'price_history keeps 40 values');
  perform tst.eq(h[40], round(5 + 0.8 * sqrt(50::numeric), 4), 'last price_history value is the current price');
  perform tst.eq(h[1], round(5 + 0.8 * sqrt(11::numeric), 4), 'oldest values are dropped first');
  update public.posts set body = 'volatile!' where id = v;
  perform tst.eq((select array_length(price_history, 1) from public.posts where id = v), 40,
                 'editing the body does not touch the price');
end $$;
rollback;

-- Reply churn: deleted replies still count toward 10 a minute.
begin;
do $$
declare
  v bigint;
  rid bigint;
begin
  v := tst.post('alice', 'reply churn target');
  perform tst.login('frank');
  for i in 1..10 loop
    insert into public.replies (post_id, body) values (v, 'you are awful #' || i) returning id into rid;
    delete from public.replies where id = rid;
  end loop;
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, 'eleventh'), 'slow_down',
                     'replying and deleting still counts toward 10 a minute');
end $$;
rollback;

begin;
insert into public.write_log (user_id, kind, created_at)
select tst.uid('frank'), 'reply', now() - interval '3 hours' from generate_series(1, 300);
do $$
declare
  v bigint := tst.post('alice', 'reply day cap');
begin
  perform tst.login('frank');
  perform tst.throws(format('insert into public.replies (post_id, body) values (%s, %L)', v, 'reply 301'), 'slow_down',
                     'reply 301 of the day is slow_down');
end $$;
rollback;

-- At most 20 reply notifications an hour from one person to another.
begin;
do $$
declare
  v bigint := tst.post('alice', 'notification cap target');
begin
  insert into public.notifications (user_id, actor_id, kind, post_id, data, created_at)
  select tst.uid('alice'), tst.uid('frank'), 'reply', v, '{"excerpt":"x"}', now() - interval '10 minutes'
    from generate_series(1, 19);
  perform tst.login('frank');
  insert into public.replies (post_id, body) values (v, 'twentieth');
  insert into public.replies (post_id, body) values (v, 'twenty-first');
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.notifications where user_id = tst.uid('alice') and actor_id = tst.uid('frank')), 20,
                 'the 21st reply in an hour sends no notification');
  perform tst.eq((select replies from public.posts where id = v), 2, 'the replies themselves still post');
  perform tst.login('bob');
  insert into public.replies (post_id, body) values (v, 'bob joins in');
  perform tst.logout();
  perform tst.eq((select count(*)::int from public.notifications where user_id = tst.uid('alice') and actor_id = tst.uid('bob')), 1,
                 'the cap is per person');
end $$;
rollback;

-- Blocking someone hides the notifications they already sent, and the unread count.
begin;
do $$
declare
  v bigint := tst.post('bob', 'bob post for blocked notes');
begin
  perform tst.login('frank');
  insert into public.replies (post_id, body) values (v, 'you are awful #1');
  perform tst.login('carol');
  insert into public.reactions (post_id, kind) values (v, 'like');
  perform tst.login('bob');
  perform tst.eq(tst.count('select id from public.notifications'), 2::bigint, 'setup: two notifications');
  perform tst.eq(public.unread_count(), 2, 'setup: two unread');
  insert into public.blocks (blocked) values (tst.uid('frank'));
  perform tst.eq(tst.count(format('select id from public.notifications where actor_id = %L', tst.uid('frank'))), 0::bigint,
                 'notifications from someone you blocked are hidden');
  perform tst.eq(tst.count('select id from public.notifications'), 1::bigint, 'others stay');
  perform tst.eq(public.unread_count(), 1, 'unread_count leaves them out');
  delete from public.blocks where blocked = tst.uid('frank');
  perform tst.eq(public.unread_count(), 2, 'unblocking shows them again');
  perform tst.login('frank');
  insert into public.blocks (blocked) values (tst.uid('bob'));
  perform tst.login('bob');
  perform tst.eq(public.unread_count(), 1, 'it works when they blocked you too');
end $$;
rollback;
