"""Administrator-selected DSH bundles; never accept install specs from chat."""
import json
import base64
import hashlib
import io
import tarfile
import urllib.request
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time


_DOWNLOAD_STATES = {}
_DOWNLOAD_STATES_LOCK = threading.Lock()
DOWNLOAD_RETRY_SECONDS = 30
_PREPARED = {}
_PREPARED_LOCK = threading.Lock()
_INSTALL_STATES = {}


def validate_plugins(value):
    if not isinstance(value, list) or len(value) > 8:
        raise ValueError('dshPlugins must be an array of at most 8 entries')
    seen = set()
    for entry in value:
        if not isinstance(entry, dict) or set(entry) != {'name', 'version'}:
            raise ValueError('DSH plugin requires only name and version')
        name, version = entry['name'], entry['version']
        if not isinstance(name, str) or not re.fullmatch(r'(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*', name) or len(name) > 214:
            raise ValueError('DSH plugin requires an exact npm package name')
        if not isinstance(version, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?', version):
            raise ValueError('DSH plugin requires a pinned version')
        if name in seen or name in ('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'):
            raise ValueError('duplicate or protected DSH plugin')
        seen.add(name)
    return value



def reviewed_archive(data, integrity):
    if 'sha512-' + base64.b64encode(hashlib.sha512(data).digest()).decode() != integrity:
        raise ValueError('reviewed DSH plugin integrity mismatch')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        seen, total = set(), 0
        for member in archive.getmembers():
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] != 'package' or not (member.isfile() or member.isdir()):
                raise ValueError('unsafe reviewed DSH plugin archive')
            if path in seen or len(seen) >= 4096:
                raise ValueError('duplicate or excessive reviewed archive entries')
            seen.add(path)
            total += member.size
            if total > 16 * 1024 * 1024:
                raise ValueError('reviewed archive expanded size too large')
        manifest = json.load(archive.extractfile('package/package.json'))
        if manifest.get('dependencies') or manifest.get('optionalDependencies'):
            raise ValueError('reviewed plugin must not introduce unreviewed runtime dependencies')
        scripts = manifest.get('scripts', {})
        if any(name in scripts for name in ('preinstall', 'install', 'postinstall', 'prepare')):
            raise ValueError('reviewed plugin must not require install scripts')


def reviewed_download(reviewed, cache=None):
    """Coalesce host prefetch and worker downloads for the same reviewed bytes."""
    if cache is None:
        return _reviewed_download(reviewed)
    key = (str(Path(cache).absolute()), reviewed['integrity'])
    with _DOWNLOAD_STATES_LOCK:
        state = _DOWNLOAD_STATES.setdefault(key, {'lock': threading.Lock(), 'retry_after': 0})
    with state['lock']:
        # Still revalidate cached bytes on every call, including during cooldown.
        return _reviewed_download(reviewed, cache, state)


def _reviewed_download(reviewed, cache=None, state=None):
    """Cache only reviewed archives, and verify bytes again on every use."""
    target = None
    if cache is not None:
        directory = Path(cache) / 'reviewed-archives'
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / (hashlib.sha256(reviewed['integrity'].encode()).hexdigest() + '.tgz')
        if target.is_file() and not target.is_symlink():
            with target.open('rb') as source:
                data = source.read(2 * 1024 * 1024 + 1)
            if len(data) <= 2 * 1024 * 1024:
                try:
                    reviewed_archive(data, reviewed['integrity'])
                    return data
                except (ValueError, tarfile.TarError, KeyError, TypeError):
                    pass
    if state is not None and time.monotonic() < state['retry_after']:
        raise RuntimeError('reviewed DSH plugin download is cooling down')
    try:
        with urllib.request.urlopen(reviewed['tarball'], timeout=20) as response:
            data = response.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('reviewed DSH plugin archive too large')
        reviewed_archive(data, reviewed['integrity'])
    except Exception:
        if state is not None:
            state['retry_after'] = time.monotonic() + DOWNLOAD_RETRY_SECONDS
        raise
    if state is not None:
        state['retry_after'] = 0
    if target is not None:
        # Separate workers may prepare the same package concurrently. Publish
        # complete verified bytes atomically; never write through a cache link.
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(data)
            temporary.replace(target)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return data


def plugin_specs(home, plugins, cache=None):
    catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
    specs = []
    for index, item in enumerate(plugins):
        spec = f"{item['name']}@{item['version']}"
        reviewed = catalog.get(spec)
        if reviewed is None:
            if any(key.rsplit('@', 1)[0] == item['name'] for key in catalog):
                raise ValueError('DSH plugin version has not been reviewed')
            specs.append(spec)
            continue
        data = reviewed_download(reviewed, cache)
        target = Path(home) / f'.approved-plugin-{index}.tgz'
        # The prior worker may have left a link. Never follow it when staging.
        target.unlink(missing_ok=True)
        with target.open('xb') as output:
            output.write(data)
        specs.append(str(target.resolve()))
    return specs

def prepared_key(runtime, plugins, catalog):
    if not plugins or any(f"{item['name']}@{item['version']}" not in catalog for item in plugins):
        return None
    info = Path(runtime).stat()
    return (str(Path(runtime).resolve()), info.st_size, info.st_mtime_ns,
            tuple((item['name'], item['version'], catalog[f"{item['name']}@{item['version']}"]['integrity']) for item in plugins))


def restore_prepared_plugins(runtime, home, plugins):
    catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
    key = prepared_key(runtime, plugins, catalog)
    with _PREPARED_LOCK:
        archives = _PREPARED.get(key)
    if archives is None:
        return False
    # Only immutable verified archives cross sessions, never installed directories.
    with tempfile.TemporaryDirectory(prefix='.plugin-stage-', dir=home) as staging:
        profile = Path(staging) / 'sdk'
        for item, data in zip(plugins, archives):
            reviewed = catalog[f"{item['name']}@{item['version']}"]
            reviewed_archive(data, reviewed['integrity'])
            package = profile / 'node_modules' / item['name']
            package.mkdir(parents=True)
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                for member in archive.getmembers():
                    target = package.joinpath(*Path(member.name).parts[1:])
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    else:
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open('xb') as output:
                            output.write(archive.extractfile(member).read())
                        target.chmod(0o600 | (member.mode & 0o111))
        (profile / 'package.json').write_text(json.dumps({'name': 'agentlink-reviewed-profile', 'private': True,
            'dependencies': {item['name']: item['version'] for item in plugins},
            'dsh': {'profile': {'bundles': ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app', *[item['name'] for item in plugins]], 'patchReload': 'startup'}}}))
        Path(staging).rename(Path(home) / 'profiles')
    return True


def warm_reviewed_plugins(plugins, cache, runtime=None):
    """Prepare reviewed bundles in the host; never execute them or share a home."""
    validate_plugins(plugins)
    catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
    results = {}
    for item in plugins:
        spec = f"{item['name']}@{item['version']}"
        reviewed = catalog.get(spec)
        if reviewed is None:
            continue
        try:
            reviewed_download(reviewed, cache)
            results[spec] = 'ready'
        except Exception:
            # Foreground preparation can retry; do not expose network errors.
            results[spec] = 'failed'
    if runtime is not None and plugins and all(results.get(f"{item['name']}@{item['version']}") == 'ready' for item in plugins):
        try:
            # Native CLI remains the authority for SDK compatibility checks.
            with tempfile.TemporaryDirectory(prefix='native-review-', dir=cache) as home:
                prepare_plugins(runtime, home, 'sdk', plugins, dict(web=True, files=True, terminal=True), package_manager_cache=cache)
        except Exception:
            return {spec: 'failed' for spec in results}
    return results


def clear_plugin_profiles(home):
    profiles = Path(home) / 'profiles'
    if profiles.is_symlink():
        profiles.unlink()
    elif profiles.exists():
        shutil.rmtree(profiles)


def prepare_plugins(runtime, home, profile, plugins, capabilities, package_manager_cache=None):
    """Use the native CLI; extension code is admitted only to full owner workers.

    Installation never runs package lifecycle scripts or receives model keys.
    The invocation policy patch still disables the unrestricted plugin manager.
    """
    validate_plugins(plugins)
    # Skipping installation alone leaves the native SDK loading old bundles.
    clear_plugin_profiles(home)
    if not plugins or not all(capabilities.get(key) is True for key in ('web', 'files', 'terminal')):
        return []
    if profile != 'sdk':
        raise ValueError('DSH whitelist plugins require the sdk profile')
    catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
    key = prepared_key(runtime, plugins, catalog)
    if key is None:
        return _install_plugins(runtime, home, profile, plugins, package_manager_cache)
    with _PREPARED_LOCK:
        state = _INSTALL_STATES.setdefault(key, {'lock': threading.Lock(), 'retry_after': 0})
    with state['lock']:
        if restore_prepared_plugins(runtime, home, plugins):
            return [item['name'] for item in plugins]
        if time.monotonic() < state['retry_after']:
            raise RuntimeError('reviewed DSH plugin installation is cooling down')
        try:
            result = _install_plugins(runtime, home, profile, plugins, package_manager_cache)
            archives = tuple(reviewed_download(catalog[f"{item['name']}@{item['version']}"], package_manager_cache) for item in plugins)
            current_catalog = json.loads(Path(__file__).with_name('plugin_catalog.json').read_text())
            if prepared_key(runtime, plugins, current_catalog) != key:
                raise RuntimeError('DSH plugin preparation inputs changed')
            with _PREPARED_LOCK:
                _PREPARED[key] = archives
            state['retry_after'] = 0
            return result
        except Exception:
            state['retry_after'] = time.monotonic() + DOWNLOAD_RETRY_SECONDS
            clear_plugin_profiles(home)
            raise


def _install_plugins(runtime, home, profile, plugins, package_manager_cache):
    profile_dir = Path(home) / 'profiles' / profile
    # Never reuse executable state that a preceding worker could have changed.
    profiles = Path(home) / 'profiles'
    env = {key: os.environ[key] for key in ('PATH', 'LANG', 'TMPDIR') if key in os.environ}
    env.update({'HOME': str(home), 'DSH_HOME': str(home), 'CI': 'true', 'COREPACK_ENABLE_DOWNLOAD_PROMPT': '0', 'COREPACK_DEFAULT_TO_LATEST': '0', 'npm_config_ignore_scripts': 'true'})
    env['npm_config_registry'] = 'https://registry.npmjs.org'
    if package_manager_cache is not None:
        env['COREPACK_HOME'] = str(package_manager_cache)
    specs = plugin_specs(home, plugins, cache=package_manager_cache)
    command = [str(runtime), 'plugin', '--profile', profile, 'add', '--save-exact', '--ignore-scripts',
               *specs]
    process = subprocess.Popen(command, cwd=str(home), env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        if process.wait(timeout=60) != 0:
            raise RuntimeError('DSH whitelist plugin installation failed')
        manifest_path = profile_dir / 'package.json'
        manifest = json.loads(manifest_path.read_text())
        bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app']
        for item in plugins:
            package = json.loads((profile_dir / 'node_modules' / item['name'] / 'package.json').read_text())
            if package.get('name') != item['name'] or package.get('version') != item['version'] or not package.get('dsh', {}).get('bundle'):
                raise RuntimeError('DSH whitelist package is not the pinned bundle')
            bundles.append(item['name'])
        manifest.setdefault('dsh', {}).setdefault('profile', {})['bundles'] = bundles
        manifest['dsh']['profile']['patchReload'] = 'startup'
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        return [item['name'] for item in plugins]
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        if profiles.exists():
            shutil.rmtree(profiles)
        raise
