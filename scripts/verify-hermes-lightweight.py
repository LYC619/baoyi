"""Real Hermes requests against a local model fixture, no paid/external model."""
import importlib.util
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import uuid

spec = importlib.util.spec_from_file_location('protocol', Path(__file__).with_name('verify-hermes-runtime.py'))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
p.OUT = p.ROOT / 'output/feedback-round3-2026-11-07/hermes-lightweight'
p.OUT.mkdir(parents=True, exist_ok=True)
p.PROFILE = p.OUT / ('profile-' + uuid.uuid4().hex[:10])
requests = []

class Model(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'messages' not in body:
            self.send_response(404); self.end_headers(); return
        requests.append(body)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if body.get('stream'):
            for delta, finish in [({'content':'合成回答'},None), ({},'stop')]:
                self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','choices':[{'index':0,'delta':delta,'finish_reason':finish}]})+'\n\n').encode()); self.wfile.flush()
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({'id':'fixture','choices':[{'index':0,'message':{'role':'assistant','content':'合成回答'},'finish_reason':'stop'}]}).encode())

def main():
    server = ThreadingHTTPServer(('127.0.0.1',0), Model)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    process, events, log = p.launch()
    checks, metrics = [], []
    args = {'sessionId':'light-'+uuid.uuid4().hex,'text':'你好','mode':'chat','tools':[], 'system':'用中文简洁回答日常问题。', 'maxIterations':3,
            'config':{'model':'fixture','api_url':f'http://127.0.0.1:{server.server_port}/v1','api_key':'fixture-only'}}
    def turn(mode, reused):
        result, seen = p.call(process, events, 'run', args)
        ready = next(x for x in seen if x.get('event')=='ready')
        assert result.get('completed'), result
        assert ready['mode']==mode and ready['reused']==reused, ready
        assert any(x.get('event')=='delta' for x in seen)
        body = requests[-1]
        system = '\n'.join(str(m.get('content','')) for m in body['messages'] if m['role']=='system')
        metrics.append({'mode':mode,'reused':reused,'tools':len(ready['tools']),'systemChars':len(system),'requestBytes':len(json.dumps(body,ensure_ascii=False).encode()),'setupMs':ready['elapsedMs']})
        return ready, body, system
    try:
        assert events.get(timeout=90)['type']=='ready'
        ready, body, system = turn('chat',False)
        assert ready['tools']==[] and not body.get('tools') and len(system)<500, (ready,system)
        checks.append('lightweight real request has zero tools and short system prompt')
        args['text']='今天适合散步吗'
        ready, body, system = turn('chat',True)
        assert len([m for m in body['messages'] if m['role']=='user'])==2
        state,_=p.call(process, events, 'session', {'id':args['sessionId']})
        assert len([m for m in state['messages'] if m['role']=='user'])==2, state
        checks.append('same-session reuse preserves exactly one copy of each native message')
        args.update(mode='archive',text='读取资料',system='使用归档工具完成任务。',tools=[{'name':'archive_probe','description':'读取合成资料','parameters':{'type':'object','properties':{}}}])
        ready,body,system=turn('archive',False)
        assert {'archive_probe','memory'}.issubset(set(ready['tools'])) and len(system)>500, ready
        checks.append('chat to task restores native tool, memory and full prompt capabilities')
        args['text']='继续处理'
        turn('archive',True)
        checks.append('ordinary task agent also reused')
        p.call(process,events,'memory_edit',{'target':'user','action':'add','content':'测试记忆轻量化边界'})
        ready,body,system=turn('archive',False)
        assert '测试记忆轻量化边界' in system
        checks.append('memory edit invalidates cache and takes effect')
        args.update(mode='chat',text='谢谢',system='用中文简洁回答日常问题。',tools=[])
        ready,body,system=turn('chat',False)
        assert not body.get('tools') and len(system)<500
        checks.append('task to chat removes persisted full prompt and schemas')
        args['config']['model']='fixture-other'
        turn('chat',False)
        checks.append('model change invalidates cached agent')
        args['sessionId']='other-'+uuid.uuid4().hex
        ready,body,system=turn('chat',False)
        assert len([m for m in body['messages'] if m['role']=='user'])==1
        checks.append('different session never inherits conversation history')
        (p.OUT/'result.json').write_text(json.dumps({'checks':checks,'metrics':metrics,'boundary':'Real bundled Hermes; local synthetic model, no public TTFT measurement.'},ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'passed':len(checks),'metrics':metrics},ensure_ascii=False))
    finally:
        p.close(process,log);server.shutdown()

if __name__=='__main__':main()
