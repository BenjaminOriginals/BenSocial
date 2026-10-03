-- =====================================================================
-- BENSOCIAL STARTER CONTENT (optional)
--
-- Run after schema.sql. Best run after you have signed up and made
-- yourself an admin, so the duels list you as their creator. Works fine
-- before that too.
--
-- Adds three duels and three example ads. Adds no users and no posts.
-- Safe to run again: anything already here is left alone.
-- =====================================================================

-- Duels. They start now and close in 1 to 3 days.
insert into public.duels (title, a_label, a_take, b_label, b_take, starts_at, ends_at, created_by)
select v.title, v.a_label, v.a_take, v.b_label, v.b_take,
       now(), now() + v.runs_for,
       (select p.id from public.profiles p where p.is_admin order by p.created_at limit 1)
  from (values
    ('Does pineapple belong on pizza?',
     'It belongs', 'Sweet, salty, sharp. It balances the cheese. Pineapple belongs.',
     'It does not', 'Fruit on pizza is dessert wearing a dinner costume.',
     interval '24 hours'),
    ('Office or remote?',
     'Office', 'Careers happen in hallways. You can''t bump into someone on a video call.',
     'Remote', 'My commute is nine steps and my code reviews got better.',
     interval '48 hours'),
    ('Is cereal a soup?',
     'Soup', 'Solid pieces in a liquid, eaten with a spoon from a bowl. Soup.',
     'Not soup', 'Soup is savory and usually hot. Cereal is breakfast. Done.',
     interval '72 hours')
  ) as v(title, a_label, a_take, b_label, b_take, runs_for)
 where not exists (select 1 from public.duels d where d.title = v.title);

-- HELD: example ads. They stay off (active = false) and pay nothing.
-- These brands are placeholders. Replace them with real advertisers before
-- you turn ads on with: update public.ads set active = true where id = ...;
insert into public.ads (brand, hue, bid_cents, copy, why, active)
select v.brand, v.hue, v.bid_cents, v.copy, v.why, false
  from (values
    ('Pebble Bank', 205, 15.00::numeric,
     'A savings account with no monthly fees and no minimum balance.',
     'Broad campaign. No targeting.'),
    ('Atlas Languages', 280, 12.00::numeric,
     'Ten minutes a day. Real conversations by month three.',
     'Broad campaign. No targeting.'),
    ('Fieldnote Paper Co.', 50, 3.00::numeric,
     'Notebooks that lie flat on the first page and the last.',
     'Broad campaign. No targeting.')
  ) as v(brand, hue, bid_cents, copy, why)
 where not exists (select 1 from public.ads a where a.brand = v.brand);
