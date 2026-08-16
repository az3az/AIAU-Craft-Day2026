"""住所 → 緯度経度 のジオコーディング (結果はJSONファイルにキャッシュする)。

プロバイダ:
    google     Google Geocoding API。GOOGLE_MAPS_API_KEY が必要。
    nominatim  OpenStreetMap Nominatim。APIキー不要だがデモ用途向け
               (1秒1リクエスト、User-Agent 必須)。

APIキーは .env / Fly secrets などの環境変数からのみ読み、コードやCSVには書きません。

必要な環境変数:
    GEOCODER              google | nominatim (既定: GOOGLE_MAPS_API_KEY があれば google)
    GOOGLE_MAPS_API_KEY   google プロバイダ利用時のみ
"""

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from supabase_client import create_ssl_context

BASE_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CACHE_FILE = BASE_DIR / "data" / "geocode_cache.json"

GOOGLE_ENDPOINT = "https://maps.googleapis.com/maps/api/geocode/json"
NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "AIAU-Craft-Day2026-route-demo/1.0"


class GeocodeError(RuntimeError):
    pass


def default_provider():
    provider = os.environ.get("GEOCODER", "").strip().lower()
    if provider:
        return provider
    return "google" if os.environ.get("GOOGLE_MAPS_API_KEY") else "nominatim"


BLOCK_NUMBER_PATTERN = re.compile(r"(\d+)[-\u2010-\u2015\uff0d]\d+(?:[-\u2010-\u2015\uff0d]\d+)?\s*$")


def address_variants(address):
    """見つからなかったときに試す、粒度を粗くした住所を返す。

    "東京都港区海岸1-7-1" のような街区番号は Nominatim などで当たらないので、
    "東京都港区海岸1丁目" まで落として再検索する。
    """
    variants = []
    coarse = BLOCK_NUMBER_PATTERN.sub(r"\g<1>丁目", address)
    if coarse != address:
        variants.append(coarse)
        variants.append(BLOCK_NUMBER_PATTERN.sub("", address).strip())
    return [variant for variant in variants if variant]


def normalize_address(address):
    """全角スペースなどの揺れを吸収して、キャッシュキーを安定させる。"""
    return " ".join((address or "").replace("\u3000", " ").split())


class GeocodeCache:
    """住所 → 座標 のキャッシュ。JSONファイルに保存する。"""

    def __init__(self, path=DEFAULT_CACHE_FILE):
        self.path = Path(path)
        self.entries = {}
        self.hits = 0
        self.misses = 0
        if self.path.exists():
            with self.path.open(encoding="utf-8") as file:
                try:
                    self.entries = json.load(file)
                except json.JSONDecodeError as error:
                    raise GeocodeError(
                        f"キャッシュファイルを読めません: {self.path} ({error})。"
                        " 削除するか --cache で別ファイルを指定してください。"
                    ) from error

    @staticmethod
    def key(provider, address):
        return f"{provider}:{normalize_address(address)}"

    def get(self, provider, address):
        entry = self.entries.get(self.key(provider, address))
        if entry:
            self.hits += 1
        else:
            self.misses += 1
        return entry

    def put(self, provider, address, entry):
        self.entries[self.key(provider, address)] = entry

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("w", encoding="utf-8") as file:
            json.dump(self.entries, file, ensure_ascii=False, indent=2, sort_keys=True)
            file.write("\n")


class Geocoder:
    def __init__(self, provider=None, api_key=None, cache=None, min_interval=None):
        self.provider = (provider or default_provider()).lower()
        if self.provider not in ("google", "nominatim"):
            raise GeocodeError(f"未対応のプロバイダです: {self.provider}")

        self.api_key = api_key or os.environ.get("GOOGLE_MAPS_API_KEY", "")
        if self.provider == "google" and not self.api_key:
            raise GeocodeError(
                "GOOGLE_MAPS_API_KEY を環境変数 (.env / Fly secrets) に設定してください。"
                " キー無しで試す場合は --provider nominatim を使ってください。"
            )

        self.cache = cache if cache is not None else GeocodeCache()
        # Nominatim は 1秒1リクエストが利用規約の上限。
        self.min_interval = 1.0 if min_interval is None and self.provider == "nominatim" else (min_interval or 0.0)
        self.ssl_context = create_ssl_context()
        self.api_calls = 0
        self._last_call_at = 0.0

    def geocode(self, address):
        """住所を {"lat", "lng", "formatted_address", "provider"} に変換する。

        見つからない住所は None を返す (呼び出し側で人が補正できるようにする)。
        """
        address = normalize_address(address)
        if not address:
            return None

        cached = self.cache.get(self.provider, address)
        if cached is not None:
            return cached or None

        result = self._call_api(address)
        # 見つからなかった場合も {} を入れて、同じ住所を何度も問い合わせない。
        self.cache.put(self.provider, address, result or {})
        return result

    def _call_api(self, address):
        for candidate in [address, *address_variants(address)]:
            self._throttle()
            payload = self._fetch_json(self._build_url(candidate))
            self.api_calls += 1

            if self.provider == "google":
                result = self._parse_google(payload)
            else:
                result = self._parse_nominatim(payload)

            if result:
                result["matched_address"] = candidate
                return result

        return None

    def _throttle(self):
        if not self.min_interval:
            return
        elapsed = time.monotonic() - self._last_call_at
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        self._last_call_at = time.monotonic()

    def _build_url(self, address):
        if self.provider == "google":
            params = {
                "address": address,
                "key": self.api_key,
                "language": "ja",
                "region": "jp",
            }
            return f"{GOOGLE_ENDPOINT}?{urllib.parse.urlencode(params)}"

        params = {
            "q": address,
            "format": "jsonv2",
            "limit": "1",
            "countrycodes": "jp",
            "accept-language": "ja",
        }
        return f"{NOMINATIM_ENDPOINT}?{urllib.parse.urlencode(params)}"

    def _fetch_json(self, url):
        request = urllib.request.Request(url)
        request.add_header("User-Agent", USER_AGENT)
        try:
            with urllib.request.urlopen(request, context=self.ssl_context) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:200]
            raise GeocodeError(
                f"ジオコーディングに失敗しました: {error.code} {detail}"
            ) from error
        except urllib.error.URLError as error:
            raise GeocodeError(f"ジオコーディングに接続できません: {error.reason}") from error

    def _parse_google(self, payload):
        status = payload.get("status")
        if status == "ZERO_RESULTS":
            return None
        if status != "OK":
            raise GeocodeError(
                f"Google Geocoding API エラー: {status} {payload.get('error_message', '')}".strip()
            )

        top = payload["results"][0]
        location = top["geometry"]["location"]
        return {
            "lat": round(float(location["lat"]), 6),
            "lng": round(float(location["lng"]), 6),
            "formatted_address": top.get("formatted_address", ""),
            "provider": "google",
        }

    def _parse_nominatim(self, payload):
        if not payload:
            return None
        top = payload[0]
        return {
            "lat": round(float(top["lat"]), 6),
            "lng": round(float(top["lon"]), 6),
            "formatted_address": top.get("display_name", ""),
            "provider": "nominatim",
        }
