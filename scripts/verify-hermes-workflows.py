"""Real bundled Hermes, isolated local model endpoint; no external requests."""
import importlib.util
import json
import os
from pathlib import Path
import threading
import uuid
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('protocol', Path(__file__).with_name('verify-hermes-runtime.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.OUT = Path(os.environ.get('BAOYI_HERMES_TEST_OUTPUT', str(p.ROOT / 'output/p1-p2-project-2026-11-06/hermes-workflows')))
p.OUT.mkdir(parents=True, exist_ok=True)
p.PROFILE = p.OUT / ('profile-' + uuid.uuid4().hex[:10])

def main():
    server = ThreadingHTTPServer(('127.0.0.1', 0), p.Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process, events, log = p.launch()
    checks, frames = [], []
    try:
        assert events.get(timeout=90)['type'] == 'ready'
        budget, _ = p.call(process, events, 'insight_budget', {'config':{'model':'gpt-4.1','api_url':f'http://127.0.0.1:{server.server_port}/v1','api_key':'fixture-only'},'text':'合成中文输入' * 100})
        assert budget['inputLimit'] == int(budget['contextTokens'] * .6) and budget['estimatedTokens'] > 2500 and budget['estimated'], budget
        checks.append('native Hermes context metadata and CJK token budget')
        canary = 'ONLY_ORDINARY_MEMORY_CANARY_2606'
        p.call(process, events, 'memory_edit', {'target':'user','action':'add','content':canary})
        args = {'sessionId':'ordinary-'+uuid.uuid4().hex,'text':'读取合成证据','config':{'model':'fixture','api_url':f'http://127.0.0.1:{server.server_port}/v1','api_key':'fixture-only'},'system':'使用 archive_probe 取得证据。','maxIterations':5,'tools':[{'name':'archive_probe','description':'读取合成证据','parameters':{'type':'object','properties':{},'additionalProperties':False}}]}
        result, seen = p.call(process, events, 'run', args); frames += seen
        ready = next(x for x in seen if x.get('event') == 'ready')
        assert ready['memoryEnabled'] and 'memory' in ready['tools'], ready
        assert canary in json.dumps(p.REQUESTS, ensure_ascii=False)
        checks.append('ordinary memory and native tools available before workflow')
        for kind in ['project_prompt', 'document_insight']:
            start = len(p.REQUESTS)
            args.update(sessionId=kind+'-'+uuid.uuid4().hex, workflow=kind)
            result, seen = p.call(process, events, 'run', args); frames += seen
            assert result.get('completed') and 'resource-proof-42' in result['final_response'], result
            ready = next(x for x in seen if x.get('event') == 'ready')
            assert ready['tools'] == ['archive_probe'] and not ready['memoryEnabled'], ready
            raw = json.dumps(p.REQUESTS[start:], ensure_ascii=False)
            assert canary not in raw, 'long-term memory leaked to restricted workflow'
            state, _ = p.call(process, events, 'session', {'id':result['sessionId']})
            assert any(m['role']=='tool' and 'resource-proof-42' in str(m['content']) for m in state['messages'])
            checks.append(kind+': exact tools, no memory content, persisted native session')
            if kind == 'document_insight':
                assert all(r.get('max_tokens', r.get('max_completion_tokens')) == 2200 for r in p.REQUESTS[start:])
        args.pop('workflow'); args['sessionId']='ordinary-after-'+uuid.uuid4().hex
        result, seen = p.call(process, events, 'run', args); frames += seen
        ready = next(x for x in seen if x.get('event') == 'ready')
        assert ready['memoryEnabled'] and 'memory' in ready['tools']
        memory, _ = p.call(process, events, 'memory')
        assert canary in memory['user']
        checks.append('ordinary tools restored and memory unchanged after both workflows')
        (p.OUT/'result.json').write_text(json.dumps({'status':'passed','checks':checks,'requests':len(p.REQUESTS),'profile':str(p.PROFILE)},ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'status':'passed','checks':checks},ensure_ascii=False))
    finally:
        (p.OUT/'events.json').write_text(json.dumps(frames,ensure_ascii=False,indent=2),encoding='utf8')
        (p.OUT/'requests.json').write_text(json.dumps(p.REQUESTS,ensure_ascii=False,indent=2),encoding='utf8')
        p.close(process,log);server.shutdown()

if __name__ == '__main__':
    main()
