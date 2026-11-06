#!/usr/bin/env python3
"""Record actual fixed checks on an exact-head clean review worktree.
An existing independent approved review report is required; this script does not review code.
Never point this at installed sources: requires an explicit disposable review worktree.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
import runpy
from pathlib import Path
import re
import subprocess
import sys


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def asset(path):
    return {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['repository', 'pr', 'patch', 'worktree', 'gh', 'pnpm', 'review-report', 'reviewer', 'author', 'output-dir']:
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--review-approved', action='store_true', required=True, help='Explicit operator assertion that the supplied independent review approved this exact candidate')
    parser.add_argument('--review-completed-at', required=True, help='Actual ISO timestamp of the independent review, not recording time')
    parser.add_argument('--limitation', action='append', default=[])
    parser.add_argument('--baseline-report')
    parser.add_argument('--baseline-sha256', help='Reviewed immutable SHA-256, required with baseline report')
    parser.add_argument('--baseline-head')
    parser.add_argument('--baseline-root')
    args = parser.parse_args()
    if args.baseline_report and (not args.baseline_sha256 or not re.fullmatch('[a-f0-9]{64}', args.baseline_sha256) or not args.baseline_head or not re.fullmatch('[a-f0-9]{40}', args.baseline_head)):
        raise RuntimeError('Baseline requires reviewed report hash and exact tested commit')
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository) or not args.pr.isdecimal() or int(args.pr) < 1 or args.author == args.reviewer:
        raise RuntimeError('Invalid candidate or independent reviewer identity')
    worktree = Path(args.worktree).resolve(strict=True)
    # A linked disposable git worktree has a .git FILE, unlike installed primary checkout.
    if not (worktree / '.git').is_file():
        raise RuntimeError('Use a dedicated linked git review worktree, never an installed primary checkout')
    if subprocess.check_output(['git', 'status', '--porcelain'], cwd=worktree, text=True).strip():
        raise RuntimeError('Exact-head review worktree must be clean')
    gh = Path(args.gh).resolve(strict=True)
    pnpm = Path(args.pnpm).resolve(strict=True)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=worktree, text=True).strip()
    remote = json.loads(subprocess.check_output([str(gh), 'pr', 'view', args.pr, '--repo', args.repository, '--json', 'headRefOid'], text=True, timeout=90))
    if remote['headRefOid'] != head:
        raise RuntimeError('Review worktree is not the actual current PR head')
    review = Path(args.review_report).resolve(strict=True)
    patch = Path(args.patch).resolve(strict=True)
    completed = datetime.fromisoformat(args.review_completed_at.replace('Z', '+00:00'))
    age = datetime.now(timezone.utc) - completed
    if age.total_seconds() < -1 or age.total_seconds() > 86400:
        raise RuntimeError('Independent review timestamp must be actual and at most 24h old')
    if not review.read_bytes():
        raise RuntimeError('Independent review report must not be empty')
    review_asset, patch_asset = asset(review), asset(patch)
    output = Path(args.output_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    baseline = None
    if args.baseline_report:
        baseline = Path(args.baseline_report).resolve(strict=True)
        if asset(baseline)['sha256'] != args.baseline_sha256:
            raise RuntimeError('Reviewed baseline digest changed')
        args.limitation.append('Exact known-failure baseline ' + args.baseline_sha256 + ' tested at ' + args.baseline_head + '; not a fully passing suite')
    checks = []
    for name, argument in [('typecheck', 'typecheck'), ('tests', 'test'), ('build', 'build')]:
        report = output / (name + '.log')
        command = [str(pnpm), argument]
        environment = dict(os.environ)
        if name == 'tests' and baseline:
            json_report, errors = output / 'vitest-results.json', output / 'vitest-errors.json'
            reporter = Path(__file__).resolve().parent / 'errors-reporter.cjs'
            command = [str(pnpm), 'exec', 'vitest', 'run', '--cache=false', '--reporter=default', '--reporter=json', '--reporter=' + str(reporter), '--outputFile=' + str(json_report)]
            environment['PUBLICATION_ERRORS_REPORT'] = str(errors)
        with report.open('wb') as stream:
            result = subprocess.run(command, cwd=worktree, env=environment, stdout=stream, stderr=subprocess.STDOUT, timeout=900)
        exit_code, check_name = result.returncode, 'pnpm ' + argument
        if name == 'tests' and baseline:
            compare = runpy.run_path(str(Path(__file__).resolve().parent / 'baseline.py'))['compare_reports']
            if asset(baseline)['sha256'] != args.baseline_sha256:
                raise RuntimeError('Reviewed baseline changed during test run')
            summary = compare(json.loads(baseline.read_text()), json.loads(json_report.read_text()), args.baseline_root or str(worktree), str(worktree), exit_code, json.loads(errors.read_text()))
            with report.open('a') as stream:
                stream.write('\nEXACT BASELINE COMPARATOR: ' + json.dumps(dict(summary, rawExitCode=exit_code, baselineHead=args.baseline_head, baselineSha256=args.baseline_sha256)) + '\n')
            exit_code, check_name = 0, 'pnpm exec vitest + exact pinned baseline comparator'
            for label, artifact in [('complete Vitest report', json_report), ('zero unhandled Vitest errors', errors)]:
                checks.append({'name': label, 'exitCode': 0, 'completedAt': now(), 'report': asset(artifact)})
        checks.append({'name': check_name, 'exitCode': exit_code, 'completedAt': now(), 'report': asset(report)})
        if exit_code:
            raise RuntimeError('Check failed; actual report retained, no approved attestation generated: ' + str(report))
    # A build tool changing tracked sources invalidates exact-head evidence.
    if subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=worktree, text=True).strip():
        raise RuntimeError('Checks changed tracked sources; evidence invalidated')
    if json.loads(subprocess.check_output([str(gh), 'pr', 'view', args.pr, '--repo', args.repository, '--json', 'headRefOid'], text=True, timeout=90))['headRefOid'] != head:
        raise RuntimeError('GitHub head changed during checks; evidence invalidated')
    if subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=worktree, text=True).strip() != head or asset(review) != review_asset or asset(patch) != patch_asset:
        raise RuntimeError('Worktree head, patch or independent review changed during checks')
    document = {'version': 1, 'pins': {'repository': args.repository, 'prNumber': int(args.pr), 'headSha': head, 'patchSha256': patch_asset['sha256']},
                'author': args.author, 'reviewer': {'name': args.reviewer, 'role': 'independent'},
                'review': {'verdict': 'approved', 'completedAt': args.review_completed_at, 'report': review_asset}, 'checks': checks, 'limitations': args.limitation}
    destination = output / 'local-evidence.json'
    destination.write_text(json.dumps(document, indent=2) + '\n')
    print(str(destination))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('STOP: ' + str(error), file=sys.stderr)
        sys.exit(1)
