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

from route_optimizer import START_POINT, load_destinations, optimize_route
from supabase_client import SupabaseClient

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


def destination_id_map(client, external_ids):
    if not external_ids:
        return {}

    quoted = ",".join(f'"{external_id}"' for external_id in sorted(set(external_ids)))
    rows = client.select(
        DESTINATIONS_TABLE,
        query=f"select=id,external_id&external_id=in.({quoted})",
    )
    return {row["external_id"]: row["id"] for row in rows}


def build_run(route, label, delivery_date):
    return {
        "run_label": label,
        "delivery_date": delivery_date,
        "start_name": START_POINT["name"],
        "start_address": START_POINT["address"],
        "start_lat": float(START_POINT["lat"]),
        "start_lng": float(START_POINT["lng"]),
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
        default="supabase",
        help="配送先の取得元",
    )
    parser.add_argument("--label", default=None, help="実行の名前 (例: 2026-02-01_午前便)")
    parser.add_argument("--delivery-date", default=None, help="配送日 (YYYY-MM-DD)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Supabaseに保存せず、保存予定の内容を表示する",
    )
    args = parser.parse_args()

    client = None if (args.dry_run and args.source == "csv") else SupabaseClient()

    if args.source == "csv":
        destinations = load_destinations()
    else:
        destinations = fetch_destinations(client)
        if not destinations:
            raise SystemExit(
                f"{DESTINATIONS_TABLE} に有効な配送先がありません。"
                " 先に src/import_destinations.py を実行してください。"
            )

    route = optimize_route(destinations)
    run = build_run(route, args.label, args.delivery_date)

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
    main()
