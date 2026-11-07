"""Exercise the real bundled Hermes against an isolated OpenAI-compatible server."""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/archive-assistant-2026-11-05/protocol'
OUT.mkdir(parents=True, exist_ok=True)
PROFILE = OUT / ('profile-' + uuid.uuid4().hex[:10])
REQUESTS = []


class Model(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self.send_response(404); self.end_headers(); return
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if 'messages' not in body:
            self.send_response(404); self.end_headers(); return
        REQUESTS.append(body)
        messages = body['messages']
        user = next((m.get('content', '') for m in reversed(messages) if m['role'] == 'user'), '')
        has_result = any(m['role'] == 'tool' and 'resource-proof-42' in str(m.get('content')) for m in messages)
        tool = None
        if not has_result:
            offered = {t['function']['name'] for t in body.get('tools', [])}
            tool = {'id': 'call-proof', 'type': 'function', 'function': {'name': 'archive_probe', 'arguments': '{}'}}
            if 'archive_probe' not in offered:
                tool['function'] = {'name': 'tool_call', 'arguments': json.dumps({'calls':[{'name':'archive_probe','arguments':{}}]})}
        answer = '已找到归档证据 resource-proof-42。' if has_result else ''
        if '续接' in str(user) and has_result:
            answer = '续接成功：此前工具返回 resource-proof-42，原始历史仍在。'
        self.send_response(200)
        if body.get('stream'):
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            if tool:
                deltas = [{'tool_calls':[{'index':0, **tool}]}]
            else:
                deltas = [{'content':answer[:7]},{'content':answer[7:]}]
            for delta in deltas:
                self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','model':'baoyi-fixture','choices':[{'index':0,'delta':delta,'finish_reason':None}]},ensure_ascii=False)+'\n\n').encode())
                self.wfile.flush()
            self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'tool_calls' if tool else 'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}})+'\n\ndata: [DONE]\n\n').encode())
        else:
            self.send_header('Content-Type','application/json');self.end_headers()
            self.wfile.write(json.dumps({'id':'fixture','choices':[{'index':0,'message':{'role':'assistant','content':answer,**({'tool_calls':[tool]} if tool else {})},'finish_reason':'tool_calls' if tool else 'stop'}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}},ensure_ascii=False).encode())


def launch():
    log = (OUT / 'stderr.log').open('a', encoding='utf8')
    process = subprocess.Popen([str(ROOT/'output/hermes-runtime/python/python.exe'), '-X','utf8','-u',str(ROOT/'resources/hermes/bridge.py'),str(PROFILE),str(ROOT/'output/hermes-runtime')], stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True,encoding='utf8',cwd=ROOT,env={**os.environ,'BAOYI_HERMES_DIAGNOSTICS':'1'})
    events = queue.Queue()
    def read():
        for line in process.stdout:
            try:events.put(json.loads(line))
            except ValueError:events.put({'unparsed':line})
    threading.Thread(target=read,daemon=True).start()
    return process,events,log


def write(process,value):
    process.stdin.write(json.dumps(value,ensure_ascii=False)+'\n');process.stdin.flush()


def call(process,events,method,args=None):
    request_id = uuid.uuid4().hex
    write(process,{'id':request_id,'method':method,'args':args or {}})
    seen=[];deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        frame=events.get(timeout=max(.1,deadline-time.monotonic()))
        seen.append(frame)
        if frame.get('type')=='host_tool':
            assert frame['name']=='archive_probe',frame
            write(process,{'type':'tool_result','id':frame['id'],'result':json.dumps({'evidence':'resource-proof-42','source':'isolated fixture'})})
        if frame.get('type')=='response' and frame['id']==request_id:
            assert not frame.get('error'),frame
            return frame.get('value'),seen
    raise TimeoutError(method)


def close(process,log):
    process.stdin.close()
    try:process.wait(timeout=15)
    except subprocess.TimeoutExpired:process.kill();process.wait()
    log.close()


def main():
    server=ThreadingHTTPServer(('127.0.0.1',0),Model)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    process,events,log=launch();checks=[];frames=[]
    try:
        assert events.get(timeout=90)['type']=='ready'
        args={'sessionId':'baoyi-protocol','text':'查找隔离归档证据','config':{'model':'baoyi-fixture','api_url':f'http://127.0.0.1:{server.server_port}/v1','api_key':'fixture-only'},'system':'用 archive_probe 查询本地证据。只报告工具返回的事实。','maxIterations':6,'tools':[{'name':'archive_probe','description':'查询本地归档证据','parameters':{'type':'object','properties':{},'additionalProperties':False}}]}
        result,seen=call(process,events,'run',args);frames+=seen
        assert result.get('completed') and 'resource-proof-42' in result['final_response'],result
        assert any(x.get('event')=='delta' for x in seen),seen
        assert any(x.get('type')=='host_tool' for x in seen),seen
        checks+=['real Hermes tool bridge and streaming']
        state,_=call(process,events,'session',{'id':result['sessionId']})
        assert any(m['role']=='tool' and 'resource-proof-42' in str(m['content']) for m in state['messages'])
        checks+=['native Hermes session persistence']
        memory,_=call(process,events,'memory_edit',{'target':'user','action':'add','content':'归档保留所有不同版本。'})
        assert '归档保留所有不同版本。' in memory['user']
        checks+=['native memory edit']
        close(process,log);process,events,log=launch()
        assert events.get(timeout=90)['type']=='ready'
        memory,_=call(process,events,'memory')
        assert '归档保留所有不同版本。' in memory['user']
        args['sessionId']=result['sessionId'];args['text']='续接上次归档查询'
        args['config']['api_url'] += '/chat/completions/'
        result,seen=call(process,events,'run',args);frames+=seen
        assert '续接成功' in result['final_response'],result
        checks+=['cold restart restores memory and original tool conversation; full completion URL is normalized']
        (OUT/'result.json').write_text(json.dumps({'status':'passed','checks':checks,'requests':len(REQUESTS),'profile':str(PROFILE)},ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps({'status':'passed','checks':checks},ensure_ascii=False))
    finally:
        (OUT/'events.json').write_text(json.dumps(frames,ensure_ascii=False,indent=2),encoding='utf8')
        (OUT/'requests.json').write_text(json.dumps(REQUESTS,ensure_ascii=False,indent=2),encoding='utf8')
        close(process,log);server.shutdown()


if __name__=='__main__':main()
