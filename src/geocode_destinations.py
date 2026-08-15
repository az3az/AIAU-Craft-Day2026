"""lat/lng が無い住所CSVをジオコーディングして、配送先CSVの形に変換する。

入力CSVは address 列があれば十分です (id / name / 時間帯などは任意)。
出力は既存の data/sample_delivery_destinations.csv と同じ列順なので、
そのまま src/import_destinations.py や src/save_route_to_supabase.py に渡せます。

使い方:
    # .env などで GOOGLE_MAPS_API_KEY を設定してから
    python3 src/geocode_destinations.py \
      --input data/sample_addresses.csv \
      --output data/geocoded_destinations.csv

    # APIキー無しで試す (OpenStreetMap Nominatim。デモ用途のみ)
    python3 src/geocode_destinations.py --provider nominatim --dry-run
"""

import argparse
import csv
import sys
from pathlib import Path

from geocoder import DEFAULT_CACHE_FILE, GeocodeCache, Geocoder, GeocodeError

BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = BASE_DIR / "data" / "sample_addresses.csv"
DEFAULT_OUTPUT = BASE_DIR / "data" / "geocoded_destinations.csv"

OUTPUT_COLUMNS = [
    "id",
    "name",
    "address",
    "lat",
    "lng",
    "time_window_start",
    "time_window_end",
    "service_minutes",
    "priority",
]

DEFAULTS = {
    "time_window_start": "09:00",
    "time_window_end": "18:00",
    "service_minutes": "10",
    "priority": "3",
}


def read_rows(path, encoding):
    with Path(path).open(newline="", encoding=encoding) as file:
        reader = csv.DictReader(file)
        if reader.fieldnames is None or "address" not in reader.fieldnames:
            raise SystemExit(f"{path} に address 列がありません。")
        return [{(key or "").strip(): (value or "").strip() for key, value in row.items()} for row in reader]


def build_row(index, source, location):
    return {
        "id": source.get("id") or f"D{index:03d}",
        "name": source.get("name") or source["address"],
        "address": source["address"],
        "lat": source.get("lat") or f'{location["lat"]:.6f}',
        "lng": source.get("lng") or f'{location["lng"]:.6f}',
        "time_window_start": source.get("time_window_start") or DEFAULTS["time_window_start"],
        "time_window_end": source.get("time_window_end") or DEFAULTS["time_window_end"],
        "service_minutes": source.get("service_minutes") or DEFAULTS["service_minutes"],
        "priority": source.get("priority") or DEFAULTS["priority"],
    }


def geocode_rows(rows, geocoder, limit=None):
    """住所を座標に変換する。失敗した行は failures に回す。"""
    resolved = []
    failures = []

    for index, source in enumerate(rows[: limit or len(rows)], start=1):
        address = source.get("address", "")
        if not address:
            failures.append((source, "address が空です"))
            continue

        if source.get("lat") and source.get("lng"):
            resolved.append(build_row(index, source, {"lat": 0.0, "lng": 0.0}))
            continue

        location = geocoder.geocode(address)
        if location is None:
            failures.append((source, "座標が見つかりませんでした"))
            continue

        resolved.append(build_row(index, source, location))

    return resolved, failures


def needs_geocoding(rows):
    return any(not (row.get("lat") and row.get("lng")) for row in rows)


def ensure_coordinates(rows, geocoder=None, cache_path=DEFAULT_CACHE_FILE):
    """lat/lng が欠けている行だけジオコーディングする。

    すでに座標がある場合はAPIを一切呼ばないので、既存のCSV経路はキーなしでも動く。
    """
    if not needs_geocoding(rows):
        return rows

    geocoder = geocoder or Geocoder(cache=GeocodeCache(cache_path))
    try:
        resolved, failures = geocode_rows(rows, geocoder)
    finally:
        geocoder.cache.save()

    for source, reason in failures:
        print(f"[skip] {source.get('address', '')}: {reason}", file=sys.stderr)

    return resolved


def write_rows(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=OUTPUT_COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="住所CSVをジオコーディングして配送先CSVにする")
    parser.add_argument("--input", default=str(DEFAULT_INPUT), help="入力CSV (address 列が必要)")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="出力CSV")
    parser.add_argument("--cache", default=str(DEFAULT_CACHE_FILE), help="ジオコーディング結果のキャッシュファイル")
    parser.add_argument("--provider", choices=["google", "nominatim"], help="ジオコーディング先 (既定: 環境変数 GEOCODER)")
    parser.add_argument("--encoding", default="utf-8-sig", help="入力CSVの文字コード (例: cp932)")
    parser.add_argument("--limit", type=int, help="先頭N件だけ処理する")
    parser.add_argument("--dry-run", action="store_true", help="出力CSVを書かずに結果を表示する")
    args = parser.parse_args()

    rows = read_rows(args.input, args.encoding)
    cache = GeocodeCache(args.cache)
    geocoder = Geocoder(provider=args.provider, cache=cache)

    try:
        resolved, failures = geocode_rows(rows, geocoder, args.limit)
    finally:
        # 途中で失敗しても、それまでの結果は無駄にしない。
        cache.save()

    for source, reason in failures:
        print(f"[skip] {source.get('address', '')}: {reason}", file=sys.stderr)

    if args.dry_run:
        for row in resolved:
            print(f'{row["id"]}\t{row["lat"]},{row["lng"]}\t{row["address"]}')
    else:
        write_rows(args.output, resolved)
        print(f"{len(resolved)}件を {args.output} に書き出しました。")

    print(
        f"provider={geocoder.provider} API呼び出し={geocoder.api_calls}件"
        f" キャッシュヒット={cache.hits}件 失敗={len(failures)}件"
    )


if __name__ == "__main__":
    try:
        main()
    except GeocodeError as error:
        raise SystemExit(str(error)) from error
