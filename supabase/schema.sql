-- TTS测试记录平台 schema（收集阶段）
-- 目标：只保留“基础信息 + 问题收集 + 自动分类结果”

create extension if not exists "pgcrypto";

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  reporter_name text not null,
  tester_device text not null,
  tester_os text,
  created_at timestamptz not null default now()
);

create table if not exists public.observations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  course_name text not null,
  category text not null check (category in ('text', 'tts')),
  tags text[] not null default '{}',
  issue_description text not null,
  feeling_tags text[] not null default '{}',
  feeling_other text,
  created_at timestamptz not null default now()
);

create index if not exists idx_observations_session_created
  on public.observations(session_id, created_at desc);

create index if not exists idx_observations_category
  on public.observations(category);

create index if not exists idx_observations_created_at
  on public.observations(created_at desc);

create index if not exists idx_observations_course_created
  on public.observations(course_name, created_at desc);

create index if not exists idx_sessions_reporter_device
  on public.sessions(reporter_name, tester_device);

create index if not exists idx_observations_tags_gin
  on public.observations using gin(tags);

create index if not exists idx_observations_feeling_tags_gin
  on public.observations using gin(feeling_tags);

alter table public.sessions enable row level security;
alter table public.observations enable row level security;

drop policy if exists sessions_all on public.sessions;
create policy sessions_all on public.sessions
for all
to anon, authenticated
using (true)
with check (true);

drop policy if exists observations_all on public.observations;
create policy observations_all on public.observations
for all
to anon, authenticated
using (true)
with check (true);

-- 升级已部署实例时执行：迁移旧字段到收集阶段结构
alter table public.sessions drop column if exists chapter_name;
alter table public.sessions drop column if exists source_app;

alter table public.observations add column if not exists issue_description text;
alter table public.observations add column if not exists course_name text;
alter table public.observations add column if not exists feeling_tags text[] not null default '{}';
alter table public.observations add column if not exists feeling_other text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'observations'
      and column_name = 'result'
  ) then
    execute 'delete from public.observations where result = ''pass''';
  end if;
end
$$;

update public.observations
set line_text = coalesce(nullif(actual_text, ''), nullif(expected_text, ''), '')
where line_text is null;

update public.observations
set issue_description = coalesce(nullif(note, ''), '历史记录未填写问题描述')
where issue_description is null;

update public.observations
set feeling_tags = '{}'
where feeling_tags is null;

update public.observations o
set course_name = coalesce(o.course_name, s.course_name, '未命名课程')
from public.sessions s
where s.id = o.session_id;

update public.observations
set category = 'tts'
where category is null or category = 'pending';

alter table public.observations alter column category set not null;
alter table public.observations alter column course_name set not null;
alter table public.observations alter column issue_description set not null;
alter table public.observations alter column feeling_tags set not null;

alter table public.observations drop constraint if exists observations_category_check;
alter table public.observations
  add constraint observations_category_check
  check (category in ('text', 'tts'));

alter table public.observations drop column if exists result;
alter table public.observations drop column if exists severity;
alter table public.observations drop column if exists lesson_timestamp;
alter table public.observations drop column if exists expected_text;
alter table public.observations drop column if exists actual_text;
alter table public.observations drop column if exists note;
alter table public.observations drop column if exists evidence_url;
alter table public.observations drop column if exists line_text;
alter table public.observations drop column if exists updated_at;
alter table public.observations drop column if exists review_status;
alter table public.observations drop column if exists reviewer_name;
alter table public.observations drop column if exists owner_name;
alter table public.observations drop column if exists review_note;

drop trigger if exists trigger_observations_updated_at on public.observations;
drop function if exists public.set_updated_at();
drop table if exists public.retest_tasks;

alter table public.sessions drop column if exists course_name;
alter table public.sessions alter column tester_device set not null;
