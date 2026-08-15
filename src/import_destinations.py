"""配送先CSVをSupabaseの delivery_destinations に取り込む。

使い方:
    export SUPABASE_URL=...
    export SUPABASE_SERVICE_ROLE_KEY=...
    python3 src/import_destinations.py

    # 接続せずに、送信する中身だけ確認する
    python3 src/import_destinations.py --dry-run

CSVは以下の列を前提にしています。
    id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority
"""

import argparse
import csv
import json
from pathlib import Path

from supabase_client import SupabaseClient

BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_FILE = BASE_DIR / "data" / "sample_delivery_destinations.csv"
TABLE = "delivery_destinations"
REQUIRED_COLUMNS = ["id", "name", "address", "lat", "lng"]
BATCH_SIZE = 200


def parse_optional_time(value):
    text = (value or "").strip()
    if not text:
        return None
    parts = text.split(":")
    if len(parts) < 2 or not all(part.isdigit() for part in parts):
        raise ValueError(f"時刻の形式が正しくありません: {value}")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"時刻の範囲が正しくありません: {value}")
    return f"{hour:02d}:{minute:02d}:00"


def parse_int(value, default):
    text = (value or "").strip()
    return default if not text else int(text)


def row_to_record(row, line_number, source):
    missing = [column for column in REQUIRED_COLUMNS if not (row.get(column) or "").strip()]
    if missing:
        raise ValueError(f"{line_number}行目: 必須列が空です: {', '.join(missing)}")

    return {
        "external_id": row["id"].strip(),
        "name": row["name"].strip(),
        "address": row["address"].strip(),
        "lat": float(row["lat"]),
        "lng": float(row["lng"]),
        "time_window_start": parse_optional_time(row.get("time_window_start")),
        "time_window_end": parse_optional_time(row.get("time_window_end")),
        "service_minutes": parse_int(row.get("service_minutes"), 0),
        "priority": parse_int(row.get("priority"), 9),
        "is_active": True,
        "source": source,
    }


def load_records(input_file, source):
    with Path(input_file).open(newline="", encoding="utf-8-sig") as file:
        reader = csv.DictReader(file)
        records = []
        seen = set()

        for line_number, row in enumerate(reader, start=2):
            if not any((value or "").strip() for value in row.values()):
                continue

            record = row_to_record(row, line_number, source)
            if record["external_id"] in seen:
                raise ValueError(f'{line_number}行目: idが重複しています: {record["external_id"]}')
            seen.add(record["external_id"])
            records.append(record)

    if not records:
        raise ValueError("取り込む行がありません。")

    return records


def chunked(items, size):
    for index in range(0, len(items), size):
        yield items[index : index + size]


def main():
    parser = argparse.ArgumentParser(description="配送先CSVをSupabaseに取り込む")
    parser.add_argument("--input", default=str(DEFAULT_INPUT_FILE), help="取り込むCSVファイル")
    parser.add_argument("--source", default="csv", help="取込み元の記録 (csv / salesforce など)")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Supabaseに送らず、送信予定のJSONを表示する",
    )
    args = parser.parse_args()

    records = load_records(args.input, args.source)

    if args.dry_run:
        print(json.dumps(records, ensure_ascii=False, indent=2))
        print(f"{len(records)}件を取り込む想定です (dry-run)。")
        return

    client = SupabaseClient()
    imported = 0
    for batch in chunked(records, BATCH_SIZE):
        imported += len(client.upsert(TABLE, batch, on_conflict="external_id"))

    print(f"{imported}件を {TABLE} に取り込みました。")


if __name__ == "__main__":
    main()
