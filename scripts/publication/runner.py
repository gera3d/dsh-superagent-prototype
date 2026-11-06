#!/usr/bin/env python3
"""Conservative operator-only release phases. No request-supplied commands.
Run with release directory as cwd; pin this file, plan, wrappers and tools/scripts.
Only modifications/additions of regular UTF-8 patch paths are supported.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fail(message):
    raise RuntimeError(message)


def canonical(value, directory=False):
    p = Path(value)
    if not p.is_absolute() or p.resolve() != p or (not p.is_dir() if directory else not p.is_file()):
        fail('Expected canonical absolute ' + ('directory' if directory else 'file'))
    return p


def checked(item):
    if set(item) != {'path', 'sha256'} or not re.fullmatch('[a-f0-9]{64}', item['sha256']):
        fail('Invalid pinned asset')
    p = canonical(item['path'])
    data = p.read_bytes()
    if digest(data) != item['sha256']:
        fail('Pinned asset changed: ' + p.name)
    return p, data


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run(args, cwd):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def file_state(root, name):
    p = root / name
    # Resolve every path component: symlink aliases and directory targets refused.
    if p.resolve() != p or not p.is_relative_to(root):
        fail('Unsafe target path')
    if p.exists():
        if not p.is_file():
            fail('Target is not a regular file')
        return {'sha256': digest(p.read_bytes()), 'mode': p.stat().st_mode & 0o777}
    return None


def patch_names(data):
    # Reject binary/rename/delete/mode-only/quoted paths rather than guessing.
    text = data.decode('utf-8')
    # Git metadata is unprefixed and starts at column zero. Hunk source lines
    # begin with +, -, or space, so guard literals/documentation are not metadata.
    if re.search(r'^(?:GIT binary patch$|rename from |rename to |deleted file mode |old mode |new mode |Binary files )', text, re.M):
        fail('Unsupported patch kind; use a separately reviewed release adapter')
    old = re.findall(r'^--- (.+)$', text, re.M)
    new = re.findall(r'^\+\+\+ (.+)$', text, re.M)
    if not old or len(old) != len(new):
        fail('Missing unambiguous patch file headers')
    names = []
    for before, after in zip(old, new):
        if not after.startswith('b/') or (before != '/dev/null' and before != 'a/' + after[2:]):
            fail('Only -p1 modifications/additions are supported')
        name = after[2:]
        if not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*', name) or any(part in ('.', '..', '.git') for part in Path(name).parts):
            fail('Unsafe patch filename')
        names.append(name)
    if len(set(names)) != len(names):
        fail('Duplicate patch targets')
    return names


def declared_asset(path):
    assets = json.loads(os.environ.get('PUBLICATION_ASSET_SHA256', '{}'))
    p = canonical(str(path))
    if assets.get(str(p)) != digest(p.read_bytes()):
        fail('Required release dependency is not pinned: ' + p.name)
    return p


def load_plan():
    declared_asset(Path(__file__).resolve())
    plan_path = declared_asset(Path.cwd() / 'publication-plan.json')
    plan = json.loads(plan_path.read_text())
    required = {'version', 'repository', 'headSha', 'patchSha256', 'target', 'pnpmPath', 'restartScript', 'verifyUrl', 'verifyContains'}
    if not required.issubset(plan) or set(plan) - required - {'baselineReport'} or plan['version'] != 1:
        fail('Invalid publication plan schema')
    if 'baselineReport' in plan:
        baseline = plan['baselineReport']
        if not {'path', 'sha256', 'baselineHead'}.issubset(baseline) or set(baseline) - {'path', 'sha256', 'baselineHead', 'root'} or not re.fullmatch('[a-f0-9]{40}', baseline['baselineHead']):
            fail('Invalid immutable baseline metadata')
        checked({key: baseline[key] for key in ['path', 'sha256']})
        declared_asset(baseline['path'])
        declared_asset(Path.cwd() / 'publication-baseline.py')
        declared_asset(Path.cwd() / 'publication-errors-reporter.cjs')
    for key, env in [('repository', 'PUBLICATION_REPOSITORY'), ('headSha', 'PUBLICATION_HEAD_SHA'), ('patchSha256', 'PUBLICATION_PATCH_SHA256')]:
        if plan[key] != os.environ.get(env):
            fail('Plan differs from authorized publication binding')
    canonical(plan['target'], True)
    declared_asset(plan['pnpmPath'])
    declared_asset(plan['restartScript']['path'])
    if plan['headSha'] not in plan['verifyContains'] and plan['patchSha256'] not in plan['verifyContains']:
        fail('Verification marker must bind exact head or patch fingerprint')
    parsed = urllib.parse.urlparse(plan['verifyUrl'])
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.username or parsed.password or not plan['verifyContains']:
        fail('Verification must use explicit loopback HTTP URL and nonempty expected marker')
    return plan


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('apply', 'build', 'restart', 'verify', 'rollback'):
        fail('Expected one fixed publication phase')
    phase = sys.argv[1]
    if os.environ.get('PUBLICATION_STAGE') != phase:
        fail('Phase binding mismatch')
    operation = os.environ.get('PUBLICATION_OPERATION_ID', '')
    # Service IDs are <publication UUID>:<phase>; all phases share one release ledger.
    match = re.fullmatch(r'([a-f0-9-]{36}):(apply|build|restart|verify|rollback)', operation)
    if not match or match[2] != phase:
        fail('Expected durable service operation identity')
    plan = load_plan()
    root = canonical(plan['target'], True)
    ledger_dir = Path.cwd() / 'publication-ledgers' / match[1]
    ledger_path = ledger_dir / 'ledger.json'
    if ledger_dir.resolve() != ledger_dir:
        fail('Ledger symlink alias refused')

    def load():
        value = json.loads(ledger_path.read_text())
        if value['target'] != str(root) or value['headSha'] != plan['headSha'] or value['patchSha256'] != plan['patchSha256']:
            fail('Ledger binding mismatch')
        return value

    def build():
        run([plan['pnpmPath'], 'build'], root)
        if 'baselineReport' not in plan:
            run([plan['pnpmPath'], 'test'], root)
            return
        baseline = plan['baselineReport']
        report = ledger_dir / (phase + '-tests.json')
        errors = ledger_dir / (phase + '-errors.json')
        output = ledger_dir / (phase + '-test-output.log')
        reporter = Path.cwd() / 'publication-errors-reporter.cjs'
        with output.open('wb') as stream:
            result = subprocess.run([plan['pnpmPath'], 'exec', 'vitest', 'run', '--cache=false', '--reporter=default', '--reporter=json', '--reporter=' + str(reporter), '--outputFile=' + str(report)],
                                    cwd=root, env=dict(os.environ, PUBLICATION_ERRORS_REPORT=str(errors)), stdout=stream, stderr=subprocess.STDOUT)
        compare = runpy.run_path(str(Path.cwd() / 'publication-baseline.py'))['compare_reports']
        summary = compare(json.loads(Path(baseline['path']).read_text()), json.loads(report.read_text()), baseline.get('root', str(root)), str(root), result.returncode, json.loads(errors.read_text()))
        print(json.dumps(dict(summary, baselineHead=baseline['baselineHead'], baselineSha256=baseline['sha256'], fullLog=str(output))))

    def restart():
        script, _ = checked(plan['restartScript'])
        run([script, 'restart'], root)

    def verify():
        # No redirects: do not leave the configured loopback endpoint.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                fail('Verification redirect refused')
        opener = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))
        with opener.open(plan['verifyUrl'], timeout=10) as response:
            data = response.read(1048577)
            if response.status != 200 or len(data) > 1048576 or plan['verifyContains'].encode() not in data:
                fail('Expected publication verification marker absent')

    if phase == 'apply':
        if ledger_dir.exists():
            fail('Release ledger already exists; reconcile rather than replay apply')
        patch_path, patch = checked({'path': os.environ['PUBLICATION_PATCH_PATH'], 'sha256': plan['patchSha256']})
        names = patch_names(patch)
        before = {name: file_state(root, name) for name in names}
        run(['git', 'apply', '--check', '-p1', patch_path], root)
        # Model the exact patch on touched-file preimages before live mutation.
        with tempfile.TemporaryDirectory(prefix='publication-preflight-') as temporary:
            trial = Path(temporary).resolve()
            for name in names:
                if before[name]:
                    (trial / name).parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(root / name, trial / name)
            run(['git', 'apply', '--check', '-p1', patch_path], trial)
            run(['git', 'apply', '-p1', patch_path], trial)
            after = {name: file_state(trial, name) for name in names}
        ledger_dir.mkdir(parents=True)
        for name in names:
            if before[name]:
                backup = ledger_dir / 'preimages' / name
                backup.parent.mkdir(parents=True, exist_ok=True)
                with backup.open('wb') as stream:
                    stream.write((root / name).read_bytes())
                    stream.flush()
                    os.fsync(stream.fileno())
                if digest(backup.read_bytes()) != before[name]['sha256']:
                    fail('Target changed while capturing preimage')
        # Persist backup directory entries as well as file contents before write-ahead.
        backup_directories = [p for p in ledger_dir.rglob('*') if p.is_dir()]
        for directory in sorted(backup_directories, key=lambda p: len(p.parts), reverse=True) + [ledger_dir, ledger_dir.parent, Path.cwd()]:
            fd = os.open(directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
        ledger = {'target': str(root), 'headSha': plan['headSha'], 'patchSha256': plan['patchSha256'], 'before': before, 'after': after, 'stages': {'apply': 'running'}}
        save(ledger_path, ledger)  # Durable rollback preimages before first mutation.
        if any(file_state(root, name) != before[name] for name in names):
            fail('Target changed after preflight')
        # Capture verified patch bytes under the immutable ledger; avoid path replacement race.
        snapshot = ledger_dir / 'release.patch'
        snapshot.write_bytes(patch)
        run(['git', 'apply', '--check', '-p1', snapshot], root)
        run(['git', 'apply', '-p1', snapshot], root)
        if any(file_state(root, name) != after[name] for name in names):
            fail('Applied source differs from preflight; reconcile with ledger')
        ledger['stages']['apply'] = 'succeeded'
        save(ledger_path, ledger)
    elif phase == 'rollback':
        ledger = load()
        # Preflight every file before restoring any; never overwrite later local edits.
        for name in ledger['before']:
            if file_state(root, name) not in (ledger['before'][name], ledger['after'][name]):
                fail('Rollback would overwrite post-publication edits: ' + name)
            if ledger['before'][name]:
                backup = ledger_dir / 'preimages' / name
                if digest(backup.read_bytes()) != ledger['before'][name]['sha256']:
                    fail('Rollback preimage corrupted')
        ledger['stages']['rollback'] = 'running'
        save(ledger_path, ledger)
        for name, state in reversed(list(ledger['before'].items())):
            p = root / name
            if state:
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes((ledger_dir / 'preimages' / name).read_bytes())
                p.chmod(state['mode'])
            elif p.exists():
                p.unlink()  # Only this publication's exact verified newly added file.
        build()
        if 'restart' in ledger['stages']:
            restart()
            # Forward expected marker describes the new release, not the restored one.
            # Operator must independently verify restored GUI behavior/version.
        ledger['stages']['rollback'] = 'succeeded'
        save(ledger_path, ledger)
    else:
        ledger = load()
        predecessor = {'build': 'apply', 'restart': 'build', 'verify': 'restart'}[phase]
        if ledger['stages'].get(predecessor) != 'succeeded' or phase in ledger['stages']:
            fail('Phase prerequisite missing or replay refused')
        if any(file_state(root, name) != ledger['after'][name] for name in ledger['after']):
            fail('Published source changed since apply')
        ledger['stages'][phase] = 'running'
        save(ledger_path, ledger)
        {'build': build, 'restart': restart, 'verify': verify}[phase]()
        ledger['stages'][phase] = 'succeeded'
        save(ledger_path, ledger)
    print(phase + ' completed; operator GUI verification remains separate')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
