"""Supabase (PostgREST) への最小クライアント。

依存は certifi だけです (requirements.txt)。CA証明書が入っていないコンテナなどでも
SSL_CERT_FILE を手で指定せずに動くよう、certifi のCA束を使った SSLContext を
urlopen に渡しています。

必要な環境変数:
    SUPABASE_URL               例: https://xxxxxxxx.supabase.co
    SUPABASE_SERVICE_ROLE_KEY  service_role キー (RLSをバイパスするため取込み用に使う)
"""

import json
import os
import ssl
import urllib.error
import urllib.request

import certifi


class SupabaseError(RuntimeError):
    pass


def create_ssl_context():
    """certifi のCA束を使う SSLContext を返す。"""
    return ssl.create_default_context(cafile=certifi.where())


class SupabaseClient:
    def __init__(self, url=None, service_role_key=None):
        self.url = (url or os.environ.get("SUPABASE_URL", "")).rstrip("/")
        self.service_role_key = service_role_key or os.environ.get(
            "SUPABASE_SERVICE_ROLE_KEY", ""
        )

        if not self.url or not self.service_role_key:
            raise SupabaseError(
                "SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数に設定してください。"
            )

        self.ssl_context = create_ssl_context()

    def _request(self, method, path, payload=None, prefer=None, query=None):
        endpoint = f"{self.url}/rest/v1/{path}"
        if query:
            endpoint = f"{endpoint}?{query}"

        body = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(endpoint, data=body, method=method)
        request.add_header("apikey", self.service_role_key)
        request.add_header("Authorization", f"Bearer {self.service_role_key}")
        request.add_header("Content-Type", "application/json")
        if prefer:
            request.add_header("Prefer", prefer)

        try:
            with urllib.request.urlopen(request, context=self.ssl_context) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise SupabaseError(f"Supabaseの呼び出しに失敗しました: {error.code} {detail}") from error

        return json.loads(raw) if raw else []

    def upsert(self, table, rows, on_conflict):
        """on_conflict の列をキーにして insert または update する。"""
        return self._request(
            "POST",
            table,
            payload=rows,
            prefer="resolution=merge-duplicates,return=representation",
            query=f"on_conflict={on_conflict}",
        )

    def insert(self, table, rows):
        return self._request(
            "POST",
            table,
            payload=rows,
            prefer="return=representation",
        )

    def select(self, table, query=None):
        return self._request("GET", table, query=query)
