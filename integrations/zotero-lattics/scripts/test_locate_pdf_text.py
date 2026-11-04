#!/usr/bin/env python3
"""Regression tests for coordinate-safe PDF text matching."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("locate_pdf_text.py")
SPEC = importlib.util.spec_from_file_location("locate_pdf_text", SCRIPT)
assert SPEC and SPEC.loader
LOCATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOCATOR)


class FakePage:
    def get_text(self, kind: str, *, sort: bool = False):
        self_kind = kind
        assert self_kind == "words"
        assert sort is False
        return [
            (10.0, 10.0, 35.0, 20.0, "第①项", 0, 0, 0),
            (40.0, 10.0, 60.0, 20.0, "技术", 0, 0, 1),
        ]


class CircledMarginPage:
    rect = type("Rect", (), {"height": 800.0})()

    def get_text(self, kind: str, *, sort: bool = False):
        assert kind == "words"
        assert sort is False
        return [(10.0, 10.0, 20.0, 20.0, "①", 0, 0, 0)]


class WrappedChinesePage:
    def get_text(self, kind: str, *, sort: bool = False):
        assert kind == "words"
        assert sort is False
        return [
            (10.0, 10.0, 120.0, 20.0, "回归发现，真正高价值的专利", 0, 0, 0),
            (10.0, 25.0, 220.0, 35.0, "技术上的高水平是其高价值的重要基础。", 0, 1, 0),
        ]

    def search_for(self, text: str):
        if text == "真正高价值的专利":
            return [LOCATOR.fitz.Rect(55.0, 10.0, 120.0, 20.0)]
        if text == "技术上的高水平是其高价值的重要基础。":
            return [LOCATOR.fitz.Rect(10.0, 25.0, 220.0, 35.0)]
        return []


class CircledNumberRegressionTest(unittest.TestCase):
    def test_compatibility_number_matches_plain_number_without_losing_rectangles(self):
        matches = LOCATOR.word_sequence_matches(FakePage(), "第1项 技术")

        self.assertEqual(len(matches), 1)
        self.assertEqual(len(matches[0]), 1)
        self.assertEqual(matches[0][0].x0, 10.0)
        self.assertEqual(matches[0][0].x1, 60.0)

    def test_circled_margin_marker_is_not_parsed_as_a_printed_page_number(self):
        self.assertEqual(LOCATOR.infer_printed_page_labels([CircledMarginPage()]), {})

    def test_wrapped_chinese_passage_matches_without_inserted_spaces(self):
        matches = LOCATOR.word_sequence_matches(
            WrappedChinesePage(),
            "真正高价值的专利技术上的高水平是其高价值的重要基础。",
        )

        self.assertEqual(len(matches), 1)
        self.assertEqual(len(matches[0]), 2)
        self.assertEqual(matches[0][0].x0, 55.0)


if __name__ == "__main__":
    unittest.main()
