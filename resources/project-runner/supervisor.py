"""Windows Job owner. One JSON request on stdin; JSONL events on stdout.

The child is created suspended, assigned to a kill-on-close Job, then resumed.
No shell, inherited application credentials or persisted PID-based termination.
Uses the CPython Windows process primitive also used by subprocess itself.
"""
import base64
import ctypes
from ctypes import wintypes as w
import json
import msvcrt
import os
import subprocess
import sys
import threading
import time
import _winapi

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

class BasicLimit(ctypes.Structure):
    _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                ("flags", w.DWORD), ("min_working", ctypes.c_size_t), ("max_working", ctypes.c_size_t),
                ("active_limit", w.DWORD), ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]

class IoCounters(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

class ExtendedLimit(ctypes.Structure):
    _fields_ = [("basic", BasicLimit), ("io", IoCounters), ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t), ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

class Accounting(ctypes.Structure):
    _fields_ = [(name, ctypes.c_longlong) for name in ("user", "kernel", "period_user", "period_kernel")] + [
        (name, w.DWORD) for name in ("faults", "total", "active", "terminated")]

def signature(name, result, *args):
    fn = getattr(k32, name)
    fn.restype, fn.argtypes = result, args
    return fn

create_job = signature("CreateJobObjectW", w.HANDLE, ctypes.c_void_p, w.LPCWSTR)
set_job = signature("SetInformationJobObject", w.BOOL, w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD)
assign_job = signature("AssignProcessToJobObject", w.BOOL, w.HANDLE, w.HANDLE)
query_job = signature("QueryInformationJobObject", w.BOOL, w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p)
terminate_job = signature("TerminateJobObject", w.BOOL, w.HANDLE, w.UINT)
resume_thread = signature("ResumeThread", w.DWORD, w.HANDLE)
close_handle = signature("CloseHandle", w.BOOL, w.HANDLE)
attach_console = signature("AttachConsole", w.BOOL, w.DWORD)
free_console = signature("FreeConsole", w.BOOL)
send_break = signature("GenerateConsoleCtrlEvent", w.BOOL, w.DWORD, w.DWORD)
Handler = ctypes.WINFUNCTYPE(w.BOOL, w.DWORD)
set_handler = signature("SetConsoleCtrlHandler", w.BOOL, Handler, w.BOOL)
ignore_control = Handler(lambda event: True)

def check(ok):
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())

lock = threading.Lock()
parent_closed = threading.Event()
stopping = threading.Event()

def emit(event):
    try:
        with lock:
            print(json.dumps({"version": 1, **event}, ensure_ascii=True), flush=True)
    except (OSError, ValueError):
        parent_closed.set()

def controls():
    try:
        for line in sys.stdin:
            if json.loads(line).get("type") == "stop":
                stopping.set()
    except (ValueError, OSError):
        pass
    finally:
        parent_closed.set()

def output(handle):
    with os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb", buffering=0) as stream:
        while chunk := stream.read(8192):
            emit({"type": "output", "data": base64.b64encode(chunk).decode("ascii")})

def active_count(job):
    info = Accounting()
    check(query_job(job, 1, ctypes.byref(info), ctypes.sizeof(info), None))
    return info.active

def graceful_stop(job):
    # The hidden console belongs to this job; attach to a surviving member even
    # when the initial npm/node process has already exited.
    members = (ctypes.c_size_t * 1026)()
    if not query_job(job, 3, members, ctypes.sizeof(members), None):
        return False, "query-members", ctypes.get_last_error()
    header = ctypes.cast(members, ctypes.POINTER(w.DWORD))
    if not header[1]:
        return False, "no-members", 0
    pids = [str(ctypes.c_size_t.from_buffer(members, 8 + i * ctypes.sizeof(ctypes.c_size_t)).value) for i in range(min(header[1], 1024))]
    # Attaching/freeing a console resets control handlers and can close standard
    # handles. Use a short-lived signal helper so the Job owner retains its pipes.
    try:
        result = subprocess.run([sys.executable, "-I", "-S", __file__, "--signal", *pids], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.stderr:
            emit({"type": "diagnostic", "message": result.stderr.decode("utf-8", errors="replace")[:2000]})
        return result.returncode == 0, "console-break", result.returncode
    except subprocess.TimeoutExpired:
        return False, "console-break-timeout", 0

def signal_members():
    # Windows can list conhost before actual clients; find an attachable member.
    free_console()
    for value in sys.argv[2:]:
        if attach_console(int(value)):
            check(set_handler(ignore_control, True))
            check(send_break(1, 0))
            # Allow the asynchronous console callback to run before exit.
            time.sleep(0.2)
            return 0
    return 1

def main():
    sys.stdin.reconfigure(encoding="utf-8")
    request = json.loads(sys.stdin.readline(1024 * 1024))
    if request.get("version") != 1:
        raise ValueError("Unsupported runner request")
    command, args, cwd, env = (request[k] for k in ("command", "args", "cwd", "env"))
    if not os.path.isabs(command) or not command.lower().endswith(".exe") or not os.path.isabs(cwd):
        raise ValueError("Runner requires an absolute executable and working directory")
    job = create_job(None, None)
    check(job)
    process = thread = read_pipe = write_pipe = None
    reader = None
    try:
        limit = ExtendedLimit()
        limit.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        check(set_job(job, 9, ctypes.byref(limit), ctypes.sizeof(limit)))
        read_pipe, write_pipe = _winapi.CreatePipe(None, 0)
        os.set_handle_inheritable(write_pipe, True)
        with open(os.devnull, "rb") as null:
            input_handle = msvcrt.get_osfhandle(null.fileno())
            os.set_handle_inheritable(input_handle, True)
            startup = subprocess.STARTUPINFO()
            startup.dwFlags = subprocess.STARTF_USESTDHANDLES | subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = subprocess.SW_HIDE
            startup.hStdInput = input_handle
            startup.hStdOutput = startup.hStdError = write_pipe
            startup.lpAttributeList = {"handle_list": [input_handle, write_pipe]}
            flags = 0x4 | subprocess.CREATE_NEW_CONSOLE | 0x400 | 0x80000
            process, thread, pid, _ = _winapi.CreateProcess(command, subprocess.list2cmdline([command, *args]), None, None, True, flags, env, cwd, startup)
        # Assignment failure must never let unowned project code start.
        try:
            check(assign_job(job, process))
            if resume_thread(thread) == 0xFFFFFFFF:
                check(False)
        except BaseException:
            _winapi.TerminateProcess(process, 1)
            raise
        _winapi.CloseHandle(thread); thread = None
        _winapi.CloseHandle(write_pipe); write_pipe = None
        emit({"type": "started", "pid": pid})
        reader = threading.Thread(target=output, args=(read_pipe,), daemon=True)
        reader.start(); read_pipe = None
        threading.Thread(target=controls, daemon=True).start()
        deadline = None
        while active_count(job):
            if parent_closed.is_set():
                check(terminate_job(job, 1))
                break
            if stopping.is_set() and deadline is None:
                graceful, stage, winerror = graceful_stop(job)
                deadline = time.monotonic() + 5
                emit({"type": "stopping", "graceful": graceful, "stage": stage, "winerror": winerror})
            if deadline is not None and time.monotonic() >= deadline:
                check(terminate_job(job, 1))
                break
            time.sleep(0.05)
        _winapi.WaitForSingleObject(process, 5000)
        exit_code = _winapi.GetExitCodeProcess(process)
        close_handle(job); job = None
        if reader:
            reader.join(timeout=5)
        emit({"type": "exited", "code": exit_code, "stopped": stopping.is_set() or parent_closed.is_set()})
    finally:
        if job:
            close_handle(job)
        for handle in (thread, process, read_pipe, write_pipe):
            if handle:
                _winapi.CloseHandle(handle)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--signal":
        sys.exit(signal_members())
    try:
        main()
    except BaseException as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
