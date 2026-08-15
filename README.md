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
