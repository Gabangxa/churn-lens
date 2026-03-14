-- ChurnLens — initial schema
-- Run via: supabase db push

-- -----------------------------------------------------------------------
-- Extensions
-- -----------------------------------------------------------------------
create extension if not exists "uuid-ossp";

-- -----------------------------------------------------------------------
-- Organizations
-- -----------------------------------------------------------------------
create table public.organizations (
  id                  uuid primary key default uuid_generate_v4(),
  name                text not null,
  stripe_account_id   text unique,           -- Stripe Connect account or null for API key auth
  stripe_api_key_enc  text,                  -- AES-256-encrypted restricted key (if not Connect)
  resend_verified     boolean not null default false,
  plan                text not null default 'free'
                        check (plan in ('free', 'starter', 'growth')),
  created_at          timestamptz not null default now()
);

-- -----------------------------------------------------------------------
-- Users (linked to organizations)
-- -----------------------------------------------------------------------
create table public.users (
  id          uuid primary key references auth.users on delete cascade,
  org_id      uuid not null references public.organizations on delete cascade,
  email       text not null,
  name        text,
  role        text not null default 'owner' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------
-- Survey responses
-- -----------------------------------------------------------------------
create table public.survey_responses (
  id                      uuid primary key default uuid_generate_v4(),
  org_id                  uuid not null references public.organizations on delete cascade,
  customer_email          text not null,
  customer_name           text,
  stripe_subscription_id  text not null,
  mrr_lost                integer not null default 0,   -- USD cents converted to whole dollars
  token                   text unique,                  -- signed survey link token
  reason_category         text,                         -- filled when customer submits
  open_text               text,
  comeback_text           text,
  theme_tags              text[] not null default '{}',
  surveyed_at             timestamptz,                  -- null until customer submits
  created_at              timestamptz not null default now()
);

create index survey_responses_org_week
  on public.survey_responses (org_id, surveyed_at desc);

-- -----------------------------------------------------------------------
-- Themes (AI-synthesised weekly clusters)
-- -----------------------------------------------------------------------
create table public.themes (
  id                      uuid primary key default uuid_generate_v4(),
  org_id                  uuid not null references public.organizations on delete cascade,
  week_of                 date not null,                -- Monday of the week
  label                   text not null,
  response_count          integer not null default 0,
  representative_quotes   text[] not null default '{}',
  mrr_impact              integer not null default 0,
  created_at              timestamptz not null default now(),

  unique (org_id, week_of, label)
);

create index themes_org_week
  on public.themes (org_id, week_of desc);

-- -----------------------------------------------------------------------
-- Row-Level Security
-- -----------------------------------------------------------------------
alter table public.organizations    enable row level security;
alter table public.users            enable row level security;
alter table public.survey_responses enable row level security;
alter table public.themes           enable row level security;

-- Users can only see their own org's data
create policy "org members see own org"
  on public.organizations for select
  using (
    id in (
      select org_id from public.users where id = auth.uid()
    )
  );

create policy "org members see own survey responses"
  on public.survey_responses for select
  using (
    org_id in (
      select org_id from public.users where id = auth.uid()
    )
  );

create policy "org members see own themes"
  on public.themes for select
  using (
    org_id in (
      select org_id from public.users where id = auth.uid()
    )
  );
