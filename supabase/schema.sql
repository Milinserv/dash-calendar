-- Дашин день — схема базы данных Supabase.
-- Выполнить один раз: Supabase → SQL Editor → New query → вставить весь файл → Run.

-- 1. События из iCloud (пары, задачи, дни рождения). Пишет только синхронизация (service_role).
create table if not exists public.events (
  uid        text primary key,
  title      text not null,
  start_at   text not null,          -- 'YYYY-MM-DD' (весь день) или 'YYYY-MM-DDTHH:MM' (местное время, Ижевск)
  end_at     text,
  all_day    boolean not null default false,
  cal        text not null,          -- study | work | important | beauty | health
  location   text default '',
  updated_at timestamptz not null default now()
);

-- 2. Привычки
create table if not exists public.habits (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  target     int  not null default 3 check (target between 1 and 7),
  color      text default '#34C759',
  sort       int  default 0,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 3. Отметки привычек: одна строка = привычка + день
create table if not exists public.habit_logs (
  id         text primary key,       -- '<habit_id>_<YYYY-MM-DD>'
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  habit_id   text not null,
  day        date not null,
  done       boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 4. Галочки «выполнено» у задач из календаря
create table if not exists public.task_done (
  uid        text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  done       boolean not null default true,
  updated_at timestamptz not null default now()
);

-- 5. Очередь изменений для iCloud (задачи, добавленные в приложении)
create table if not exists public.outbox (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  op         text not null check (op in ('add','delete')),
  payload    jsonb not null,
  status     text not null default 'pending' check (status in ('pending','done','error')),
  error      text,
  created_at timestamptz not null default now()
);

-- 6. Служебное: время последней синхронизации и т.п.
create table if not exists public.meta (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- Доступ: только вошедший пользователь и только к своим строкам.
alter table public.events     enable row level security;
alter table public.habits     enable row level security;
alter table public.habit_logs enable row level security;
alter table public.task_done  enable row level security;
alter table public.outbox     enable row level security;
alter table public.meta       enable row level security;

drop policy if exists "events read"   on public.events;
create policy "events read"   on public.events for select to authenticated using (true);
drop policy if exists "meta read"     on public.meta;
create policy "meta read"     on public.meta   for select to authenticated using (true);

drop policy if exists "habits own"    on public.habits;
create policy "habits own"    on public.habits     for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "logs own"      on public.habit_logs;
create policy "logs own"      on public.habit_logs for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "done own"      on public.task_done;
create policy "done own"      on public.task_done  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "outbox own"    on public.outbox;
create policy "outbox own"    on public.outbox     for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create index if not exists habit_logs_day on public.habit_logs (day);
create index if not exists events_start   on public.events (start_at);

-- ===== v2 =====
-- 7. Записи внутри привычки: план и факт (например, контент-план постов)
create table if not exists public.habit_entries (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  habit_id   text not null,
  day        date,                    -- на какой день запланировано / когда сделано
  title      text not null,
  note       text default '',
  status     text not null default 'planned' check (status in ('planned','done')),
  deleted    boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 8. Счётчик переносов задач (пишет синхронизация в 23:00)
create table if not exists public.task_carry (
  uid        text primary key,
  count      int not null default 0,
  first_day  date,
  last_moved timestamptz default now()
);

-- 9. «Потом»: дела без даты, которые можно поставить в удобный день
create table if not exists public.someday (
  id         text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title      text not null,
  url        text default '',
  note       text default '',
  status     text not null default 'open' check (status in ('open','scheduled','done')),
  scheduled_to date,
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.habit_entries enable row level security;
alter table public.task_carry    enable row level security;
alter table public.someday       enable row level security;
drop policy if exists "entries own" on public.habit_entries;
create policy "entries own" on public.habit_entries for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "carry read" on public.task_carry;
create policy "carry read" on public.task_carry for select to authenticated using (true);
drop policy if exists "someday own" on public.someday;
create policy "someday own" on public.someday for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
