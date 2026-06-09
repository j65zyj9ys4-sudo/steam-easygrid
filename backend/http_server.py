#!/usr/bin/env python3
"""
Easy SteamGrid animated hero server.
Self-daemonizes so Lua can call it without nohup/& and it runs in background.
Sends proper cache headers so Chromium caches APNGs for fast repeat navigation.
"""
import http.server
import sys
import os
import signal

PID_FILE = '/tmp/sgdb_httpserver.pid'
LOG_FILE = '/tmp/sgdb_httpserver.log'


def kill_previous():
    if os.path.exists(PID_FILE):
        try:
            with open(PID_FILE) as f:
                pid = int(f.read().strip())
            os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError, ProcessLookupError):
            pass
        try:
            os.remove(PID_FILE)
        except OSError:
            pass


def daemonize():
    """Double-fork to create a proper UNIX daemon."""
    try:
        if os.fork() > 0:
            os._exit(0)
    except OSError:
        pass

    os.setsid()

    try:
        if os.fork() > 0:
            os._exit(0)
    except OSError:
        pass

    sys.stdout.flush()
    sys.stderr.flush()
    log = open(LOG_FILE, 'w')
    os.dup2(log.fileno(), sys.stdout.fileno())
    os.dup2(log.fileno(), sys.stderr.fileno())
    devnull = open('/dev/null', 'r')
    os.dup2(devnull.fileno(), sys.stdin.fileno())

    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))


class APNGHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        # Cache for 7 days — filename hash changes if image changes,
        # so stale cache is never an issue
        self.send_header('Cache-Control', 'public, max-age=604800')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # Silent


if __name__ == '__main__':
    cache_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    port = int(sys.argv[2]) if len(sys.argv) > 2 else 27331

    kill_previous()
    daemonize()

    os.chdir(cache_dir)
    print(f'sgdb_http: serving {cache_dir} on 127.0.0.1:{port}', flush=True)

    try:
        server = http.server.HTTPServer(('127.0.0.1', port), APNGHandler)
        server.serve_forever()
    except Exception as e:
        print(f'sgdb_http error: {e}', flush=True)
