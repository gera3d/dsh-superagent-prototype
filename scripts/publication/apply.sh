#!/bin/bash
# Operator release cwd must contain pinned publication-runner.py and publication-plan.json.
set -euo pipefail
[[ $# == 0 ]] || exit 64
exec /usr/bin/python3 ./publication-runner.py apply
