"""JSON-lines host for the unmodified Hermes AIAgent library.

Hermes owns model requests, streaming, context compression, native messages,
session storage, memory, skills and task lists. BaoYi supplies archive tools.
"""
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import os
import shutil
from pathlib import Path
import sys
import threading
import time
import uuid

PROTOCOL = sys.stdout
sys.stdout = sys.stderr
WRITE_LOCK = threading.Lock()
PENDING = {}
PENDING_LOCK = threading.Lock()
ACTIVE = None
ACTIVE_SESSION = ''
CANCELLED = threading.Event()
DB = None
CACHED_AGENT = None
CACHED_KEY = None
HOME_DIR = Path(sys.argv[1]).resolve()
RUNTIME = Path(sys.argv[2]).resolve()
HOME_DIR.mkdir(parents=True, exist_ok=True)
os.chdir(HOME_DIR)
os.environ['HERMES_HOME'] = str(HOME_DIR)
os.environ['PYTHONUTF8'] = '1'
sys.path.insert(0, str(RUNTIME / 'hermes'))
logging.basicConfig(level=logging.WARNING)
if os.environ.get('BAOYI_HERMES_DIAGNOSTICS'):
    import faulthandler
    faulthandler.dump_traceback_later(30, repeat=True)


def emit(value):
    with WRITE_LOCK:
        PROTOCOL.write(json.dumps(value, ensure_ascii=False, default=str) + '\n')
        PROTOCOL.flush()


def reply(request_id, value=None, error=None):
    emit({'type': 'response', 'id': request_id, **({'error': error} if error else {'value': value})})


def archive_call(name, arguments, **kwargs):
    call_id = str(uuid.uuid4())
    pending = {'event': threading.Event()}
    with PENDING_LOCK:
        PENDING[call_id] = pending
    emit({'type': 'host_tool', 'id': call_id, 'sessionId': ACTIVE_SESSION, 'name': name, 'args': arguments})
    try:
        while not pending['event'].wait(.2):
            # A native move/copy may already be committing. Wait for its real
            # result before ending the turn, including when the user stops it.
            if ACTIVE is None:
                return json.dumps({'error': '任务已停止'})
        return pending['value']
    finally:
        with PENDING_LOCK:
            PENDING.pop(call_id, None)


def event(kind, **payload):
    emit({'type': 'event', 'sessionId': ACTIVE_SESSION, 'event': kind, **payload})


def summarize_session(row):
    return {key: row.get(key) for key in ['id', 'title', 'started_at', 'last_active', 'model', 'message_count', 'input_tokens', 'output_tokens', 'ended_at', 'end_reason', 'parent_session_id']}


def messages(session_id):
    return [{key: row.get(key) for key in ['id', 'role', 'content', 'tool_calls', 'tool_call_id', 'tool_name', 'timestamp', 'display_kind', 'display_metadata']}
            for row in DB.get_messages(session_id, include_compacted=True, include_ancestors=True)]


def automatic_title(session_id, text):
    # Use Hermes' own collision handling and title provenance (derived < manual).
    from agent.title_generator import _persist_session_title
    return _persist_session_title(DB, session_id, text[:45], source='derived')


def run_turn(request):
    global ACTIVE, ACTIVE_SESSION, CACHED_AGENT, CACHED_KEY
    started = time.monotonic()
    args = request['args']
    session_id = args['sessionId']
    ACTIVE_SESSION = session_id
    agent = None
    summary = None
    failure = None
    workflow = args.get('workflow')
    try:
        from run_agent import AIAgent
        from tools.registry import registry
        if workflow not in (None, 'project_prompt', 'document_insight'):
            raise ValueError('未知限定工作流')
        light = not workflow and args.get('mode') == 'chat'
        toolset = 'baoyi_' + workflow if workflow else 'baoyi'
        for spec in args['tools']:
            name = spec['name']
            registry.register(name=name, toolset=toolset, schema=spec,
                              handler=lambda arguments, _name=name, **kw: archive_call(_name, arguments, **kw),
                              max_result_size_chars=30000, execution_timeout=300, override=True)
        config = args['config']
        base_url = config['api_url'].strip().rstrip('/').removesuffix('/chat/completions')
        history = DB.get_messages_as_conversation(session_id, include_ancestors=True) if DB.get_session(session_id) and not workflow else []
        key = json.dumps([session_id, config, workflow, light, args['tools'], args['system']], sort_keys=True, ensure_ascii=False)
        reused = bool(not workflow and CACHED_AGENT is not None and CACHED_KEY == key)
        if not reused and CACHED_AGENT is not None:
            CACHED_AGENT.close()
            CACHED_AGENT = None
            CACHED_KEY = None
        # Host adapter only: upstream Hermes remains unchanged. Simple chat uses
        # the same streaming/session engine with a bounded prompt and zero tools.
        class ChatAgent(AIAgent):
            def _build_system_prompt(self, system_message=None):
                return args['system']
        agent = CACHED_AGENT if reused else (ChatAgent if light else AIAgent)(
            model=config['model'], api_key=config['api_key'], base_url=base_url,
            provider='custom', api_mode='chat_completions',
            enabled_toolsets=[] if light else [toolset] if workflow else ['baoyi', 'memory', 'todo', 'session_search', 'skills'],
            skip_memory=bool(workflow) or light,
            quiet_mode=True, skip_context_files=True, skip_background_review=True,
            session_db=DB, session_id=session_id, max_iterations=args.get('maxIterations', 100),
            max_tokens=2200 if workflow == 'document_insight' else None,
            ephemeral_system_prompt=None if light else args['system'], cwd=str(HOME_DIR),
            stream_delta_callback=lambda text: event('delta', text=text) if text else None,
            tool_start_callback=lambda call_id, name, arguments: event('tool_start', callId=call_id, name=name, args=arguments),
            tool_complete_callback=lambda call_id, name, arguments, result: event('tool_end', callId=call_id, name=name, args=arguments, result=result),
            step_callback=lambda index, previous: event('step', index=index),
            status_callback=lambda *values, **kw: event('status', text=' '.join(str(v) for v in values)),
            event_callback=lambda name, data: event('runtime', name=name, data=data),
        )
        if workflow and agent.valid_tool_names != {spec['name'] for spec in args['tools']}:
            raise RuntimeError('限定工作流的工具范围不一致')
        if light:
            if agent.valid_tool_names:
                raise RuntimeError('轻量会话工具范围不一致')
            # A prior full turn may have persisted its prompt in the session DB.
            agent._cached_system_prompt = args['system']
            agent._cached_system_prompt_static = args['system']
        elif not reused:
            # Rebuild the native task prompt when returning from lightweight chat.
            agent._cached_system_prompt = agent._build_system_prompt()
        if workflow == 'document_insight':
            # Hermes owns retry classification and Retry-After handling. Keep the
            # archive batch to one attempt plus two retries, without its recovery ladder.
            agent._api_max_retries = 3
            agent._auto_recovery_cycles = 0
        if not workflow:
            CACHED_AGENT, CACHED_KEY = agent, key
        ACTIVE = agent
        if CANCELLED.is_set():
            raise InterruptedError('任务已停止')
        event('ready', engine='Hermes v0.22.7', workflow=workflow, mode='chat' if light else 'archive', reused=reused, toolSchemaBytes=len(json.dumps(args['tools'],ensure_ascii=False).encode()), tools=sorted(agent.valid_tool_names), memoryEnabled=agent._memory_enabled, elapsedMs=round((time.monotonic()-started)*1000))
        result = agent.run_conversation(args['text'], conversation_history=history, task_id=session_id)
        final_id = agent.session_id
        if not DB.get_session_title(final_id):
            automatic_title(final_id, args['text'])
        summary = {key: result.get(key) for key in ['final_response', 'completed', 'failed', 'interrupted', 'error', 'api_calls', 'partial']}
        summary.update(sessionId=final_id, inputTokens=agent.session_prompt_tokens, outputTokens=agent.session_completion_tokens,
                       elapsedMs=round((time.monotonic()-started)*1000))
    except Exception as exc:
        logging.exception('Hermes turn failed')
        failure = str(exc)
    finally:
        if agent and (workflow or failure or CANCELLED.is_set() or summary and (summary.get('failed') or summary.get('interrupted'))):
            agent.close()
            if CACHED_AGENT is agent:
                CACHED_AGENT = None
                CACHED_KEY = None
        ACTIVE = None
        ACTIVE_SESSION = ''
    reply(request['id'], summary, failure)


def command(request):
    global CACHED_AGENT, CACHED_KEY
    args = request.get('args', {})
    method = request['method']
    if method == 'insight_budget':
        from agent.model_metadata import get_model_context_length, estimate_tokens_rough
        config = args['config']
        context = get_model_context_length(config['model'], base_url=config['api_url'].strip().rstrip('/').removesuffix('/chat/completions'), api_key=config['api_key'], provider='custom')
        # Reserve message framing and the bounded response separately. This is
        # Hermes' CJK/UTF-8 estimate, not a character count presented as tokens.
        used = estimate_tokens_rough(args['text']) + 2500
        return {'contextTokens': context, 'estimatedTokens': used, 'inputLimit': int(context * .6), 'estimated': True}
    if method == 'status':
        return {'engine': 'Hermes v0.22.7', 'sessionId': ACTIVE_SESSION}
    if method == 'sessions':
        return [summarize_session(row) for row in DB.list_sessions_rich(limit=100, order_by_last_active=True, search_query=args.get('query'))]
    if method == 'session':
        row = DB.get_session(args['id'])
        return {'session': summarize_session(row), 'messages': messages(args['id'])} if row else None
    if method == 'ensure_session':
        if not DB.get_session(args['id']):
            DB.create_session(args['id'], source='baoyi')
            automatic_title(args['id'], args['title'])
            DB.append_message(args['id'], 'user', args['text'], timestamp=args['timestamp'])
        return True
    if method == 'rename':
        return DB.set_session_title(args['id'], args['title'])
    if method == 'archive':
        return DB.set_session_archived(args['id'], args.get('archived', True))
    if method == 'cancel':
        CANCELLED.set()
        if ACTIVE:
            ACTIVE.interrupt(hard_cancel=True)
        return True
    if method == 'steer':
        # Hermes redirect interrupts only an in-flight model response and queues
        # a native user row; while a tool is committing it safely degrades to steer.
        return bool(ACTIVE and ACTIVE.redirect(args['text']))
    if method in ('memory', 'memory_edit'):
        from tools.memory_tool import load_on_disk_store
        store = load_on_disk_store()
        if method == 'memory_edit':
            if ACTIVE_SESSION:
                raise ValueError('请先停止当前任务，再修改记忆')
            if CACHED_AGENT is not None:
                CACHED_AGENT.close()
                CACHED_AGENT = None
                CACHED_KEY = None
            target, action = args['target'], args['action']
            if target not in ('memory', 'user') or action not in ('add', 'replace', 'remove'):
                raise ValueError('记忆操作无效')
            if action == 'add':
                result = store.add(target, args['content'])
            elif action == 'replace':
                result = store.replace(target, args['oldText'], args['content'])
            else:
                result = store.remove(target, args['oldText'])
            if not result.get('success'):
                raise ValueError(result.get('error', '记忆保存失败'))
        return {'memory': store.memory_entries, 'user': store.user_entries,
                'limits': {'memory': store.memory_char_limit, 'user': store.user_char_limit}}
    if method == 'skills':
        from tools.skills_tool import skills_list
        return json.loads(skills_list())
    raise ValueError('未知助手操作：' + method)


def main():
    global DB, ACTIVE_SESSION
    # Configure the embedded host before importing Hermes; its CLI defaults
    # otherwise infer a coding workspace and probe model catalogs on startup.
    (HOME_DIR / 'config.yaml').write_text('model:\n  context_length: 128000\nagent:\n  coding_context: "off"\ntools:\n  tool_search:\n    enabled: "off"\n  connectors:\n    enabled: false\nauxiliary:\n  title_generation:\n    model_upgrade_enabled: false\n', encoding='utf8')
    # Seed a real Hermes skill, once per scope; user improvements remain theirs.
    bundled = Path(__file__).parent / 'skills'
    for source in bundled.glob('*/SKILL.md'):
        target = HOME_DIR / 'skills' / source.parent.name / 'SKILL.md'
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    from run_agent import AIAgent
    from hermes_state import SessionDB
    DB = SessionDB(HOME_DIR / 'state.db')
    emit({'type': 'ready', 'engine': 'Hermes v0.22.7'})
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='baoyi-hermes')
    running = None
    try:
        for line in sys.stdin:
            request = json.loads(line)
            if os.environ.get('BAOYI_HERMES_DIAGNOSTICS'):
                print('bridge received', request.get('method', request.get('type')), file=sys.stderr, flush=True)
            if request.get('type') == 'tool_result':
                with PENDING_LOCK:
                    pending = PENDING.get(request['id'])
                    if pending:
                        pending['value'] = request['result']
                        pending['event'].set()
                continue
            if request['method'] == 'run':
                if ACTIVE_SESSION:
                    reply(request['id'], error='归档助理正在处理当前任务')
                else:
                    CANCELLED.clear()
                    ACTIVE_SESSION = request['args']['sessionId']
                    running = executor.submit(run_turn, request)
                continue
            try:
                reply(request['id'], command(request))
            except Exception as exc:
                reply(request['id'], error=str(exc))
    finally:
        if os.environ.get('BAOYI_HERMES_DIAGNOSTICS'):
            print('bridge stdin closed', file=sys.stderr, flush=True)
        if ACTIVE:
            ACTIVE.interrupt(hard_cancel=True)
        with PENDING_LOCK:
            for pending in PENDING.values():
                pending['value'] = json.dumps({'error':'应用已关闭'})
                pending['event'].set()
        executor.shutdown(wait=True, cancel_futures=True)
        if CACHED_AGENT is not None:
            CACHED_AGENT.close()
        DB.close()


if __name__ == '__main__':
    main()
