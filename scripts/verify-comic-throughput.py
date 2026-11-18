"""Offline adapter boundaries with pinned Pillow/JM, no source traffic."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from io import BytesIO
import tempfile
import threading
import time
import json

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', root/'resources/comic/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
jm = bridge.load_library(root/'output/comic-runtime/site-packages')
from PIL import Image
picture = BytesIO()
Image.new('RGB', (40, 60), 'blue').save(picture, format='JPEG')
events, calls = [], []

def cover_fetch(url, **kwargs):
    calls.append(url)
    if len(calls) == 1:
        raise OSError('synthetic unreachable mirror')
    return SimpleNamespace(content=picture.getvalue())

with patch.object(bridge, 'emit', side_effect=lambda *args, **kw: events.append((args, kw))):
    bridge.preview_cover(jm, SimpleNamespace(fetch=cover_fetch), '123')
assert len(calls) == 2 and bridge.IMAGE_HOSTS[1] in calls[1]
assert events[0][1]['value'].startswith('data:image/jpeg;base64,')
for code in ('rate_limited', 'access_required', 'cancelled'):
    with patch.object(bridge, 'emit') as emit:
        fetch = SimpleNamespace(fetch=lambda *a, **kw: (_ for _ in ()).throw(bridge.AdapterError(code, code)))
        try:
            bridge.preview_cover(jm, fetch, '123')
            raise AssertionError('must stop on '+code)
        except bridge.AdapterError as error:
            assert error.code == code and not emit.called

guard = threading.Lock()
active_network = active_decode = peak_network = peak_decode = 0
def fetch_page(url, output, **kw):
    global active_network, peak_network
    with guard:
        active_network += 1
        peak_network = max(peak_network, active_network)
    time.sleep(.06)
    output.write_bytes(picture.getvalue())
    with guard:
        active_network -= 1

original_decode = bridge.decode_page
def decode(*args):
    global active_decode, peak_decode
    with guard:
        active_decode += 1
        peak_decode = max(peak_decode, active_decode)
    try:
        time.sleep(.04)
        return original_decode(*args)
    finally:
        with guard:
            active_decode -= 1

with tempfile.TemporaryDirectory(prefix='baoyi-throughput-') as folder:
    pages = [str(i)+'.jpg' for i in range(10)]
    image = SimpleNamespace(img_url='https://fixture.invalid/image', scramble_id=999999, aid=123, img_file_name='1')
    request = dict(directory=str(Path(folder).resolve()),workId='123',chapters=[dict(id='123',pageIds=pages,directory='chapter',skip=[])])
    with patch.object(bridge, 'catalog', return_value=({},[dict(id='123',pageIds=pages)],{'123':[image]*10})), patch.object(bridge, 'emit', side_effect=lambda *args, **kw: events.append((args, kw))), patch.object(bridge,'decode_page',side_effect=decode):
        bridge.download(jm,None,SimpleNamespace(fetch=fetch_page),request)
    assert peak_network == 5 and peak_decode == 2, (peak_network, peak_decode)
    assert len(list(Path(folder).rglob('*.png'))) == 10
    assert not list(Path(folder).rglob('*.part*'))
    assert len([e for e in events if e[0][0]=='page']) == 10
print(json.dumps(dict(passed=5,checks=['approved cover mirror fallback','429 no bypass','403 no bypass','cancel stops cover','five network and two decoder slots, complete pages']),ensure_ascii=False))
