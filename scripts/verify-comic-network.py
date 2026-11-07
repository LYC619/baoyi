"""Transport fault checks with the real pinned client/session and synthetic bytes."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json
import os
import tempfile
import time

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', root/'resources/comic/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
jm = bridge.load_library(root/'output/comic-runtime/site-packages')
from curl_cffi import requests, CurlOpt
import certifi

jm.JmModuleConfig.FLAG_API_CLIENT_REQUIRE_COOKIES = False
proxy = {h: 'http://127.0.0.1:7890' for h in bridge.API_HOSTS+bridge.IMAGE_HOSTS}
client, transport = bridge.network(jm, proxy, bridge.API_HOSTS[0])
checks = []
if os.name == 'nt':
    assert transport.session.curl_options[CurlOpt.CAINFO] == certifi.where().encode('mbcs')
assert transport.session.verify is True
checks.append('UTF-8进程显式使用Windows证书路径编码，保持TLS校验')

class Response:
    def __init__(self, status=200, chunks=(b'{}',), headers=None):
        self.status_code, self.headers = status, headers or {}
        self.chunks, self.closed, self.content = chunks, False, b''
    def iter_content(self, _size):
        for value in self.chunks:
            if isinstance(value, Exception):
                raise value
            yield value
    def close(self):
        self.closed = True

def failure(response, code):
    with patch.object(transport.session, 'get', return_value=response):
        try:
            transport.get('https://www.cdnhjk.net/album?id=123')
            raise AssertionError('request should fail')
        except bridge.AdapterError as error:
            assert error.code == code
            assert response.closed
            return error

error = failure(Response(429, headers={'retry-after': '120'}), 'rate_limited')
assert int(time.time()*1000)+110000 < error.retry_at < int(time.time()*1000)+130000
failure(Response(403), 'access_required')
failure(Response(302), 'http')
checks.append('429保存重试时间，403与跳转停止且关闭响应')

calls=[]
def mirror(url, **kwargs):
    calls.append(url)
    assert kwargs['allow_redirects'] is False
    assert kwargs['proxies']['all'] == proxy[bridge.API_HOSTS[0]]
    if len(calls) == 1:
        raise requests.RequestsError('synthetic transport failure', code=7)
    return Response()
with patch.object(transport.session, 'get', side_effect=mirror):
    transport.get('https://www.cdnhjk.net/album?id=123')
assert len(calls)==2 and calls[1].startswith('https://www.cdngwc.cc/')
checks.append('仅传输故障轮换固定镜像，保留代理路由')

with tempfile.TemporaryDirectory(prefix='network-',dir=root/'output/p1-p2-comic-2026-11-06') as temporary:
    target=Path(temporary)/'00001.part'
    response=Response(chunks=(b'partial', requests.RequestsError('synthetic disconnect',code=18)))
    with patch.object(transport.session,'get',return_value=response):
        try:
            transport.fetch('https://cdn-msp.jmapiproxy1.cc/media/photos/123/00001.jpg',output=target)
            raise AssertionError('half transfer should fail')
        except requests.RequestsError:
            assert target.read_bytes()==b'partial' and response.closed
    response=Response(chunks=(b'a'*10,b'b'*10))
    with patch.object(transport.session,'get',return_value=response):
        try:
            transport.fetch('https://cdn-msp.jmapiproxy1.cc/media/albums/123.jpg',image=True,max_bytes=15)
            raise AssertionError('limit should fail')
        except bridge.AdapterError as error:
            assert error.code=='size' and response.closed
checks.append('半页传输不伪装成功，流式字节额度中止并关闭连接')

bridge.cancelled.set()
with patch.object(transport.session,'get') as get:
    try:
        transport.get('https://www.cdnhjk.net/album?id=123')
        raise AssertionError('cancelled should fail')
    except bridge.AdapterError as error:
        assert error.code=='cancelled' and not get.called
bridge.cancelled.clear()
checks.append('取消之后不再发出来源请求')
transport.session.close()
print(json.dumps(dict(passed=len(checks),checks=checks),ensure_ascii=False))
