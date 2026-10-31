#!/usr/bin/env python3
"""One group-scoped DSH worker. It receives JSONL only from the loopback bridge."""
import json, os, sys, uuid, time
from pathlib import Path

WORKSPACE = Path(os.environ['DSH_WORKSPACE']).resolve()
DSH_HOME = Path(os.environ['DSH_HOME']).resolve()

def emit(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + '\n'); sys.stdout.flush()

def text_chunks(notification):
    if getattr(notification, 'method', None) != 'session.event': return []
    payload = getattr(notification, 'payload', None); event = payload.get('event') if isinstance(payload, dict) else None
    if not isinstance(event, dict) or event.get('type') != 'text-chunks': return []
    data = event.get('data'); texts = data.get('texts') if isinstance(data, dict) else None
    return [text for text in texts or [] if isinstance(text, str) and text]

def initialize_harness(harness):
    """Retry only initialization, before any user prompt or tool can run."""
    for attempt in range(2):
        try:
            harness.start()
            return
        except Exception:
            harness.close()
            if attempt == 1:
                raise

class PermissionVerificationError(Exception): pass

def verify_native_permissions(harness, session, nonce, preset, timeout=2):
    """rc2 has no permission read API; verify the trusted plugin's pre-prompt ack.

    The pinned SDK stderr buffer is private, deliberately isolated here. Missing
    or changed SDK internals fail closed rather than silently skipping the check.
    """
    session.get_working_directory()  # Materialize the agent without running a model.
    expected = [nonce, str(session.id), preset]
    deadline = time.monotonic() + timeout
    while True:
        for line in list(getattr(harness.client, '_stderr_lines', ())):
            if not line.startswith('AGENTLINK_PERMISSION '): continue
            try: value = json.loads(line[len('AGENTLINK_PERMISSION '):])
            except ValueError: continue
            if value == expected: return
        if time.monotonic() >= deadline:
            raise PermissionVerificationError('Native permission acknowledgement missing')
        time.sleep(0.01)

def execution_error_code(error):
    # Return constants only: exception text may contain prompts or credentials.
    if isinstance(error, PermissionVerificationError): return 'permission-verification'
    message = str(error).lower()
    if 'unsupported or malformed image' in message:
        return 'invalid-image'
    if 'eperm' in message or 'permission denied' in message:
        return 'sandbox-permission'
    return 'execution'

def main():
    try:
        from deepseek_harness import DeepSeekHarness
        from deepseek_harness_runtime import bundled_runtime_path
        runtime = str(bundled_runtime_path())
    except Exception as error:
        emit({'type': 'fatal', 'error': f'DSH runtime unavailable: {error}'}); return 2
    permission_nonce = uuid.uuid4().hex
    permission_preset = os.environ.get('DSH_PERMISSION_MODE', 'read-only')
    harness = DeepSeekHarness(env={'AGENTLINK_PERMISSION_NONCE': permission_nonce}, dsh_home=str(DSH_HOME), cwd=str(WORKSPACE), dsh_bin=runtime,
        profile=os.environ.get('DSH_PROFILE', 'sdk'), provider=os.environ.get('DSH_PROVIDER', 'deepseek-official'),
        model=os.environ.get('DSH_MODEL', 'deepseek-v4-flash'), api_key=os.environ['DSH_PROXY_TOKEN'],
        base_url=os.environ['DSH_PROXY_BASE_URL'], patches=(os.environ['DSH_CHAT_ONLY_PATCH'],),
        request_timeout_seconds=float(os.environ.get('DSH_WORKER_TIMEOUT_SECONDS', '115')))
    # Keep live sessions within one process. Framework turns restore native
    # session data and explicitly resume through the supported SDK API.
    # The epoch is owned by the bridge and stays stable during safe turn rotation.
    worker_epoch = os.environ.get('DSH_SESSION_EPOCH') or uuid.uuid4().hex
    sessions = {}
    # These events carry no request content and are consumed by the bridge only.
    # They make a timeout diagnosable without exposing worker stderr to logs.
    emit({'type': 'phase', 'phase': 'harness-initialize'})
    try:
        initialize_harness(harness)
    except Exception:
        emit({'type': 'fatal', 'error': 'DSH initialization failed', 'code': 'initialization'})
        return 2
    emit({'type': 'ready'})
    for line in sys.stdin:
        try:
            command = json.loads(line)
            if command['type'] == 'shutdown': break
            if command['type'] != 'chat': emit({'type': 'error', 'error': 'unsupported command'}); continue
            streamed = []
            def on_notification(notification):
                for text in text_chunks(notification): streamed.append(text); emit({'type': 'content', 'content': text})
            logical_session_id = command['sessionId']
            session = sessions.get(logical_session_id)
            if session is None:
                physical_session_id = f'{logical_session_id}:w{worker_epoch}'
                session = (harness.resume_session(physical_session_id) if command.get('resume') is True
                           else harness.start_session(physical_session_id))
                verify_native_permissions(harness, session, permission_nonce, permission_preset)
                sessions[logical_session_id] = session
            emit({'type': 'phase', 'phase': 'harness-run'})
            result = session.run(command['message'], on_notification=on_notification)
            emit({'type': 'result', 'content': result.final_response or ''.join(streamed), 'finish_reason': result.finish_reason, 'events': result.events})
        except Exception as error:
            # The bridge exposes only the stable error field. Detail is never
            # logged or returned to a chat client because it may include input.
            emit({'type': 'error', 'error': 'DSH worker execution failed', 'code': execution_error_code(error), 'detail': str(error)[-2000:]})
    harness.close(); return 0

if __name__ == '__main__': raise SystemExit(main())
