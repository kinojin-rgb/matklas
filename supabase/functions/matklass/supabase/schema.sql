create extension if not exists pgcrypto;

create table if not exists public.works (
    id uuid primary key default gen_random_uuid(),
    title text not null,
    work_type text not null default 'КР',
    subject text not null default 'Алгебра',
    topic text not null default '',
    difficulty text not null default 'Средняя',
    duration_minutes integer not null default 45
        check (duration_minutes between 1 and 300),
    questions jsonb not null default '[]'::jsonb,
    grading_scale jsonb not null default '{}'::jsonb,
    status text not null default 'draft'
        check (status in ('draft', 'published', 'closed')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.attempts (
    id uuid primary key default gen_random_uuid(),
    work_id uuid not null references public.works(id) on delete cascade,
    student_first_name text not null,
    student_last_name text not null,
    status text not null default 'active'
        check (status in ('active', 'submitted', 'annulled')),
    started_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    deadline_at timestamptz not null,
    submitted_at timestamptz,
    score numeric,
    grade integer,
    annulment_reason text
);

create table if not exists public.attempt_answers (
    id uuid primary key default gen_random_uuid(),
    attempt_id uuid not null references public.attempts(id) on delete cascade,
    question_id text not null,
    answer jsonb not null default 'null'::jsonb,
    updated_at timestamptz not null default now(),
    unique (attempt_id, question_id)
);

create index if not exists works_status_idx
    on public.works(status);

create index if not exists attempts_work_id_idx
    on public.attempts(work_id);

create index if not exists attempts_status_idx
    on public.attempts(status);

create index if not exists attempt_answers_attempt_id_idx
    on public.attempt_answers(attempt_id);

alter table public.works enable row level security;
alter table public.attempts enable row level security;
alter table public.attempt_answers enable row level security;

revoke all on public.works from anon, authenticated;
revoke all on public.attempts from anon, authenticated;
revoke all on public.attempt_answers from anon, authenticated;

grant all on public.works to service_role;
grant all on public.attempts to service_role;
grant all on public.attempt_answers to service_role;
