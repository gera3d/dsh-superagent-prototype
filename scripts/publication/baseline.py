#!/usr/bin/env python3
"""Exact Vitest assertion-baseline gate. No count-only or name-only waivers."""
import hashlib
import json
from pathlib import Path
import re


def normalized_failure(messages, root):
    if not isinstance(messages, list) or not messages or any(not isinstance(value, str) or not value for value in messages):
        raise RuntimeError('Failed assertion lacks actual error messages')
    text = '\n'.join(messages).replace(str(Path(root).resolve()), '<ROOT>')
    text = re.sub(r'\x1b\[[0-9;]*m', '', text)
    return hashlib.sha256(text.encode()).hexdigest()


def assertions(report, root):
    if not isinstance(report, dict) or not isinstance(report.get('testResults'), list) or not report['testResults']:
        raise RuntimeError('Missing complete Vitest test report')
    root = Path(root).resolve()
    results = {}
    for suite in report['testResults']:
        name = suite.get('name')
        if not isinstance(name, str) or not isinstance(suite.get('assertionResults'), list):
            raise RuntimeError('Missing test suite identity/assertions')
        file = Path(name)
        file = file if file.is_absolute() else root / file
        try:
            relative = str(file.resolve().relative_to(root))
        except ValueError:
            raise RuntimeError('Test suite is outside recorded report root')
        failures = 0
        for test in suite['assertionResults']:
            status = test.get('status')
            full_name = test.get('fullName')
            if status not in ['passed', 'failed', 'pending', 'skipped', 'todo', 'disabled'] or not isinstance(full_name, str) or not full_name:
                raise RuntimeError('Incomplete/unnamed assertion')
            # Vitest can legitimately report repeated fullName values (parameterized
            # cases). Preserve ordinal identity and require unchanged multiplicity.
            occurrence = sum(key[:2] == (relative, full_name) for key in results)
            key = (relative, full_name, str(occurrence))
            error = normalized_failure(test.get('failureMessages'), root) if status == 'failed' else None
            results[key] = (status, error)
            failures += int(status == 'failed')
        if (suite.get('status') == 'failed' and not failures) or suite.get('message') or suite.get('failureMessage'):
            raise RuntimeError('Suite/collection error cannot be baselined')
    failed = sum(status == 'failed' for status, _ in results.values())
    passed = sum(status == 'passed' for status, _ in results.values())
    if not results or report.get('numTotalTests') != len(results) or report.get('numFailedTests') != failed or report.get('numPassedTests') != passed:
        raise RuntimeError('Incomplete/inconsistent Vitest assertion totals')
    if report.get('numRuntimeErrorTestSuites') or report.get('unhandledErrors') or report.get('errors') or report.get('snapshot', {}).get('failure'):
        raise RuntimeError('Runtime/unhandled/snapshot failures cannot be baselined')
    if report.get('success') is not (failed == 0):
        raise RuntimeError('Inconsistent Vitest success flag')
    return results


def compare_reports(baseline, current, baseline_root, current_root, exit_code, errors):
    if exit_code not in (0, 1) or not isinstance(errors, dict) or errors.get('reason') not in ['passed', 'failed'] or errors.get('unhandledErrors') != []:
        raise RuntimeError('Interrupted/unhandled Vitest run or invalid exit status')
    before = assertions(baseline, baseline_root)
    after = assertions(current, current_root)
    from collections import Counter
    old_counts, new_counts = Counter(key[:2] for key in before), Counter(key[:2] for key in after)
    for identity in old_counts.keys() | new_counts.keys():
        if max(old_counts[identity], new_counts[identity]) > 1 and old_counts[identity] != new_counts[identity]:
            raise RuntimeError('Ambiguous duplicate assertion multiplicity changed: ' + ' :: '.join(identity))
    failures = sum(status == 'failed' for status, _ in after.values())
    if exit_code != int(failures > 0):
        raise RuntimeError('Vitest exit status inconsistent with assertion report')
    for key, (status, message) in after.items():
        if status == 'failed' and before.get(key) != (status, message):
            raise RuntimeError('New/changed assertion failure: ' + ' :: '.join(key))
    for key, (status, _message) in before.items():
        if key not in after:
            raise RuntimeError('Previously recorded assertion missing: ' + ' :: '.join(key))
        if status == 'passed' and after[key][0] != 'passed':
            raise RuntimeError('Previously passed assertion regressed: ' + ' :: '.join(key))
        if status == 'failed' and after[key][0] not in ['failed', 'passed']:
            raise RuntimeError('Known failure was skipped instead of checked: ' + ' :: '.join(key))
    return {'knownFailures': failures, 'baselineNowPassing': sum(value[0] == 'failed' and after[key][0] == 'passed' for key, value in before.items()), 'total': len(after)}
