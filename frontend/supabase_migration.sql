-- Run this in the Supabase SQL Editor (https://supabase.com/dashboard)

create table chat_history (
  id text primary key,
  user_id uuid references auth.users(id) on delete cascade not null,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  updated_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  data jsonb not null default '{}'::jsonb
);

-- Index for fast user lookups sorted by recency
create index chat_history_user_id_idx on chat_history (user_id, updated_at desc);

-- Row Level Security: users can only access their own chats
alter table chat_history enable row level security;

create policy "Users can read own chats"
  on chat_history for select
  using (auth.uid() = user_id);

create policy "Users can insert own chats"
  on chat_history for insert
  with check (auth.uid() = user_id);

create policy "Users can update own chats"
  on chat_history for update
  using (auth.uid() = user_id);

create policy "Users can delete own chats"
  on chat_history for delete
  using (auth.uid() = user_id);
