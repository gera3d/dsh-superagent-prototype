"""Exercise the real controller boundary without starting/stopping any service."""
import os
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

CONTROL = Path(__file__).resolve().parents[1] / 'scripts/dsh-superagent'
WATCH = 'DSH_SUPERAGENT_WATCHDOG'
ALLOW = 'DSH_SUPERAGENT_ALLOW_SELF_RESTART'

class RestartAuthority(unittest.TestCase):
    def invoke(self, flags, inside=True, human=False, action='restart'):
        module = runpy.run_path(str(CONTROL)); scope = module['main'].__globals__; effects = []
        def clean_effect(*args, **kwargs):
            self.assertNotIn(WATCH, os.environ); self.assertNotIn(ALLOW, os.environ)
            effects.append('effect'); return 0
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, flags, clear=True), patch.object(sys, 'argv', [str(CONTROL), action]), patch('os.isatty', return_value=human), patch.dict(scope, {'audit': lambda args: None, 'in_harness': lambda profile: (123, 'test host') if inside else None, 'control': lambda profile: Path(folder), 'stop': clean_effect, 'start': clean_effect, 'status': clean_effect}):
            scope['main']()
        return effects
    def test_unapproved_in_harness_restart_still_refused(self):
        with self.assertRaisesRegex(RuntimeError, 'Refusing'): self.invoke({})
    def test_watchdog_alone_cannot_grant_restart(self):
        with self.assertRaisesRegex(RuntimeError, 'Refusing'): self.invoke({WATCH:'1'})
    def test_allow_flag_alone_cannot_grant_restart(self):
        with self.assertRaisesRegex(RuntimeError, 'Refusing'): self.invoke({ALLOW:'1'})
    def test_exact_scoped_override_is_consumed_before_both_effects(self):
        self.assertEqual(self.invoke({WATCH:'1', ALLOW:'1'}), ['effect','effect'])
    def test_external_invocation_does_not_propagate_flags(self):
        self.assertEqual(self.invoke({WATCH:'1',ALLOW:'1'}, inside=False), ['effect','effect'])
    def test_existing_human_terminal_override_stays_supported(self):
        self.assertEqual(self.invoke({ALLOW:'1'}, human=True), ['effect','effect'])
    def test_status_does_not_leak_override_flags(self):
        self.assertEqual(self.invoke({WATCH:'1',ALLOW:'1'}, action='status'), ['effect'])

if __name__=='__main__': unittest.main()
