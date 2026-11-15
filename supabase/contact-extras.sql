-- One-time update: topics (categories) and extra contact fields.
--
-- How to run it:
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- It is safe to run more than once. Existing contacts and policies are not touched.

alter table public.contacts
  add column if not exists category text,
  add column if not exists is_favorite boolean not null default false,
  add column if not exists phone_secondary text,
  add column if not exists met_at text,
  add column if not exists follow_up_date date;

create index if not exists contacts_user_category_idx
  on public.contacts (user_id, category);

-- Make the API pick up the new columns right away.
notify pgrst, 'reload schema';
