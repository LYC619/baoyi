"""Exercise actual browse dispatch against a deterministic upstream-shaped client."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bridge', root/'resources/comic/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
events, calls = [], []
bridge.emit = lambda event, **value: events.append((event, value))
class Page:
    page_count = 7
    def iter_id_title_tag(self): return iter([('123','合成漫画',['标签'])])
class Client:
    def __getattr__(self, name):
        def call(*args, **kwargs):
            calls.append((name,args,kwargs));return Page()
        return call
jm = SimpleNamespace(JmMagicConstants=SimpleNamespace(TIME_ALL='all',CATEGORY_ALL='0',ORDER_BY_VIEW='view'))
client = Client()
for period in ['day','week','month','all']:
    bridge.browse(jm,client,dict(mode='ranking',page=2,period=period))
for scope in ['all','author','tag']:
    bridge.browse(jm,client,dict(mode='search',page=1,scope=scope,query='合成'))
assert [c[0] for c in calls] == ['day_ranking','week_ranking','month_ranking','categories_filter','search_site','search_author','search_tag']
assert all(event[1]['pages']==7 for event in events if event[0]=='browse_page')
for query in [dict(mode='ranking',page=0),dict(mode='search',page=1,query=''),dict(mode='ranking',page=1,period='invalid')]:
    try: bridge.browse(jm,client,query);raise AssertionError('invalid request accepted')
    except bridge.AdapterError: pass
print('PASS 7 browse routes, bounded summaries, invalid requests')
