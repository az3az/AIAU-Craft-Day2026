"""配送先CSVをSupabaseの delivery_destinations に取り込む。

使い方:
    export SUPABASE_URL=...
    export SUPABASE_SERVICE_ROLE_KEY=...
    python3 src/import_destinations.py

    # Excel由来のShift_JIS CSV
    python3 src/import_destinations.py --encoding cp932

    # 接続せずに、送信する中身だけ確認する
    python3 src/import_destinations.py --dry-run

CSVは以下の列を前提にしています。
    id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority

取込みは external_id をキーにした upsert なので、同じCSVを何度実行しても
結果は同じになります (途中で失敗した場合はそのまま再実行してください)。
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
DEFAULT_ENCODING = "utf-8-sig"
DEFAULT_BATCH_SIZE = 200


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


def load_records(input_file, source, encoding=DEFAULT_ENCODING, allow_duplicate_ids=False):
    """CSVを読んで delivery_destinations の行に変換する。

    同じCSV内で id が重複していた場合は、既定ではエラーにして何も送信しない。
    --allow-duplicate-ids を付けると、後の行を採用 (last-wins) して警告を出す。
    """
    try:
        with Path(input_file).open(newline="", encoding=encoding) as file:
            rows = list(csv.DictReader(file))
    except FileNotFoundError as error:
        raise ValueError(
            f"配送先CSVが見つかりません: {input_file} (--input のパスを確認してください)"
        ) from error
    except IsADirectoryError as error:
        raise ValueError(
            f"{input_file} はディレクトリです。CSVファイルを指定してください。"
        ) from error
    except UnicodeDecodeError as error:
        raise ValueError(
            f"{input_file} を {encoding} で読めませんでした。"
            " --encoding cp932 などで文字コードを指定してください。"
        ) from error

    records = []
    index_by_external_id = {}

    for line_number, row in enumerate(rows, start=2):
        if not any((value or "").strip() for value in row.values()):
            continue

        record = row_to_record(row, line_number, source)
        external_id = record["external_id"]

        if external_id in index_by_external_id:
            if not allow_duplicate_ids:
                raise ValueError(
                    f"{line_number}行目: idが重複しています: {external_id}。"
                    " 後の行を採用してよければ --allow-duplicate-ids を付けてください。"
                )
            print(
                f"警告: {line_number}行目の id {external_id} が重複しています。後の行を採用します。"
            )
            records[index_by_external_id[external_id]] = record
            continue

        index_by_external_id[external_id] = len(records)
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
        "--encoding",
        default=DEFAULT_ENCODING,
        help="CSVの文字コード (例: utf-8-sig, cp932, utf-8)",
    )
    parser.add_argument(
        "--allow-duplicate-ids",
        action="store_true",
        help="同じCSV内でidが重複したとき、エラーにせず後の行を採用する",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=DEFAULT_BATCH_SIZE,
        help="1回の送信で扱う件数",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Supabaseに送らず、送信予定のJSONを表示する",
    )
    args = parser.parse_args()

    if args.batch_size < 1:
        raise SystemExit("--batch-size は1以上にしてください。")

    records = load_records(
        args.input,
        args.source,
        encoding=args.encoding,
        allow_duplicate_ids=args.allow_duplicate_ids,
    )

    if args.dry_run:
        print(json.dumps(records, ensure_ascii=False, indent=2))
        print(f"{len(records)}件を取り込む想定です (dry-run)。")
        return

    client = SupabaseClient()
    imported = 0
    try:
        for batch in chunked(records, args.batch_size):
            imported += len(client.upsert(TABLE, batch, on_conflict="external_id"))
    except Exception:
        # バッチごとの送信なので、途中で止まると部分的に反映された状態になる。
        # external_id の upsert なので、同じCSVをそのまま再実行すればよい。
        print(
            f"途中で失敗しました。{imported}/{len(records)}件が反映済みです。"
            " external_idのupsertなので、同じCSVをそのまま再実行してください。"
        )
        raise

    print(f"{imported}件を {TABLE} に取り込みました。")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error)) from error
