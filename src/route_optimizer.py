import csv
import math
from pathlib import Path


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


def load_destinations():
    with INPUT_FILE.open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def optimize_route(destinations):
    remaining = destinations[:]
    current = START_POINT
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
    destinations = load_destinations()
    route = optimize_route(destinations)
    save_route(route)
    print(f"配送順を作成しました: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
