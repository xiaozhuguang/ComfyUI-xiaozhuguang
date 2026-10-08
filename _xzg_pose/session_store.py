"""Bounded, process-local preview cache. Never required to reproduce node output."""
import secrets
import threading
from collections import OrderedDict

_sessions = OrderedDict()
_lock = threading.Lock()
MAX_SESSIONS = 4


def put(frames, images, fps, source_digest):
    token = secrets.token_urlsafe(24)
    with _lock:
        _sessions[token] = {'frames': frames, 'images': images, 'fps': fps, 'source_digest': source_digest}
        while len(_sessions) > MAX_SESSIONS:
            _sessions.popitem(last=False)
    return token


def get(token):
    with _lock:
        result = _sessions.get(token)
        if result is not None:
            _sessions.move_to_end(token)
        return result
