#!/bin/bash
set -euo pipefail
[[ $# == 0 ]] || exit 64
exec /usr/bin/python3 ./publication-runner.py rollback
