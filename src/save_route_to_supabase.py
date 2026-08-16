"""ルート作成の結果を Supabase の route_runs / route_stops に保存する。

使い方:
    export SUPABASE_URL=...
    export SUPABASE_SERVICE_ROLE_KEY=...

    # Supabaseの配送先マスタからルートを作って保存する
    python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便

    # 手元のCSVからルートを作って保存する
    python3 src/save_route_to_supabase.py --source csv

    # 保存せずに中身だけ確認する
    python3 src/save_route_to_supabase.py --source csv --dry-run
"""

import argparse
import json
import os
from urllib.parse import quote

from geocode_destinations import ensure_coordinates
from geocoder import GeocodeError
from route_optimizer import load_destinations, optimize_route, resolve_start_point
from supabase_client import SupabaseClient, SupabaseError

DESTINATIONS_TABLE = "delivery_destinations"
RUNS_TABLE = "route_runs"
STOPS_TABLE = "route_stops"
ALGORITHM = "priority_nearest_neighbor"


def to_hhmm(value):
    return (value or "")[:5]


def fetch_destinations(client):
    columns = (
        "id,external_id,name,address,lat,lng,"
        "time_window_start,time_window_end,service_minutes,priority"
    )
    rows = client.select(
        DESTINATIONS_TABLE,
        query=f"select={columns}&is_active=eq.true&order=external_id.asc",
    )

    return [
        {
            "destination_id": row["id"],
            "id": row["external_id"],
            "name": row["name"],
            "address": row["address"] or "",
            "lat": str(row["lat"]),
            "lng": str(row["lng"]),
            "time_window_start": to_hhmm(row["time_window_start"]),
            "time_window_end": to_hhmm(row["time_window_end"]),
            "service_minutes": str(row["service_minutes"]),
            "priority": str(row["priority"]),
        }
        for row in rows
    ]


def quote_in_value(value):
    """PostgRESTの in.(...) に入れる1つ分を安全な形にする。

    カンマやダブルクオートを含むidでも壊れないよう、ダブルクオートで囲って
    中の \\ と " をエスケープし、その上でURLエンコードする。
    """
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return quote(f'"{escaped}"', safe="")


def destination_id_map(client, external_ids):
    if not external_ids:
        return {}

    values = ",".join(quote_in_value(external_id) for external_id in sorted(set(external_ids)))
    rows = client.select(
        DESTINATIONS_TABLE,
        query=f"select=id,external_id&external_id=in.({values})",
    )
    return {row["external_id"]: row["id"] for row in rows}


def build_run(route, label, delivery_date, start_point):
    return {
        "run_label": label,
        "delivery_date": delivery_date,
        "start_name": start_point["name"],
        "start_address": start_point["address"],
        "start_lat": float(start_point["lat"]),
        "start_lng": float(start_point["lng"]),
        "algorithm": ALGORITHM,
        "total_distance_km": route[-1]["total_distance_km"] if route else 0,
        "stop_count": len(route),
        "status": "completed",
    }


def build_stops(route, route_run_id, id_map):
    return [
        {
            "route_run_id": route_run_id,
            "destination_id": id_map.get(stop["id"]),
            "stop_no": stop["stop_no"],
            "external_id": stop["id"],
            "name": stop["name"],
            "address": stop["address"],
            "time_window": stop["time_window"],
            "service_minutes": int(stop["service_minutes"]),
            "priority": int(stop["priority"]),
            "leg_distance_km": stop["leg_distance_km"],
            "total_distance_km": stop["total_distance_km"],
        }
        for stop in route
    ]


def main():
    parser = argparse.ArgumentParser(description="ルート結果をSupabaseに保存する")
    parser.add_argument(
        "--source",
        choices=["csv", "supabase"],
        default=os.environ.get("ROUTE_SOURCE", "supabase"),
        help="配送先の取得元 (環境変数 ROUTE_SOURCE でも指定可)",
    )
    parser.add_argument(
        "--label",
        default=os.environ.get("ROUTE_RUN_LABEL"),
        help="実行の名前 (例: 2026-02-01_午前便。環境変数 ROUTE_RUN_LABEL でも指定可)",
    )
    parser.add_argument(
        "--delivery-date",
        default=os.environ.get("DELIVERY_DATE"),
        help="配送日 (YYYY-MM-DD。環境変数 DELIVERY_DATE でも指定可)",
    )
    parser.add_argument(
        "--origin",
        default=os.environ.get("ROUTE_ORIGIN"),
        help="起点。tokyo_station / center / 住所そのもの (環境変数 ROUTE_ORIGIN でも指定可)",
    )
    parser.add_argument(
        "--input",
        default=os.environ.get("ROUTE_INPUT_CSV"),
        help="--source csv のときに読むCSV (既定: data/sample_delivery_destinations.csv)",
    )
    parser.add_argument(
        "--geocode-cache",
        default=os.environ.get("GEOCODE_CACHE"),
        help="ジオコーディングキャッシュのファイル (既定: data/geocode_cache.json)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Supabaseに保存せず、保存予定の内容を表示する",
    )
    args = parser.parse_args()

    client = None if (args.dry_run and args.source == "csv") else SupabaseClient()

    start_point = resolve_start_point(args.origin)

    if args.source == "csv":
        # lat/lng の無い住所CSVでも、その場でジオコーディングして続行する。
        destinations = ensure_coordinates(
            load_destinations(args.input),
            cache_path=args.geocode_cache,
        )
    else:
        destinations = fetch_destinations(client)
        if not destinations:
            raise SystemExit(
                f"{DESTINATIONS_TABLE} に有効な配送先がありません。"
                " 先に src/import_destinations.py を実行してください。"
            )

    route = optimize_route(destinations, start_point)
    run = build_run(route, args.label, args.delivery_date, start_point)

    if args.dry_run:
        preview = {"route_run": run, "route_stops": build_stops(route, None, {})}
        print(json.dumps(preview, ensure_ascii=False, indent=2))
        print(f"{len(route)}件の配送順を保存する想定です (dry-run)。")
        return

    id_map = {
        destination["id"]: destination["destination_id"]
        for destination in destinations
        if destination.get("destination_id")
    } or destination_id_map(client, [stop["id"] for stop in route])

    route_run_id = client.insert(RUNS_TABLE, [run])[0]["id"]
    client.insert(STOPS_TABLE, build_stops(route, route_run_id, id_map))

    print(f"route_run_id={route_run_id} に {len(route)}件の配送順を保存しました。")


if __name__ == "__main__":
    try:
        main()
    except (SupabaseError, GeocodeError) as error:
        raise SystemExit(str(error)) from error
