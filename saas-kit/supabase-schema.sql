-- ============================================================================
--  블로그랩 (Blog Lab) — Supabase 스키마
--  Naver Blog SEO SaaS: 프로필 / 키워드 이력 / 순위 스냅샷 / 노출 진단 /
--                       빠른 서식 / 구독
--
--  실행 방법
--    1) Supabase 대시보드 > SQL Editor 에서 이 파일 전체를 붙여넣고 Run
--    2) Authentication > Providers 에서 Email / Kakao 등 사용할 로그인 활성화
--    3) 새 사용자가 가입하면 profiles 행이 트리거로 자동 생성됩니다.
--
--  전제: Supabase(PostgreSQL 15+), auth 스키마와 auth.uid() 사용 가능
-- ============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists citext;        -- 이메일/키워드 대소문자 무시(선택)

-- ----------------------------------------------------------------------------
-- 0. 공통: updated_at 자동 갱신
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 1. profiles — 사용자 프로필 (auth.users 1:1)
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  email          citext,
  display_name   text,
  blog_url       text,                       -- 예: https://blog.naver.com/emily37
  blog_id        text,                       -- 예: emily37 (네이버 아이디)
  plan           text not null default 'free'
                 check (plan in ('free','basic','pro','premium')),
  trial_ends_at  timestamptz default (now() + interval '3 days'),
  onboarded_at   timestamptz,
  marketing_opt_in boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.profiles.plan is
  '빠른 조회용 캐시. 실제 결제 상태의 원본은 subscriptions 테이블이며 웹훅에서 동기화한다.';

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- 가입 시 프로필 자동 생성
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             new.raw_user_meta_data->>'nickname')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 2. keywords_history — 키워드 분석 결과 이력
-- ----------------------------------------------------------------------------
create table if not exists public.keywords_history (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  seed_keyword    text not null,                    -- 검색에 사용한 씨앗 키워드
  keyword         text not null,                    -- 수집된 키워드
  monthly_pc      integer check (monthly_pc >= 0),
  monthly_mobile  integer check (monthly_mobile >= 0),
  monthly_total   integer generated always as
                  (coalesce(monthly_pc, 0) + coalesce(monthly_mobile, 0)) stored,
  doc_count       integer check (doc_count >= 0),   -- 블로그탭 문서수(확장 수집)
  competition     text check (competition in ('low','medium','high')),
  score           smallint check (score between 0 and 100),
  source          text not null default 'searchad'
                  check (source in ('searchad','autocomplete','related','manual')),
  collected_on    date not null default ((now() at time zone 'Asia/Seoul')::date),
  collected_at    timestamptz not null default now()
);

comment on table public.keywords_history is
  '같은 키워드라도 수집일이 다르면 별도 행으로 쌓아 검색량 추이를 볼 수 있게 한다.';
comment on column public.keywords_history.score is
  '추천도 0~100. 검색량 대비 문서수가 적을수록 높다(앱의 IRI 점수와 같은 개념).';

create index if not exists ix_keywords_user_recent
  on public.keywords_history (user_id, collected_at desc);

create index if not exists ix_keywords_user_kw
  on public.keywords_history (user_id, keyword);

create unique index if not exists ux_keywords_user_kw_day
  on public.keywords_history (user_id, keyword, collected_on);

-- ----------------------------------------------------------------------------
-- 3. rank_snapshots — 글·키워드별 일별 순위 기록
-- ----------------------------------------------------------------------------
create table if not exists public.rank_snapshots (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  post_url       text not null,                  -- https://blog.naver.com/{id}/{logNo}
  keyword        text not null,
  rank           integer check (rank between 1 and 1000),  -- null = 노출 누락
  blog_tab_rank  integer check (blog_tab_rank between 1 and 1000),
  is_exposed     boolean not null default true,
  checked_on     date not null default ((now() at time zone 'Asia/Seoul')::date),
  checked_at     timestamptz not null default now(),
  unique (user_id, post_url, keyword, checked_on)
);

comment on table public.rank_snapshots is
  '하루에 한 번, 글+키워드 조합당 한 행. rank가 null이면 검색 결과에서 찾지 못한(누락) 상태.';

create index if not exists ix_rank_user_kw_date
  on public.rank_snapshots (user_id, keyword, checked_on desc);

create index if not exists ix_rank_user_post
  on public.rank_snapshots (user_id, post_url);

-- ----------------------------------------------------------------------------
-- 4. exposure_checks — 노출 진단 기록
-- ----------------------------------------------------------------------------
create table if not exists public.exposure_checks (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  post_url         text,
  keyword          text,
  title            text,
  title_length     smallint check (title_length is null or title_length between 0 and 300),
  char_count       integer check (char_count is null or char_count >= 0),
  paragraph_count  smallint check (paragraph_count is null or paragraph_count >= 0),
  image_count      smallint check (image_count is null or image_count >= 0),
  link_count       smallint check (link_count is null or link_count >= 0),
  keyword_in_title boolean,
  keyword_in_body  boolean,
  max_word_repeat  smallint check (max_word_repeat is null or max_word_repeat >= 0),
  score            smallint check (score between 0 and 100),
  grade            text generated always as (
                     case
                       when score >= 80 then 'good'
                       when score >= 60 then 'fair'
                       else 'poor'
                     end) stored,
  details          jsonb not null default '{}'::jsonb,  -- 항목별 pass/warn/fail 근거
  engine_version   text default 'app-1.0',
  checked_at       timestamptz not null default now()
);

create index if not exists ix_exposure_user_date
  on public.exposure_checks (user_id, checked_at desc);

-- ----------------------------------------------------------------------------
-- 5. quick_templates — 글쓰기 빠른 서식
-- ----------------------------------------------------------------------------
create table if not exists public.quick_templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  body       text not null check (char_length(body) between 1 and 20000),
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create index if not exists ix_templates_user
  on public.quick_templates (user_id, sort_order, created_at);

drop trigger if exists trg_templates_updated_at on public.quick_templates;
create trigger trg_templates_updated_at
  before update on public.quick_templates
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 6. subscriptions — 요금제 구독 (Stripe / 토스페이먼츠)
-- ----------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  plan                   text not null check (plan in ('basic','pro','premium')),
  status                 text not null default 'trialing'
                         check (status in ('trialing','active','past_due','canceled','incomplete','paused')),
  billing_period         text check (billing_period in ('month','year')),
  price_krw              integer check (price_krw >= 0),
  provider               text not null default 'stripe'
                         check (provider in ('stripe','tosspayments','manual')),
  provider_customer_id   text,
  provider_subscription_id text,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.subscriptions is
  '결제 상태의 원본. Stripe/토스 웹훅(service_role)에서만 쓰기를 수행하고, 변경 후 profiles.plan을 동기화한다.';

create index if not exists ix_subs_user on public.subscriptions (user_id, created_at desc);

-- 사용자당 활성 구독은 하나만
create unique index if not exists ux_one_active_subscription
  on public.subscriptions (user_id)
  where status in ('trialing','active','past_due','incomplete');

drop trigger if exists trg_subs_updated_at on public.subscriptions;
create trigger trg_subs_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- 7. RLS — 전 테이블 사용자 본인 행만 접근
-- ----------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.keywords_history enable row level security;
alter table public.rank_snapshots   enable row level security;
alter table public.exposure_checks  enable row level security;
alter table public.quick_templates  enable row level security;
alter table public.subscriptions    enable row level security;

-- profiles ------------------------------------------------------------------
drop policy if exists "profiles: 본인 조회" on public.profiles;
create policy "profiles: 본인 조회"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profiles: 본인 생성" on public.profiles;
create policy "profiles: 본인 생성"
  on public.profiles for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "profiles: 본인 수정" on public.profiles;
create policy "profiles: 본인 수정"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- keywords_history ----------------------------------------------------------
drop policy if exists "keywords: 본인 조회" on public.keywords_history;
create policy "keywords: 본인 조회"
  on public.keywords_history for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "keywords: 본인 추가" on public.keywords_history;
create policy "keywords: 본인 추가"
  on public.keywords_history for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "keywords: 본인 삭제" on public.keywords_history;
create policy "keywords: 본인 삭제"
  on public.keywords_history for delete to authenticated
  using (user_id = (select auth.uid()));

-- rank_snapshots ------------------------------------------------------------
drop policy if exists "rank: 본인 조회" on public.rank_snapshots;
create policy "rank: 본인 조회"
  on public.rank_snapshots for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "rank: 본인 기록" on public.rank_snapshots;
create policy "rank: 본인 기록"
  on public.rank_snapshots for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "rank: 본인 수정" on public.rank_snapshots;
create policy "rank: 본인 수정"
  on public.rank_snapshots for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "rank: 본인 삭제" on public.rank_snapshots;
create policy "rank: 본인 삭제"
  on public.rank_snapshots for delete to authenticated
  using (user_id = (select auth.uid()));

-- exposure_checks -----------------------------------------------------------
drop policy if exists "exposure: 본인 조회" on public.exposure_checks;
create policy "exposure: 본인 조회"
  on public.exposure_checks for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "exposure: 본인 추가" on public.exposure_checks;
create policy "exposure: 본인 추가"
  on public.exposure_checks for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "exposure: 본인 삭제" on public.exposure_checks;
create policy "exposure: 본인 삭제"
  on public.exposure_checks for delete to authenticated
  using (user_id = (select auth.uid()));

-- quick_templates -----------------------------------------------------------
drop policy if exists "templates: 본인 조회" on public.quick_templates;
create policy "templates: 본인 조회"
  on public.quick_templates for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "templates: 본인 추가" on public.quick_templates;
create policy "templates: 본인 추가"
  on public.quick_templates for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "templates: 본인 수정" on public.quick_templates;
create policy "templates: 본인 수정"
  on public.quick_templates for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "templates: 본인 삭제" on public.quick_templates;
create policy "templates: 본인 삭제"
  on public.quick_templates for delete to authenticated
  using (user_id = (select auth.uid()));

-- subscriptions -------------------------------------------------------------
-- 조회만 허용. 생성/수정은 결제 웹훅이 service_role 키로 수행한다(RLS 우회).
drop policy if exists "subs: 본인 조회" on public.subscriptions;
create policy "subs: 본인 조회"
  on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- ----------------------------------------------------------------------------
-- 8. 편의 함수 · 뷰
-- ----------------------------------------------------------------------------

-- 오늘의 사용량(요금제 한도 체크용)
create or replace view public.v_my_daily_usage
with (security_invoker = on) as
select
  (select auth.uid()) as user_id,
  (select count(*) from public.keywords_history
    where user_id = (select auth.uid())
      and collected_on = (now() at time zone 'Asia/Seoul')::date) as keyword_queries_today,
  (select count(*) from public.exposure_checks
    where user_id = (select auth.uid())
      and (checked_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date) as exposure_checks_today,
  (select count(distinct (post_url, keyword)) from public.rank_snapshots
    where user_id = (select auth.uid())) as tracked_posts;

comment on view public.v_my_daily_usage is
  '앱 대시보드에서 하루 한도 표시에 사용. security_invoker=on 이므로 RLS가 그대로 적용된다.';

-- 현재 유효한 구독(체험 포함)을 판정
create or replace function public.has_active_plan(p_min_plan text default 'basic')
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = (select auth.uid())
      and (
        (s.status = 'trialing' and coalesce(s.current_period_end, now() + interval '1 day') > now())
        or (s.status = 'active' and coalesce(s.current_period_end, now() + interval '1 day') > now())
      )
      and case p_min_plan
            when 'basic'   then s.plan in ('basic','pro','premium')
            when 'pro'     then s.plan in ('pro','premium')
            when 'premium' then s.plan = 'premium'
            else true
          end
  );
$$;

-- 오래된 이력 정리(선택): 90일 지난 키워드 이력, 2년 지난 순위 스냅샷
-- Supabase > Database > Scheduled Functions(pg_cron)에서 매일 04:00 KST 실행 권장
create or replace function public.prune_old_history()
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.keywords_history where collected_at < now() - interval '90 days';
  delete from public.rank_snapshots   where checked_at   < now() - interval '730 days';
$$;

-- 정리 함수는 관리자(cron)만 실행: 일반 사용자에게서 실행 권한 회수
revoke all on function public.prune_old_history() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 9. 샘플 데이터(선택) — 개발 계정에서만 실행하세요.
--    auth.users에 이미 존재하는 uuid로 바꿔 사용합니다.
-- ----------------------------------------------------------------------------
-- insert into public.quick_templates (user_id, name, body, is_default, sort_order)
-- values
--   ('00000000-0000-0000-0000-000000000000', '도입부 (공감 → 주제)',
--    E'안녕하세요, 오늘은 {주제} 이야기를 해보려고 합니다.\n\n저도 처음에는 잘 몰라서 이것저것 찾아봤는데, 직접 해보니 생각보다 어렵지 않았어요.', true, 1);

-- ============================================================================
--  끝. 적용 후 확인:
--    select tablename, rowsecurity from pg_tables where schemaname = 'public';
--    select * from public.v_my_daily_usage;
-- ============================================================================
