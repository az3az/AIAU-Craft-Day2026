-- AIAU Craft Day 2026 配送ルート作成 Supabaseスキーマ
--
-- 適用方法:
--   Supabase Studio の SQL Editor にこのファイルの中身を貼り付けて実行する
--   もしくは psql "$SUPABASE_DB_URL" -f supabase/schema.sql

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 共通: updated_at 自動更新
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 配送先マスタ
--   data/sample_delivery_destinations.csv の列にそのまま対応する
--   external_id は CSV の id 列 (D001 など)。再取込みは external_id で upsert する
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_destinations (
  id uuid primary key default gen_random_uuid(),
  external_id text not null unique,
  name text not null,
  address text not null,
  lat double precision not null,
  lng double precision not null,
  time_window_start time,
  time_window_end time,
  service_minutes integer not null default 0 check (service_minutes >= 0),
  priority integer not null default 9 check (priority >= 1),
  is_active boolean not null default true,
  source text not null default 'csv',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_destinations_time_window_check
    check (
      time_window_start is null
      or time_window_end is null
      or time_window_start <= time_window_end
    )
);

create index if not exists delivery_destinations_priority_idx
  on public.delivery_destinations (priority);
create index if not exists delivery_destinations_is_active_idx
  on public.delivery_destinations (is_active);

drop trigger if exists set_delivery_destinations_updated_at on public.delivery_destinations;
create trigger set_delivery_destinations_updated_at
  before update on public.delivery_destinations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- ルート作成の実行単位
--   1回の最適化実行につき1行。出発地点と合計距離をここに持つ
-- ---------------------------------------------------------------------------
create table if not exists public.route_runs (
  id uuid primary key default gen_random_uuid(),
  run_label text,
  delivery_date date,
  start_name text not null default '出発地点',
  start_address text,
  start_lat double precision not null,
  start_lng double precision not null,
  algorithm text not null default 'priority_nearest_neighbor',
  total_distance_km numeric(10, 2) not null default 0,
  stop_count integer not null default 0 check (stop_count >= 0),
  status text not null default 'completed'
    check (status in ('draft', 'completed', 'exported')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists route_runs_delivery_date_idx
  on public.route_runs (delivery_date desc);
create index if not exists route_runs_created_at_idx
  on public.route_runs (created_at desc);

drop trigger if exists set_route_runs_updated_at on public.route_runs;
create trigger set_route_runs_updated_at
  before update on public.route_runs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- ルート結果の明細
--   output/optimized_route.csv の1行が1レコードに対応する
--   配送先が後から削除・変更されても結果が読めるように、表示用の値も持たせる
-- ---------------------------------------------------------------------------
create table if not exists public.route_stops (
  id uuid primary key default gen_random_uuid(),
  route_run_id uuid not null
    references public.route_runs (id) on delete cascade,
  destination_id uuid
    references public.delivery_destinations (id) on delete set null,
  stop_no integer not null check (stop_no >= 1),
  external_id text not null,
  name text not null,
  address text,
  time_window text,
  service_minutes integer not null default 0 check (service_minutes >= 0),
  priority integer not null default 9,
  leg_distance_km numeric(10, 2) not null default 0,
  total_distance_km numeric(10, 2) not null default 0,
  created_at timestamptz not null default now(),
  unique (route_run_id, stop_no)
);

create index if not exists route_stops_route_run_id_idx
  on public.route_stops (route_run_id, stop_no);
create index if not exists route_stops_destination_id_idx
  on public.route_stops (destination_id);

-- ---------------------------------------------------------------------------
-- Google Sheets / Apps Script から読む用のビュー
--   ルート結果シートの列順にそのまま並べている
--   status = 'completed' のものだけを対象にし、作成中 (draft) は出さない。
--   created_at が同じ秒になっても結果がぶれないよう id を tie-breaker にする。
-- ---------------------------------------------------------------------------
create or replace view public.latest_route_stops as
select
  s.route_run_id,
  s.stop_no,
  s.external_id,
  s.name,
  s.address,
  s.time_window,
  s.service_minutes,
  s.priority,
  s.leg_distance_km,
  s.total_distance_km
from public.route_stops s
join public.route_runs r on r.id = s.route_run_id
where r.id = (
  select id
  from public.route_runs
  where status in ('completed', 'exported')
  order by created_at desc, id desc
  limit 1
)
order by s.stop_no;

-- ---------------------------------------------------------------------------
-- ルート結果シートの上部に出すメタ情報 (最新の1件だけ)
--   latest_route_stops と同じ条件で最新 run を選ぶ。読み取りは別クエリになるため、
--   Apps Script 側で route_run_id が一致することを確認している。
-- ---------------------------------------------------------------------------
create or replace view public.latest_route_summary as
select
  r.id as route_run_id,
  r.run_label,
  r.delivery_date,
  r.start_name,
  r.start_address,
  r.total_distance_km,
  r.stop_count,
  r.status,
  r.created_at
from public.route_runs r
where r.id = (
  select id
  from public.route_runs
  where status in ('completed', 'exported')
  order by created_at desc, id desc
  limit 1
);

-- ---------------------------------------------------------------------------
-- RLS / 権限
--   方針:
--     * service_role キーはローカルの管理スクリプト (src/*.py) 専用。
--       Apps Script には置かない。
--     * Apps Script は anon キーで latest_route_stops / latest_route_summary
--       ビューだけを読む。
--     * テーブル本体は anon / authenticated からは一切読めないままにする。
-- ---------------------------------------------------------------------------
alter table public.delivery_destinations enable row level security;
alter table public.route_runs enable row level security;
alter table public.route_stops enable row level security;

-- テーブルには anon / authenticated 向けのポリシーを作らない (= 全拒否)。
-- 既定の GRANT も外して、RLS と権限の両方で閉じておく。
revoke all on public.delivery_destinations from anon, authenticated;
revoke all on public.route_runs from anon, authenticated;
revoke all on public.route_stops from anon, authenticated;

-- Apps Script (anon キー) に公開するのはこのビューだけ。
-- ビューは security_invoker を付けずに作るので、ビュー所有者の権限で
-- 実行され、下のテーブルの RLS を通らずに直近のルートだけを返せる。
-- (PostgreSQL 15+ で security_invoker = true にした場合は、別途 route_runs /
--  route_stops に anon 向け SELECT ポリシーが必要になるので注意)
grant select on public.latest_route_stops to anon, authenticated;
grant select on public.latest_route_summary to anon, authenticated;

-- anon キーも外に出したくない場合は、この grant をやめて
-- Edge Function (service_role をサーバ側に閉じ込める) 経由にする。README参照。
