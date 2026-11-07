import os,json,sqlite3
from pathlib import Path
root=Path('E:/图片'); out=Path('output/photo-library-2026-10-29');out.mkdir(parents=True,exist_ok=True)
db=sqlite3.connect((Path(os.environ['APPDATA'])/'抱一/baoyi.db').as_uri()+'?mode=ro',uri=True);db.row_factory=sqlite3.Row
items=[dict(r) for r in db.execute('SELECT r.id,r.path,r.source_dir,m.item_type,m.group_id FROM resource r JOIN image_meta m ON m.resource_id=r.id')]
folders=[]
for category in (root/'照片').iterdir():
    if not category.is_dir():continue
    extensions={}; total=0
    for base,dirs,files in os.walk(category):
        for name in files:
            ext=Path(name).suffix.lower();extensions[ext]=extensions.get(ext,0)+1;total+=1
    folders.append({'name':category.name,'files':total,'extensions':extensions})
jobs=[dict(r) for r in db.execute('SELECT status,count(*) n FROM image_download_jobs GROUP BY status')]
report={'items':items,'photoFolders':folders,'jobs':jobs,'missingResourcePaths':[r['id'] for r in items if not Path(r['path']).exists()]}
(out/'discovery.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps({'items':len(items),'photoFolders':folders,'jobs':jobs,'missingResourcePaths':report['missingResourcePaths']},ensure_ascii=False,indent=2))
db.close()
