from __future__ import annotations

import fcntl
import os
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

LOCK=Path('/home/craft/.craft-agent/workspaces/my-workspace-2/campaigns/ops/.robinswood-flow-sellsy-sync.lock')
@contextmanager
def chain_lock() -> Generator[bool]:
    if os.environ.get('RBW_FLOW_CHAIN_LOCK_HELD')=='1':
        yield True
        return
    LOCK.parent.mkdir(parents=True,exist_ok=True);fh=LOCK.open('a+');acquired=False;previous=os.environ.get('RBW_FLOW_CHAIN_LOCK_HELD')
    try:
        try:
            fcntl.flock(fh.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB);acquired=True;os.environ['RBW_FLOW_CHAIN_LOCK_HELD']='1'
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        if acquired:
            if previous is None:_=os.environ.pop('RBW_FLOW_CHAIN_LOCK_HELD',None)
            else:os.environ['RBW_FLOW_CHAIN_LOCK_HELD']=previous
            try:fcntl.flock(fh.fileno(),fcntl.LOCK_UN)
            except OSError:pass
        fh.close()
