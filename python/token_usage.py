"""Shared durable token ledger; no credentials or response content are stored."""
import sqlite3
import os
from contextlib import contextmanager
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

def begin_usage(root, url, key):
    root.mkdir(parents=True, exist_ok=True)
    parsed = urlsplit(url)
    port = parsed.port
    origin = f'{parsed.scheme}://{parsed.hostname}' + (f':{port}' if port and not (parsed.scheme == 'https' and port == 443) else '')
    key_id = hashlib.sha256((origin + '\n' + key).encode()).hexdigest()
    day = datetime.now(timezone(timedelta(hours=8))).strftime('%Y-%m-%d')
    periods = [day, day[:7], day[:4], 'all']
    request_id = str(uuid.uuid4())
    path = root / 'token-usage.sqlite'
    @contextmanager
    def connect():
        db = sqlite3.connect(path, timeout=5)
        os.chmod(path, 0o600)
        db.execute('PRAGMA journal_mode=WAL')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()
    with connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS token_events(id TEXT PRIMARY KEY,key_id TEXT NOT NULL,day TEXT NOT NULL,known INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS token_totals(period TEXT NOT NULL,key_id TEXT NOT NULL,requests INTEGER NOT NULL DEFAULT 0,known INTEGER NOT NULL DEFAULT 0,input INTEGER NOT NULL DEFAULT 0,output INTEGER NOT NULL DEFAULT 0,cached INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(period,key_id));''')
        db.execute('INSERT INTO token_events(id,key_id,day) VALUES(?,?,?)',(request_id,key_id,day))
        for period in periods:
            for target in [key_id,'*']:
                db.execute('INSERT INTO token_totals(period,key_id,requests) VALUES(?,?,1) ON CONFLICT(period,key_id) DO UPDATE SET requests=requests+1',(period,target))
    def settle(usage):
        if not isinstance(usage, dict): return
        inp, out = usage.get('prompt_tokens'), usage.get('completion_tokens')
        if type(inp) is not int or type(out) is not int or min(inp,out)<0: return
        cached = usage.get('prompt_cache_hit_tokens', (usage.get('prompt_tokens_details') or {}).get('cached_tokens',0))
        cached = min(inp,cached) if type(cached) is int and cached>=0 else 0
        with connect() as db:
            changed = db.execute('UPDATE token_events SET known=1 WHERE id=? AND known=0',(request_id,)).rowcount
            if changed:
                for period in periods:
                    for target in [key_id,'*']:
                        db.execute('UPDATE token_totals SET known=known+1,input=input+?,output=output+?,cached=cached+? WHERE period=? AND key_id=?',(inp,out,cached,period,target))
    return settle

def extract_tokens(data):
    import json
    if not data: return None
    text = data.decode('utf-8', 'replace')
    try: payloads = [json.loads(text)]
    except ValueError:
        payloads = []
        for line in text.splitlines():
            if line.startswith('data:'):
                try: payloads.append(json.loads(line[5:].strip()))
                except ValueError: pass
    combined = {}
    for payload in payloads:
        if not isinstance(payload, dict): continue
        usage = payload.get('usage') or (payload.get('message') or {}).get('usage')
        if isinstance(usage, dict): combined.update(usage)
    if 'prompt_tokens' in combined: return combined
    if 'input_tokens' in combined and 'output_tokens' in combined:
        return {'prompt_tokens': combined['input_tokens'] + (combined.get('cache_read_input_tokens') or 0) + (combined.get('cache_creation_input_tokens') or 0), 'completion_tokens': combined['output_tokens'], 'prompt_cache_hit_tokens': combined.get('cache_read_input_tokens',0)}
    return None
