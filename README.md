# AIAU Craft Day 2026 - 配送ルート作成

配送先リストから、配送しやすい順番のルートを作り、最終的にGoogle Sheetsへ出力するためのハッカソン用プロジェクトです。

## まず作るもの

- 仮の配送先データ
- 配送順を並べ替えるロジック
- Google Sheetsに貼り付けやすい出力
- 会社のGoogle Workspace上で動かせるApps Script

## フォルダ構成

```text
data/
  sample_delivery_destinations.csv   仮の配送先リスト
output/
  optimized_route.csv                作成された配送順
src/
  route_optimizer.py                 ローカル確認用
apps-script/
  Code.gs                            Google Sheetsで動かす用
docs/
  feature_ideas.md                   追加機能の案
```

## データの前提

今回の仮データは、住所だけではなく緯度・経度も入れています。
住所だけから正確な距離を出すにはGoogle Maps APIなどが必要になるため、まずはハッカソンで動く形を優先します。

SalesforceからCSVを書き出すときも、最終的には以下の列に寄せる想定です。

```text
id,name,address,lat,lng,time_window_start,time_window_end,service_minutes,priority
```

## ローカルで試す

```bash
python3 src/route_optimizer.py
```

実行すると、`output/optimized_route.csv` が作成されます。

## Fly.ioでのデプロイ手順

Dockerで動かすための `Dockerfile` と `fly.toml` をリポジトリのルートに用意しています。

このスクリプトは実行後すぐ終了するバッチのため、常駐アプリ向けの `fly deploy` ではなく「イメージをpush → 単発マシンで実行」の流れを使います。

```bash
# 初回のみ（アプリを作成。fly.toml の app 名を変えたい場合は先に書き換える）
fly apps create aiau-craft-day2026

# イメージをビルドしてFlyのレジストリにpush（マシンは作らない）
fly deploy --build-only --push -a aiau-craft-day2026
# → 最後に image: registry.fly.io/aiau-craft-day2026:deployment-XXXX が表示される

# 単発実行（--detach を付ける。実行後にマシンは自動削除される）
fly machine run registry.fly.io/aiau-craft-day2026:deployment-XXXX \
  --command "python3 src/route_optimizer.py" \
  --rm --detach -a aiau-craft-day2026 --region nrt

# 実行結果の確認
fly logs -a aiau-craft-day2026 --no-tail
```

ローカルでDockerだけ試す場合は次の通りです。

```bash
docker build -t aiau-craft-day2026 .
docker run --rm aiau-craft-day2026
```

### 注意

- `src/route_optimizer.py` は一度実行して終了するバッチスクリプトです。Fly.ioの常駐アプリ（Webサーバー）用途とは異なるため、`fly.toml` には `[http_service]` を設定していません。
- そのため `fly deploy`（および `--detach` なしの `fly machine run`）は、マシンが起動状態を維持しないため `timeout reached waiting for machine's state to change` というエラーで終了します。処理自体は成功しており（`fly logs` に `配送順を作成しました` と `Main child exited normally with code: 0` が出ます）、上記の `--build-only --push` + `--detach` の手順を使えばエラーになりません。
- 常駐させてブラウザから使いたい場合は、別途HTTPサーバー化（Flask / FastAPI などでエンドポイントを用意する）が必要です。
- コンテナ内の `output/optimized_route.csv` はマシン停止時に消えます。結果を残したい場合はVolumeやSupabase、Google Sheetsなど外部への出力を検討してください。

## Google Sheetsで使う流れ

1. Google Sheetsを作る
2. シート名を `配送先` にする
3. `data/sample_delivery_destinations.csv` の中身を貼り付ける
4. Google Sheetsのメニューから `拡張機能 > Apps Script` を開く
5. `apps-script/Code.gs` の中身を貼り付ける
6. `optimizeRoute` を実行する
7. `ルート結果` シートに配送順が出力される

## 今後の本番イメージ

```text
Salesforce CSV
  ↓
Google Sheetsに取り込み
  ↓
Apps Scriptでルート作成
  ↓
Google Sheetsに配送順を出力
  ↓
配送担当者が確認・調整
```
