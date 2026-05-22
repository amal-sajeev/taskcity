-- CITYLOG schema for Vercel Postgres (Neon).
--
-- This file is the canonical reference. You do NOT normally have to run it
-- manually: api/_lib/db.js ensures every CREATE TABLE / INDEX statement on
-- the first cold start of a serverless function. It's idempotent.
--
-- Run it by hand only if you want to inspect the schema in the Vercel
-- Storage "Query" tab or set up a local Postgres copy.

create extension if not exists "citext";
create extension if not exists "pgcrypto";

create table if not exists users (
  id            uuid        primary key default gen_random_uuid(),
  email         citext      unique not null,
  password_hash text        not null,
  created_at    timestamptz not null default now()
);

create table if not exists districts (
  id          uuid        primary key,
  user_id     uuid        not null references users(id) on delete cascade,
  name        text        not null,
  color       text        not null,
  "order"     int         not null,
  size        int         not null default 3,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null,
  deleted_at  timestamptz
);
create index if not exists districts_user_updated on districts(user_id, updated_at);

create table if not exists tasks (
  id           uuid        primary key,
  user_id      uuid        not null references users(id) on delete cascade,
  district_id  uuid        not null,
  title        text        not null,
  status       text        not null,
  priority     text,
  building     jsonb,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  completed_at timestamptz,
  updated_at   timestamptz not null,
  deleted_at   timestamptz
);
create index if not exists tasks_user_updated  on tasks(user_id, updated_at);
create index if not exists tasks_user_district on tasks(user_id, district_id);

create table if not exists user_meta (
  user_id    uuid        primary key references users(id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
