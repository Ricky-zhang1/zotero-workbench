"""Offline integration tests for the vendored TextFold parser and ladder."""
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER_PATH = ROOT / 'scripts' / 'research-worker.py'


def load_worker(work_dir):
    old_argv = sys.argv
    sys.argv = [str(WORKER_PATH), str(work_dir)]
    try:
        spec = importlib.util.spec_from_file_location('zotero_research_worker_test', WORKER_PATH)
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        worker.WORK = Path(work_dir)
        return worker
    finally:
        sys.argv = old_argv


def payload():
    pages = [
        {'page': 1, 'text': 'Teacher supply responds to working conditions. Retention varies across districts.'},
        {'page': 2, 'text': 'Local salary policies shape recruitment decisions.\n\nRural districts face greater hiring constraints.'},
    ]
    return {
        'kind': 'fold', 'title': 'Synthetic teacher workforce study', 'library': 'user',
        'itemKey': 'PAPER001', 'attachmentKey': 'PDF00001', 'sha256': 'a' * 64,
        'pages': pages
    }


class ResearchWorkerTests(unittest.TestCase):
    def fake_model(self, worker, *, fail_unit_calls=(), omit_unit_calls=(), omit_units_by_call=None,
                   empty_takeaway_by_call=None, omit_on_retry=False,
                   wrong_retry_id=False, invalid_retry_evidence=False, overview_pages=None):
        state = {'overview': 0, 'units': 0, 'retries': 0}
        omit_units_by_call = omit_units_by_call or {}
        empty_takeaway_by_call = empty_takeaway_by_call or {}

        def ask(prompt, schema, system=''):
            properties = schema.get('properties', {})
            if 'pagesRead' in properties:
                state['overview'] += 1
                return {
                    'overview': 'Teacher supply depends on working conditions and local labor markets.',
                    'argument': 'The two pages connect retention and recruitment to district conditions.',
                    'limitations': 'The synthetic document contains text only.',
                    'pagesRead': overview_pages if overview_pages is not None else [1, 2]
                }

            state['units'] += 1
            is_retry = '本页上一轮有单元未获得完整的AI折叠' in prompt
            if is_retry:
                state['retries'] += 1
            if state['units'] in fail_unit_calls:
                raise RuntimeError('private fake model diagnostic')
            if state['units'] in omit_unit_calls or (is_retry and omit_on_retry):
                return {'section': {'takeaway': '', 'topic': ''}, 'units': []}
            ids = [int(number) for number in re.findall(r'^\[U(\d+)\]', prompt, re.MULTILINE)]
            self.assertTrue(ids, 'TextFold should ask for at least one parsed unit')
            first = re.search(r'^\s*0:\s*(.+)$', prompt, re.MULTILINE)
            sentence = first.group(1).split('. ')[0].rstrip('.') if first else 'A supported finding'
            topic = ' '.join(sentence.split()[:2])
            response_ids = [f'U{number}' for number in ids]
            evidence = [0]
            if is_retry and wrong_retry_id:
                response_ids[0] = 'U99'
            if is_retry and invalid_retry_evidence:
                evidence = [999]
            omit_ids = omit_units_by_call.get(state['units'], set())
            empty_ids = empty_takeaway_by_call.get(state['units'], set())
            return {
                'section': {'takeaway': sentence, 'topic': topic},
                'units': [{
                    'id': response_ids[position], 'role': 'result',
                    'takeaway': '' if number in empty_ids else sentence,
                    'topic': topic, 'reason': 'District conditions shape retention and recruitment.',
                    'evidence': evidence
                } for position, number in enumerate(ids) if number not in omit_ids]
            }

        worker.ask = ask
        return state

    def test_make_fold_runs_real_parser_ladder_and_exports_all_five_levels(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-test-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker)
            with contextlib.redirect_stdout(io.StringIO()):
                result = worker.make_fold(payload())

            self.assertEqual(state, {'overview': 1, 'units': 2, 'retries': 0})
            self.assertEqual(result['format'], 'textfold/doc')
            self.assertEqual(result['levels'], ['topic', 'takeaway', 'key', 'brief', 'full'])
            self.assertEqual(result['written'], ['topic', 'takeaway', 'key'])
            self.assertEqual(result['coverage'], {'pages': 2, 'units': 3, 'allUnitsAI': True})
            self.assertEqual(result['provenance']['ai_generated'], True)
            self.assertEqual(result['provenance']['local'], False)
            self.assertIn('0.10.40', result['provenance']['made_with'])
            self.assertEqual([section['pageIndex'] for section in result['sections']], [0, 1])
            for page, section in zip(payload()['pages'], result['sections']):
                expected_units = re.split(r'\n\s*\n', page['text'])
                self.assertEqual(len(section['units']), len(expected_units))
                for expected, unit in zip(expected_units, section['units']):
                    self.assertEqual(unit['full'], expected)
                    for level in ('topic', 'takeaway', 'key', 'brief', 'full'):
                        self.assertTrue(unit[level], f'{level} must be populated for the AI-completed unit')
                    self.assertTrue(all(text in unit['sentences'] for text in unit['brief']))
                    self.assertTrue(all(0 <= index < len(unit['sentences']) for index in unit['evidence']))

    def test_failed_chunk_gets_one_page_scoped_retry(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-fallback-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker, fail_unit_calls={2})
            with contextlib.redirect_stdout(io.StringIO()):
                result = worker.make_fold(payload())
            self.assertEqual(state, {'overview': 1, 'units': 3, 'retries': 1})
            self.assertEqual(result['coverage']['units'], 3)
            self.assertTrue(all(unit['full'] for section in result['sections'] for unit in section['units']))

    def test_retry_targets_only_missing_units_and_maps_renumbered_ids(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-targeted-retry-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker, omit_units_by_call={2: {1}})
            with contextlib.redirect_stdout(io.StringIO()):
                result = worker.make_fold(payload())
            self.assertEqual(state, {'overview': 1, 'units': 3, 'retries': 1})
            # The third fake call only saw the missing paragraph; the returned U0 fills its original slot.
            repaired = result['sections'][1]['units'][1]
            self.assertEqual(repaired['full'], 'Rural districts face greater hiring constraints.')
            self.assertIn('Rural districts', repaired['takeaway'])

    def test_empty_textfold_takeaway_is_retried_before_local_fallback_can_pass(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-empty-takeaway-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker, empty_takeaway_by_call={2: {1}})
            with contextlib.redirect_stdout(io.StringIO()):
                result = worker.make_fold(payload())
            self.assertEqual(state, {'overview': 1, 'units': 3, 'retries': 1})
            self.assertIn('Rural districts', result['sections'][1]['units'][1]['takeaway'])

    def test_missing_unit_retry_is_bounded_and_still_rejects_incomplete_output(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-incomplete-retry-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker, omit_unit_calls={2}, omit_on_retry=True)
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'TEXTFOLD_INCOMPLETE'):
                    worker.make_fold(payload())
            self.assertEqual(state, {'overview': 1, 'units': 3, 'retries': 1})

    def test_missing_unit_retry_rejects_unexpected_ids_and_bad_evidence(self):
        for option in ({'wrong_retry_id': True}, {'invalid_retry_evidence': True}):
            with self.subTest(option=option), tempfile.TemporaryDirectory(prefix='zotero-textfold-invalid-retry-') as temp:
                worker = load_worker(temp)
                state = self.fake_model(worker, omit_unit_calls={2}, **option)
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaisesRegex(RuntimeError, 'TEXTFOLD_INCOMPLETE'):
                        worker.make_fold(payload())
                self.assertEqual(state, {'overview': 1, 'units': 3, 'retries': 1})

    def test_overview_must_cover_every_fulltext_page(self):
        with tempfile.TemporaryDirectory(prefix='zotero-textfold-coverage-') as temp:
            worker = load_worker(temp)
            state = self.fake_model(worker, overview_pages=[1])
            with contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'TEXTFOLD_INCOMPLETE'):
                    worker.make_fold(payload())
            self.assertEqual(state, {'overview': 1, 'units': 0, 'retries': 0})


if __name__ == '__main__':
    unittest.main(verbosity=2)
