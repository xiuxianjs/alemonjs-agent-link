"""Pinned DSH image tool runner. Receives only one media request on stdin."""
import base64
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from deepseek_harness import DeepSeekHarness
from deepseek_harness_runtime import bundled_runtime_path
from sandbox_profile import macos_profile, linux_bwrap_command

VERSION = '0.10.0'
ENTRY_HASH = '46668b96850641b8904b1bf5079f04dfd3b9be230bcc9914e349b4233da8dd21'

def package_entry(cache):
    entry = cache / 'profiles/sdk/node_modules/dsh-image-gen/lib/index.js'
    if hashlib.sha256(entry.read_bytes()).hexdigest() != ENTRY_HASH:
        raise ValueError('plugin integrity mismatch')
    return entry

def install(cache):
    cache.mkdir(parents=True, exist_ok=True)
    try:
        package_entry(cache)
        return
    except (OSError, ValueError):
        pass
    env = {'HOME': str(cache), 'DSH_HOME': str(cache), 'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
           'CI': 'true', 'npm_config_ignore_scripts': 'true', 'npm_config_registry': 'https://registry.npmjs.org',
           'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0'}
    subprocess.run([str(bundled_runtime_path()), 'plugin', '--profile', 'sdk', 'add', '--save-exact',
                    '--ignore-scripts', 'dsh-image-gen@' + VERSION], cwd=cache, env=env,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180, check=True)
    package_entry(cache)

class ToolModel(BaseHTTPRequestHandler):
    requested = False
    result = None
    prompt = ''
    def log_message(self, *_args):
        pass
    def do_POST(self):
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 24 * 1024 * 1024:
            self.send_error(413)
            return
        body = json.loads(self.rfile.read(size))
        for message in body.get('messages', []):
            for block in message.get('content', []) if isinstance(message.get('content'), list) else []:
                if block.get('type') == 'tool_result' and block.get('tool_use_id') == 'image-request':
                    ToolModel.result = block
        use_tool = not ToolModel.requested
        ToolModel.requested = True
        events = [
            ('message_start', {'message': {'id': 'image-runner', 'type': 'message', 'role': 'assistant', 'model': 'deepseek-flash', 'content': [], 'usage': {'input_tokens': 0, 'output_tokens': 0}}}),
            ('content_block_start', {'index': 0, 'content_block': {'type': 'tool_use', 'id': 'image-request', 'name': 'generate_image', 'input': {}} if use_tool else {'type': 'text', 'text': ''}}),
            ('content_block_delta', {'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': json.dumps({'prompt': ToolModel.prompt})} if use_tool else {'type': 'text_delta', 'text': 'complete'}}),
            ('content_block_stop', {'index': 0}),
            ('message_delta', {'delta': {'stop_reason': 'tool_use' if use_tool else 'end_turn'}, 'usage': {'output_tokens': 0}}),
            ('message_stop', {})]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for name, data in events:
            self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps({'type': name, **data}) + '\n\n').encode())

def attachment(home, result, limit):
    if not result or result.get('is_error'):
        raise ValueError('plugin generation failed')
    text = '\n'.join(b.get('text', '') for b in result.get('content', []) if b.get('type') == 'text')
    ids = set(re.findall(r'Attachment ID: sha256:([a-f0-9]{64})', text))
    if len(ids) != 1:
        raise ValueError('missing unique image attachment')
    digest = ids.pop()
    path = home / 'attachments/v1/objects' / digest[:2] / digest
    if path.is_symlink() or path.resolve().parent != (home / 'attachments/v1/objects' / digest[:2]).resolve():
        raise ValueError('unsafe attachment')
    if not path.resolve().is_relative_to(home.resolve()) or not 0 < path.stat().st_size <= limit:
        raise ValueError('invalid attachment size')
    data = path.read_bytes()
    if len(data) > limit or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('invalid attachment hash')
    return data

def generate(cache, home, request):
    entry = package_entry(cache)
    profile_dir = home / 'profiles/sdk'
    plugin = profile_dir / 'node_modules/dsh-image-gen'
    (plugin / 'lib').mkdir(parents=True)
    shutil.copyfile(entry, plugin / 'lib/index.js')
    (plugin / 'package.json').write_text(json.dumps({'name': 'dsh-image-gen', 'version': VERSION,
        'type': 'module', 'main': 'lib/index.js', 'dsh': {'bundle': {'patch': './cordis.patch.yml'}}}))
    (plugin / 'cordis.patch.yml').write_text('- insert:\n    - id: image-gen\n      name: dsh-image-gen\n')
    (profile_dir / 'package.json').write_text(json.dumps({'name': 'agentlink-image-profile', 'private': True,
        'dependencies': {'dsh-image-gen': VERSION},
        'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', 'dsh-image-gen']}}}))
    work = home / 'work'
    work.mkdir()
    server = ThreadingHTTPServer(('127.0.0.1', 0), ToolModel)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    provider = request['provider']
    ToolModel.prompt = request['prompt']
    ToolModel.requested, ToolModel.result = False, None
    config = {'provider': 'openai-compat', 'openaiCompatBaseURL': provider['baseUrl'],
              'openaiCompatModel': provider['model'], 'saveToWorkspace': False,
              'cloudTimeoutMs': request['timeoutMs'], 'openaiCompatSizes': {provider['model']: {'1:1': provider['size']}}}
    keyref = 'DSH_IMAGE_GEN_OPENAI_COMPAT_KEY'
    if provider['baseUrl'].rstrip('/') == 'https://open.bigmodel.cn/api/paas/v4':
        config.update(provider='zhipu', zhipuBaseURL=provider['baseUrl'], zhipuModel=provider['model'])
        keyref = 'ZHIPUAI_API_KEY'
    patch = home / 'media.yml'
    # No chat, shell, file, browser or subagent tools are needed for this call.
    source = Path(__file__).with_name('chat_only.patch.yml').read_text()
    patch.write_text(source + '\n- id: image-gen\n  config: ' + json.dumps(config) + '\n')
    runtime = Path(bundled_runtime_path())
    launch = [str(runtime), '--profile', 'sdk', '--patch', str(patch)]
    if platform.system() == 'Darwin':
        profile = macos_profile(work, home, runtime, Path(sys.prefix), Path(__file__), patch, server.server_port, allow_web=True)
        launch = ['/usr/bin/sandbox-exec', '-p', profile, *launch]
    elif platform.system() == 'Linux' and shutil.which('bwrap'):
        prefix = linux_bwrap_command(shutil.which('bwrap'), work, home, runtime, Path(sys.prefix), Path(__file__), patch, Path(sys.executable))
        launch = prefix[:-2] + launch
    else:
        raise ValueError('media sandbox unavailable')
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update({'HOME': str(home), 'DSH_HOME': str(home), 'TMPDIR': str(home), 'PATH': saved.get('PATH', '/usr/bin:/bin')})
    try:
        with DeepSeekHarness(env={keyref: provider['apiKey']}, _launch_args=tuple(launch), dsh_home=str(home), cwd=str(work),
                             dsh_bin=str(runtime), api_key='local-tool-dispatch', base_url=f'http://127.0.0.1:{server.server_port}',
                             request_timeout_seconds=request['timeoutMs'] / 1000 + 10) as harness:
            harness.start_session().run('Execute the image generation request once.')
        return attachment(home, ToolModel.result, request['maxBytes'])
    finally:
        os.environ.clear()
        os.environ.update(saved)
        server.shutdown()
        server.server_close()
        thread.join()

if __name__ == '__main__':
    try:
        mode, cache = sys.argv[1], Path(sys.argv[2]).resolve()
        if mode == 'check':
            pass
        elif mode == 'check-installed':
            package_entry(cache)
        elif mode == 'install':
            install(cache)
        elif mode == 'generate':
            payload = json.loads(sys.stdin.buffer.read(32769))
            data = generate(cache, Path(sys.argv[3]).resolve(), payload)
            print(json.dumps({'data': base64.b64encode(data).decode()}))
        else:
            raise ValueError('unknown mode')
    except Exception:
        # Provider exceptions can echo credentials or prompts. Never forward them.
        print('DSH image generation did not complete.', file=sys.stderr)
        sys.exit(1)
