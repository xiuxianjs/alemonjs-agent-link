"""Build platform-specific sandbox launchers for an isolated group worker."""
import sys
from pathlib import Path

def macos_profile(workspace: Path, dsh_home: Path, runtime: Path, python_root: Path, worker_script: Path, chat_only_patch: Path, proxy_port: int, allow_web: bool = False) -> str:
    """Return a deny-by-default profile for one worker.

    Keep the worker program itself explicit: it lives alongside the bridge and
    must not cause us to grant the worker read access to the whole plugin tree.
    """
    writable = [workspace.resolve(), dsh_home.resolve()]
    readonly = [runtime.resolve().parent, python_root.resolve(), Path(sys.base_prefix).resolve(), Path('/System'), Path('/usr'), Path('/opt/homebrew')]
    python_runtime = Path(sys.executable).resolve().parents[1]
    write_rules = "\n".join(f'(allow file-read* file-write* (subpath "{path}"))' for path in writable)
    read_rules = "\n".join(f'(allow file-read* (subpath "{path}"))' for path in readonly)
    metadata_paths = [Path(sys.executable).resolve(), runtime.resolve(), worker_script.resolve(), chat_only_patch.resolve(), *writable, *readonly]
    metadata_rules = "\n".join(f'(allow file-read-metadata file-test-existence (path-ancestors "{path}"))' for path in metadata_paths)
    return f'''(version 1)
(import "system.sb")
(deny default)
(allow process-fork)
(allow signal (target children))
(allow process-exec (subpath "{python_runtime}"))
(allow process-exec (subpath "{runtime.resolve().parent}"))
(allow file-read* (literal "{worker_script.resolve()}"))
(allow file-read* (literal "{chat_only_patch.resolve()}"))
; Attachment storage opens ancestor directories when verifying its safe path.
; Literal ancestors grant directory traversal, not reads of sibling files.
(allow file-read-data (path-ancestors "{dsh_home.resolve()}"))
(allow network-outbound (remote tcp "localhost:{proxy_port}"))
{'(allow network-outbound)' if allow_web else ''}
(allow file-read* file-write* (subpath "/dev"))
{write_rules}
{read_rules}
{metadata_rules}
'''


def linux_bwrap_command(
    bwrap: str,
    workspace: Path,
    dsh_home: Path,
    runtime: Path,
    python_root: Path,
    worker_script: Path,
    chat_only_patch: Path,
    python_executable: Path,
) -> list[str]:
    """Return a Bubblewrap command with only runtime and group paths mounted.

    Linux's Bubblewrap cannot express a loopback-only egress rule while the
    Worker needs to reach the parent Bridge over loopback. Network filtering is
    therefore left to the host/container policy; this launcher confines files,
    processes, IPC, UTS, and the Worker filesystem namespace.
    """
    workspace, dsh_home = workspace.resolve(), dsh_home.resolve()
    runtime, python_root = runtime.resolve(), python_root.resolve()
    worker_script, chat_only_patch = worker_script.resolve(), chat_only_patch.resolve()
    python_executable = python_executable.resolve()

    command = [
        bwrap,
        '--die-with-parent', '--new-session',
        '--unshare-user-try', '--unshare-pid', '--unshare-ipc', '--unshare-uts',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    ]
    # Dynamic loader files and the system interpreter live under these standard
    # locations. Everything else from the host root remains absent.
    for path in ('/usr', '/usr/local', '/bin', '/lib', '/lib64'):
        if Path(path).exists():
            command.extend(('--ro-bind', path, path))
    for path in ('/etc/ld.so.cache', '/etc/ld.so.conf', '/etc/ld.so.conf.d', '/etc/alternatives', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf', '/etc/ssl'):
        if Path(path).exists():
            command.extend(('--ro-bind', path, path))
    # bwrap creates destination parents for bind mounts. Bind the virtualenv
    # rather than its parent so the Worker cannot inspect plugin data.
    # A managed venv points outside itself to its base interpreter and stdlib.
    # Expose only that installation, never the parent plugin data directory.
    for path in dict.fromkeys((python_root, Path(sys.base_prefix).resolve(), runtime.parent, worker_script, chat_only_patch)):
        command.extend(('--ro-bind', str(path), str(path)))
    for path in (workspace, dsh_home):
        command.extend(('--bind', str(path), str(path)))
    command.extend(('--chdir', str(workspace), '--', str(python_executable), str(worker_script)))
    return command
