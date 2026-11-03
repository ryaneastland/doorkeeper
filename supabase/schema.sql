-- DoorKeeper (Bosch) Supabase schema. Run in the Supabase SQL editor.

-- 1. profiles: one row per auth user (role flag + email for joins)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  site_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- 2. entry_logs: door access audit
create table if not exists public.entry_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  "user" uuid references auth.users (id),
  user_email text,
  door_name text,
  door_id text,
  status boolean
);

-- 3. invite_logs: invitation audit (FK name invite_logs_invited_by_fkey is used by the app join)
create table if not exists public.invite_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  invited_address text,
  invited_by uuid references public.profiles (id)
);

-- Auto-create a profile when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any existing users
insert into public.profiles (id, email)
select id, email from auth.users
on conflict (id) do nothing;

-- Row Level Security is OFF for these tables, matching the live setup. The app reads profiles and
-- writes entry_logs / invite_logs through a module-level anon client with no user session
-- ($lib/supabaseClient), so auth.uid() is always null and per-user policies can never pass.
--
-- ⚠ With RLS off, anyone holding the public anon key can read and write these tables directly
-- (including faking entry_logs rows or setting site_admin). Re-enabling RLS needs those queries
-- moved to the per-request session client (locals.supabase) or the server-only service client
-- first; see CLAUDE.md "Three Supabase clients".
alter table public.profiles disable row level security;
alter table public.entry_logs disable row level security;
alter table public.invite_logs disable row level security;

-- Make yourself an admin after signing up (replace the email):
-- update public.profiles set site_admin = true where email = 'you@example.com';
