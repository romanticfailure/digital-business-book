-- One-time update: relationship map ("who introduced whom").
--
-- How to run it:
--   Supabase dashboard -> SQL Editor -> New query -> paste this file -> Run.
-- Safe to run more than once. Run supabase/contact-extras.sql first if you have not yet.

alter table public.contacts
  add column if not exists introduced_by uuid
  references public.contacts (id) on delete set null;

create index if not exists contacts_introduced_by_idx
  on public.contacts (introduced_by);

-- Make the API pick up the new column right away.
notify pgrst, 'reload schema';
