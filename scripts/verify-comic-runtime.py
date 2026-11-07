"""Offline checks against the actual pinned upstream decoder, isolated imports."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('comic_bridge', root/'resources/comic/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
jm = bridge.load_library(root/'output/comic-runtime/site-packages')
bridge.own_windows_job()
from PIL import Image
assert all('hermes-runtime/python/Lib/site-packages' not in p.replace('\\', '/') for p in sys.path)
assert jm.__version__ == '2.7.11'
for url in ['http://www.cdnhjk.net/album?id=123','https://127.0.0.1/album','https://www.cdnhjk.net.evil/album','https://user@www.cdnhjk.net/album','file:///tmp/x']:
    try:
        bridge.allowed_url(url, resolve=False)
        raise AssertionError(url)
    except bridge.AdapterError:
        pass
bridge.allowed_url('https://www.cdnhjk.net/album?id=123', resolve=False)
bridge.allowed_url('https://cdn-msp.jmapiproxy1.cc/media/photos/230000/00001.jpg', image=True, resolve=False)
with tempfile.TemporaryDirectory(prefix='decoder-',dir=root/'output/p1-p2-comic-2026-11-06') as temporary:
    folder = Path(temporary)
    original = Image.new('RGB',(20,40))
    for y in range(40):
        for x in range(20):
            original.putpixel((x,y),(y*5,x*8,100))
    scrambled = Image.new('RGB',original.size)
    for index in range(10):
        scrambled.paste(original.crop((0,index*4,20,index*4+4)),(0,(9-index)*4))
    source, output = folder/'source.png', folder/'decoded.png'
    scrambled.save(source)
    image = type('Fixture',(),dict(scramble_id=220980,aid=230000,img_file_name='00001'))()
    value = bridge.decode_page(jm,source,output,image)
    with Image.open(output) as decoded:
        assert decoded.tobytes() == original.tobytes(), '实际上游算法还原后必须逐像素相同'
    assert value['width']==20 and value['height']==40 and value['size']>0
    try:
        bridge.safe_directory(folder,'../outside')
        raise AssertionError('越界目录未拒绝')
    except bridge.AdapterError:
        pass
print(json.dumps({'passed':3,'checks':['独立固定版本导入','来源地址与目录约束','真实上游十段图片还原逐像素核对']},ensure_ascii=False))
