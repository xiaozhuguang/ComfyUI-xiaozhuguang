"""Serialize direct model operations started by VNCCS widgets."""

import threading


MODEL_OPERATION_LOCK = threading.RLock()
