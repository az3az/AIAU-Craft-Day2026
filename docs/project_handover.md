# 引き継ぎドキュメント

この配送ルート作成プロジェクトを、別の担当者・別のツールでも続けられるようにまとめた資料です。
実データや鍵は一切書きません。環境変数名だけを書き、値は `.env` / Fly secrets / Apps Script の
スクリプトプロパティで管理します。

## 1. 何を作っているか

配送先データから配送順を作り、配車担当者が Google Sheets で確認できるようにする仕組みです。

```text
配送先データ (住所CSV / スケジュールExcel)
  ↓ Python: ジオコーディング・ルート計算
Supabase (delivery_destinations / route_runs / route_stops)
  ↓ Apps Script が anon キーで読み取り
Google Sheets 「ルート結果」シート
```

役割分担は、Supabase が「データの正」、Google Sheets が「見る・直す場所」です。
高権限の `service_role` はローカル管理スクリプトとバッチ実行にだけ使い、Sheets 側には置きません。

Google Sheets の具体的な設定手順は [google_sheets_setup.md](google_sheets_setup.md) にまとめています。

### Supabase の役割

| 役割 | 内容 |
| --- | --- |
| データの正 | 配送先マスタ（`delivery_destinations`）と、実行ごとのルート（`route_runs` / `route_stops`）を保持する |
| 履歴 | 実行のたびに `route_runs` が増えるため、過去のルートを後から参照できる |
| 公開の窓口 | `latest_route_stops` / `latest_route_summary` の2ビューだけを anon に公開し、Sheets はここだけを読む |
| 権限の壁 | 3テーブルは RLS 有効 + anon/authenticated から revoke。書き込みは `service_role` を持つローカル/バッチのみ |

最新ルートの選び方は `where status in ('completed','exported') order by created_at desc, id desc limit 1` です。
Supabase を使わずローカルCSVと Sheets だけで動かすことも可能で、その場合は履歴と共有が失われます。

## 2. main に入っている機能（すべてマージ済み）

| 機能 | 実装 | 対応PR |
| --- | --- | --- |
| 配送順の作成（優先度→距離の貪欲法、Haversine距離） | `src/route_optimizer.py` | #1 |
| Supabaseのテーブル・ビュー・RLS・grant | `supabase/schema.sql` | #1, #7 |
| 配送先CSVのSupabase取込（upsert、文字コード指定、重複ID検出） | `src/import_destinations.py` | #1 |
| ルート結果のSupabase保存（route_runs / route_stops） | `src/save_route_to_supabase.py` | #1 |
| Supabase REST クライアント（certifi によるTLS） | `src/supabase_client.py` | #1, #3 |
| Apps Script: 段階1のシート内ルート作成 | `apps-script/Code.gs` `optimizeRoute` | #1 |
| Apps Script: 段階2のSupabase読み取り（anonキーのみ） | `apps-script/Code.gs` `importRouteFromSupabase` | #1 |
| Apps Script: 段階3の Sheets 完結版（住所の座標化と日付タブ出力） | `apps-script/Code.gs` `createRouteFromInputSheet` | #12 |
| ルート結果シート上部のメタ情報表示（`latest_route_summary`） | `apps-script/Code.gs`, `supabase/schema.sql` | #7 |
| ルート結果シートの表示書式（行高・折り返し・列幅・背景色・ヘッダー固定） | `apps-script/Code.gs` | #8 |
| Fly.io での単発バッチ実行 | `Dockerfile`, `fly.toml` | #3 |
| 住所だけのCSVのジオコーディング（キャッシュ・起点切替・異常系メッセージ） | `src/geocoder.py`, `src/geocode_destinations.py` | #5 |
| スケジュールExcelから人が補正できる中間CSVを抽出 | `src/extract_tasks_from_excel.py` | #10 |
| README の提出用サマリー | `README.md` | #9 |

### マージ済みPR

| PR | 内容 |
| --- | --- |
| #1 | Supabaseのテーブル設計、CSV取込、ルート結果保存、Apps Script連携 |
| #3 | Fly.io でのバッチ実行と certifi によるTLS対応 |
| #5 | 住所だけのCSVをジオコーディングしてルートを作る |
| #7 | ルート結果シート上部に最新ルートのメタ情報を表示 |
| #8 | ルート結果シートの表示書式を整える |
| #9 | README に提出用サマリーを追加 |
| #10 | スケジュールExcelからタスク候補CSVを抽出 |
| #12 | Apps Script 段階3の Sheets 完結版（`createRouteFromInputSheet`） |

### 未マージ・クローズしたPR

| PR | 内容 | 状態 |
| --- | --- | --- |
| #4 | Excel抽出の初版 | クローズ。#10 で作り直したため不要。ブランチ削除済み |
| #6 | Excel抽出の再作成版 | クローズ。#10 で作り直したため不要。ブランチ削除済み |

現在オープンな機能PRはありません。

## 3. ファイル構成

```text
data/
  sample_delivery_destinations.csv   緯度経度ありの配送先サンプル
  sample_addresses.csv               住所だけのサンプル
output/
  optimized_route.csv                生成される配送順
src/
  route_optimizer.py                 配送順の作成（ローカル確認用）
  geocoder.py                        住所→緯度経度（Google / Nominatim、JSONキャッシュ）
  geocode_destinations.py            住所CSV → 配送先CSV
  extract_tasks_from_excel.py        スケジュールExcel → 人が補正できる中間CSV
  supabase_client.py                 Supabase REST の最小クライアント
  import_destinations.py             配送先CSVをSupabaseへ取り込む
  save_route_to_supabase.py          ルート結果をSupabaseへ保存
supabase/schema.sql                  テーブル・ビュー・RLS・grant
apps-script/Code.gs                  Google Sheets 用スクリプト
apps-script/tests/code_test.js       Code.gs の回帰確認（node で実行、外部通信なし）
docs/feature_ideas.md                機能案
docs/project_handover.md             この資料
docs/google_sheets_setup.md          Google Sheets 側の設定手順
Dockerfile / fly.toml                Fly.io 用
```

## 4. 使う環境変数（値はここに書かない）

| 変数名 | 使う場所 | 用途 |
| --- | --- | --- |
| `SUPABASE_URL` | ローカル / Fly / Apps Script | プロジェクトURL |
| `SUPABASE_SERVICE_ROLE_KEY` | ローカル / Fly のみ | 書き込み。**Apps Script には置かない** |
| `SUPABASE_ANON_KEY` | Apps Script のみ | 公開ビューの読み取り |
| `GOOGLE_MAPS_API_KEY` | ローカル / Fly / Apps Script | Google Geocoding API |
| `GEOCODER` | ローカル / Fly | `google` または `nominatim`。未設定時は `GOOGLE_MAPS_API_KEY` があれば `google`、無ければ `nominatim`（開発確認専用）になる |
| `ROUTE_ORIGIN` / `ROUTE_ORIGIN_ADDRESS` / `ROUTE_ORIGIN_LAT` / `ROUTE_ORIGIN_LNG` / `ROUTE_ORIGIN_NAME` | ローカル / Fly | 起点の指定 |
| `ROUTE_ORIGIN_ADDRESS` / `ROUTE_ORIGIN_LAT` / `ROUTE_ORIGIN_LNG` / `ROUTE_ORIGIN_NAME` | Apps Script | 段階3の起点の指定（スクリプトプロパティ） |

`.env` は `.gitignore` 済みです。鍵・実住所・顧客名はコミットしません。

## 4.1 使ってはいけないキー・データ

禁止:

- `SUPABASE_SERVICE_ROLE_KEY` を Apps Script のスクリプトプロパティ、スプレッドシートのセル、
  クライアント側コード、リポジトリに置くこと。RLS を無視して全書き込みができてしまいます。
- 鍵・トークン（Supabase の各キー、`GOOGLE_MAPS_API_KEY`、Fly のトークン）をコミットすること。
  値は `.env`（`.gitignore` 済み）、Fly secrets、Apps Script のスクリプトプロパティにだけ置きます。
- 実在の顧客名・スタッフ名・取引先名・実住所・伝票番号を、コード・サンプルCSV・README・PR説明・
  Issue に書くこと。サンプルは `◯◯様＠△△会場` のような匿名の値を使います。
- 会社のスケジュールExcelやそこから作った中間CSVをコミットすること。`.gitignore` で `*.xlsx` / `*.xls` と
  `data/` 配下の生成CSV・JSON を除外し、`data/sample_addresses.csv` と
  `data/sample_delivery_destinations.csv` だけを追跡対象にしています。
- 本番・デモで Nominatim を使うこと（存在しない住所を別地点にマッチさせるため、開発確認専用）。

使ってよいもの:

- `SUPABASE_ANON_KEY`（公開ビューの読み取りのみ。Apps Script に置いてよい唯一の Supabase キー）
- 匿名化したサンプル（`data/sample_addresses.csv`、`data/sample_delivery_destinations.csv`）

## 5. 動作確認済みの手順（そのまま再現できます）

### 5.0 ハッカソンで通した流れ

```text
住所だけのCSV
  → src/geocode_destinations.py で緯度経度を付与（結果はキャッシュ）
  → src/route_optimizer.py で配送順を作成（起点は東京駅／センター切替）
  → src/import_destinations.py で配送先をSupabaseへ取込
  → src/save_route_to_supabase.py でルートをSupabaseへ保存
  → Google Sheets の importRouteFromSupabase で「ルート結果」シートに表示
```

この通し確認はプロジェクト所有者のローカル環境で成功しています。途中で Python の TLS 証明書エラーが
出たため、`certifi` を使う対応を入れて解消しました。以下は各ステップの再実行手順です。

### 5.1 準備

```bash
git clone https://github.com/az3az/AIAU-Craft-Day2026.git
cd AIAU-Craft-Day2026
pip install -r requirements.txt
```

### 5.2 ローカルだけで配送順を作る

```bash
python3 src/route_optimizer.py
python3 src/route_optimizer.py --input data/sample_delivery_destinations.csv --origin tokyo_station
```

`output/optimized_route.csv` に `stop_no,id,name,address,time_window,service_minutes,priority,leg_distance_km,total_distance_km` が出力されます。

### 5.3 住所だけのCSVからルートを作る

```bash
# 本番・デモは Google Geocoding API を使う
export GOOGLE_MAPS_API_KEY=...    # .env / Fly secrets で管理。コードには書かない
python3 src/geocode_destinations.py \
  --input data/sample_addresses.csv \
  --output data/geocoded_destinations.csv

# キー無しで挙動だけ見る場合（開発確認専用）
python3 src/geocode_destinations.py --provider nominatim --dry-run

python3 src/route_optimizer.py --input data/geocoded_destinations.csv --origin tokyo_station
```

結果は `data/geocode_cache.json` にキャッシュされ、同じ住所は2回目以降APIを呼びません。
キャッシュと変換結果は `.gitignore` 対象です。

### 5.4 起点を切り替える

```bash
ROUTE_ORIGIN_ADDRESS="東京都江東区新木場1丁目" \
  python3 src/route_optimizer.py --input data/geocoded_destinations.csv --origin center
```

`--origin` は `tokyo_station`（既定）、`center`（環境変数から取得）、任意の住所文字列を受け付けます。

### 5.5 Supabase に取り込む・保存する

```bash
# 1. Supabase の SQL Editor で supabase/schema.sql を実行する
# 2. .env に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を置く（ローカルのみ）
python3 src/import_destinations.py --input data/geocoded_destinations.csv
python3 src/save_route_to_supabase.py --source supabase --label 2026-02-01_午前便

# 送信内容だけ確認する
python3 src/save_route_to_supabase.py --source csv --input data/geocoded_destinations.csv --dry-run
```

文字コードが違うCSVは `--encoding cp932` のように指定します。

### 5.6 Google Sheets で見る

詳細と、つまずいたときの対処は [google_sheets_setup.md](google_sheets_setup.md) にあります。

段階1（Supabaseなし）:

1. スプレッドシートを作り、シート名を `配送先` にする
2. `data/sample_delivery_destinations.csv` の中身を貼り付ける
3. `拡張機能 > Apps Script` に `apps-script/Code.gs` を貼り付ける
4. メニュー `配送ルート > シートからルート作成 (段階1)` を実行する

段階2（Supabaseの結果を読む）:

1. Apps Script の `プロジェクトの設定 > スクリプト プロパティ` に `SUPABASE_URL` と `SUPABASE_ANON_KEY` を登録する
2. メニュー `配送ルート > Supabaseから取得 (段階2)` を実行する
3. `ルート結果` シートの1〜6行目にメタ情報、8行目にヘッダー、9行目以降に明細が出る

### 5.7 スケジュールExcelから中間CSVを作る

```bash
python3 src/extract_tasks_from_excel.py --input "<スケジュール>.xlsx" --output data/tasks.csv
python3 src/extract_tasks_from_excel.py --input "<スケジュール>.xlsx" --sheet 815 --dry-run
```

出力は `date,task_type,customer,venue_name,address,start_time,end_time,required_vehicle,required_staff_count,assigned_vehicle,assigned_staff,origin,notes` です。
`address` は空欄で出るので、人が補ってから 5.5 の流れに乗せます。

### 5.8 Fly.io での単発バッチ実行

```bash
fly apps create <アプリ名>
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
fly deploy --build-only --push
fly machine run <イメージ> --command "python3 src/save_route_to_supabase.py --source supabase" --detach
```

## 6. 確認できていること / 未検証のこと

確認済み:

- ローカル → Supabase 取込・保存 → Google Sheets 表示の通し動作（プロジェクト所有者が実施）
- Python の TLS 証明書問題を `certifi` で解消（`ssl.create_default_context(cafile=certifi.where())`）
- Docker ビルドとコンテナ内での `--dry-run` 実行、コンテナ内からのHTTPS接続
- 住所CSV → ジオコーディング → 配送順 → 起点切替 → 保存内容の dry-run（CLI通し）

未検証:

- Fly.io 上での実行（`FLY_API_TOKEN` が必要）
- Google Geocoding API を使った実ジオコーディング（`GOOGLE_MAPS_API_KEY` が必要）
- 大量件数（数百件以上）での実行時間とAPI費用
- 複数人が同時に Sheets を操作した場合の挙動

注意点:

- Nominatim は存在しない住所文字列を別地点にマッチさせることがあるため、開発確認専用です。
  本番・デモでは Google Geocoding API を使ってください。
- ルート計算は Haversine の直線距離ベースで、道路距離や渋滞は考慮していません。

## 7. Google Sheets 完結版（段階3。PR #12 で main にマージ済み）

**目的**: ローカルPCやSupabaseを使わなくても、Google Workspace の中だけで配送順を作れる形にする。

実装済み（`apps-script/Code.gs` の `createRouteFromInputSheet`、手順は
[google_sheets_setup.md](google_sheets_setup.md) の4章）:

- `配送先入力` シートの `id,name,address,priority`（日本語見出しも可）を読む。`id` / `name` が空でも動く。
- 配送日は見出し行より上の `配送日` セルか `delivery_date` 列から取る。
- `UrlFetchApp` で Google Geocoding API を呼び、座標を `配送先入力` シートの `lat` / `lng` に書き戻す
  （同じ住所は再取得しない）。1回の実行は80件までで、超えた回は座標の書き戻しだけ行い、
  ルートタブは作らずに再実行を促すエラーにする（全件の座標が揃った回にルートを作る）。
- 起点はスクリプトプロパティ（`ROUTE_ORIGIN_ADDRESS` または `ROUTE_ORIGIN_LAT`/`ROUTE_ORIGIN_LNG`、`ROUTE_ORIGIN_NAME`）。
- APIキーは `GOOGLE_MAPS_API_KEY` をスクリプトプロパティに置く。コード・シート・リポジトリには書かない。
- 出力は `YYYY-MM-DD_配送ルート` タブ。同名があれば上書きせず `_2` から連番。形式は段階2と同じ。
- 段階1 / 段階2（`optimizeRoute` / `importRouteFromSupabase`）の動作は変えていない。

ロジックの回帰確認: `node apps-script/tests/code_test.js`（Google のサービスをスタブして、外部通信なしで実行）。

未実装で残っていること:

- 実の Google Sheets と Google Geocoding API での実行確認（APIキー未共有のため未実施）。
- 段階1（`optimizeRoute`）のメタ情報表示と起点設定。現在も東京駅固定のまま。
- Sheets からの Supabase 保存（Edge Function など anon で安全に呼べる経路を検討。`service_role` は置かない）。
- 日付一覧タブとテンプレート複製（7.1 参照）。

## 7.1 日付ごとのシートタブ作成要件

配車は日単位で動くため、Google Sheets 完結版では1日1タブに分ける必要があります。

要件:

- タブ名は `YYYY-MM-DD`（例: `2026-08-15`）で統一する。並べ替えと検索がしやすいため。
- 「その日のタブを作る」操作をメニューから実行できるようにし、日付を指定して作成する。
- 新しいタブはテンプレートシート（列構成・書式・数式を持つ雛形）を複製して作る。列構成を手で作らせない。
- 同名タブが既にある場合は上書きせず、そのタブに移動して知らせる。
- ルート結果は日付タブごとに書き出し、他の日のタブを壊さない。
- 一覧タブ（例: `日付一覧`）に、日付・配送先件数・合計距離・最終更新をまとめ、各タブへのリンクを置く。
- 古いタブは自動削除しない。手動アーカイブとし、消える動作は作らない。
- Supabase と併用する場合は、日付タブと `route_runs.delivery_date` を対応させ、
  取り込み時に日付が一致する run を読む。

## 7.2 ターミナルを使えないスタッフ向けの将来フロー

最終的に、配車担当者がコマンドを一切打たずに完結する形を目指します。

想定フロー:

1. 担当者がスプレッドシートを開く
2. メニュー `配送ルート > 今日のタブを作る` で日付タブを作る
3. 配送先の住所を貼り付ける（座標は不要）
4. メニュー `配送ルート > 住所から座標を取得` を実行する（Apps Script が Geocoding API を呼ぶ）
5. メニュー `配送ルート > ルート作成` を実行する
6. 上部にメタ情報、下部に配送順が表示される
7. 必要なら順序を手で入れ替え、再計算せずそのまま印刷・共有する

満たすべき条件:

- インストール作業ゼロ。ブラウザとGoogleアカウントだけで使える。
- エラーは日本語で、次にやることが分かる文言にする（例: 「住所が空の行が3件あります」）。
- APIキーなどの設定は管理者が一度スクリプトプロパティに入れるだけで、担当者は触らない。
- 実行の途中で失敗しても、シートの既存データを壊さない。
- 定期実行が要る場合は、Apps Script のトリガーか Fly.io のバッチを管理者側で設定する。

## 8. その後の開発候補

| 候補 | 内容 | 想定規模 |
| --- | --- | --- |
| 起点プリセット | 実際の配送センターを `--origin center` の既定にする | 小 |
| Fly.io 定期実行 | スケジュール実行で毎朝ルートを更新する | 小 |
| 複数車両対応 | 車両ごとに配送先を分割し、車両別のルートを作る | 中 |
| 配送時間帯制約 | `time_window` を守る順序付けに変える（現在は表示のみ） | 中 |
| 道路距離・所要時間 | Haversine から Google Distance Matrix などへ | 中 |
| Excel中間CSVの接続 | 抽出CSVの住所補完後に取込へ流す運用を固める | 中 |
| スタッフ稼働連携 | 設営・撤去の人数や担当と突き合わせる | 大 |
| 実績との差分比較 | 計画ルートと実配送結果を比較して改善する | 大 |

## 9. 開発時の約束ごと

- `main` に直接コミットしない。作業は新しいブランチで行い、PR はレビュー後にマージする。
- 鍵・トークン・実顧客名・実会社データはコミットしない。サンプルは匿名化した値を使う。
- `service_role` キーを Apps Script やフロント側に置かない。公開する読み取りは
  `latest_route_stops` / `latest_route_summary` のビュー経由に限定する。
- `supabase/schema.sql` を変更したら、既存プロジェクトでの再実行が必要なことを明記する。
- 実行確認していない項目は「未検証」と書く。
