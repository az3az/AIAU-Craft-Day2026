import argparse
import csv
import math
import os
from pathlib import Path

from geocoder import Geocoder, GeocodeError


BASE_DIR = Path(__file__).resolve().parents[1]
INPUT_FILE = BASE_DIR / "data" / "sample_delivery_destinations.csv"
OUTPUT_FILE = BASE_DIR / "output" / "optimized_route.csv"

START_POINT = {
    "id": "START",
    "name": "出発地点",
    "address": "東京駅",
    "lat": "35.681236",
    "lng": "139.767125",
}

# --origin / ROUTE_ORIGIN で選べる起点。
# center は会社センターの住所が環境ごとに違うので、
# ROUTE_ORIGIN_ADDRESS (ジオコーディングする) か ROUTE_ORIGIN_LAT/LNG で指定する。
ORIGIN_PRESETS = {"tokyo_station": START_POINT}


def resolve_start_point(origin=None, geocoder=None):
    """起点を決める。プリセット名・住所・環境変数のいずれでも指定できる。"""
    origin = (origin or os.environ.get("ROUTE_ORIGIN") or "tokyo_station").strip()

    if origin in ORIGIN_PRESETS:
        return dict(ORIGIN_PRESETS[origin])

    if origin == "center":
        lat = os.environ.get("ROUTE_ORIGIN_LAT")
        lng = os.environ.get("ROUTE_ORIGIN_LNG")
        address = os.environ.get("ROUTE_ORIGIN_ADDRESS", "")
        name = os.environ.get("ROUTE_ORIGIN_NAME", "センター")
        if lat and lng:
            return {"id": "START", "name": name, "address": address, "lat": lat, "lng": lng}
        if not address:
            raise SystemExit(
                "--origin center を使うには ROUTE_ORIGIN_ADDRESS か"
                " ROUTE_ORIGIN_LAT / ROUTE_ORIGIN_LNG を設定してください。"
            )
        return geocode_origin(address, name, geocoder)

    # プリセットでなければ住所そのものとして扱う。
    return geocode_origin(origin, origin, geocoder)


def geocode_origin(address, name, geocoder=None):
    location = (geocoder or Geocoder()).geocode(address)
    if location is None:
        raise SystemExit(f"起点の住所が見つかりませんでした: {address}")

    return {
        "id": "START",
        "name": name,
        "address": address,
        "lat": f'{location["lat"]:.6f}',
        "lng": f'{location["lng"]:.6f}',
    }


def distance_km(a, b):
    lat1 = math.radians(float(a["lat"]))
    lon1 = math.radians(float(a["lng"]))
    lat2 = math.radians(float(b["lat"]))
    lon2 = math.radians(float(b["lng"]))

    dlat = lat2 - lat1
    dlon = lon2 - lon1
    haversine = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 6371 * 2 * math.atan2(math.sqrt(haversine), math.sqrt(1 - haversine))


def load_destinations(input_file=None):
    with Path(input_file or INPUT_FILE).open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def optimize_route(destinations, start_point=None):
    remaining = destinations[:]
    current = start_point or START_POINT
    route = []
    total_distance = 0.0

    while remaining:
        next_stop = min(
            remaining,
            key=lambda stop: (
                int(stop["priority"]),
                distance_km(current, stop),
            ),
        )
        leg_distance = distance_km(current, next_stop)
        total_distance += leg_distance

        route.append(
            {
                "stop_no": len(route) + 1,
                "id": next_stop["id"],
                "name": next_stop["name"],
                "address": next_stop["address"],
                "time_window": f'{next_stop["time_window_start"]}-{next_stop["time_window_end"]}',
                "service_minutes": next_stop["service_minutes"],
                "priority": next_stop["priority"],
                "leg_distance_km": round(leg_distance, 2),
                "total_distance_km": round(total_distance, 2),
            }
        )

        current = next_stop
        remaining.remove(next_stop)

    return route


def save_route(route):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "stop_no",
        "id",
        "name",
        "address",
        "time_window",
        "service_minutes",
        "priority",
        "leg_distance_km",
        "total_distance_km",
    ]

    with OUTPUT_FILE.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(route)


def main():
    parser = argparse.ArgumentParser(description="配送順を作成する")
    parser.add_argument("--input", help=f"配送先CSV (既定: {INPUT_FILE})")
    parser.add_argument(
        "--origin",
        help="起点。tokyo_station / center / 住所そのもの (環境変数 ROUTE_ORIGIN でも指定可)",
    )
    args = parser.parse_args()

    start_point = resolve_start_point(args.origin)
    destinations = load_destinations(args.input)
    route = optimize_route(destinations, start_point)
    save_route(route)
    print(f'起点: {start_point["name"]} ({start_point["lat"]},{start_point["lng"]})')
    print(f"配送順を作成しました: {OUTPUT_FILE}")


if __name__ == "__main__":
    try:
        main()
    except GeocodeError as error:
        raise SystemExit(str(error)) from error
