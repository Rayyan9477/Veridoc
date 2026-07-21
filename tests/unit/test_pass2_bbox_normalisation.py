"""Regression tests for AUDITOR payload normalisation.

Both bugs here were found live against Qwen Cloud: the pass2 telemetry read
``bbox_count=0`` on every document even though the model was returning good
coordinates, which left Source View with nothing to draw.
"""

from src.agents.extractor_pass2 import ExtractorPass2Agent as A


class TestUnwrapFields:
    """Qwen3-VL emits records at the top level, ignoring the envelope."""

    def test_reads_wrapped_fields(self):
        payload = {"fields": {"a": {"value": "1", "bbox": [0.1, 0.1, 0.2, 0.2]}}}
        assert A._unwrap_fields(payload) == payload["fields"]

    def test_recovers_top_level_records(self):
        payload = {
            "vendor_name": {"value": "Northwind", "bbox": [0.1, 0.1, 0.2, 0.2]},
            "invoice_number": {"value": "NR-1", "confidence": 0.9},
        }
        assert set(A._unwrap_fields(payload)) == {"vendor_name", "invoice_number"}

    def test_ignores_non_record_siblings(self):
        payload = {
            "page_number": 1,
            "extraction_notes": "clean scan",
            "vendor_name": {"value": "Northwind", "bbox": [0.1, 0.1, 0.2, 0.2]},
        }
        assert set(A._unwrap_fields(payload)) == {"vendor_name"}

    def test_wrapped_fields_win_over_top_level(self):
        payload = {
            "fields": {"a": {"value": "1"}},
            "b": {"value": "2"},
        }
        assert set(A._unwrap_fields(payload)) == {"a"}

    def test_empty_payload(self):
        assert A._unwrap_fields({}) == {}


class TestCoerceBbox:
    def test_passes_through_valid_list(self):
        assert A._coerce_bbox([0.1, 0.2, 0.3, 0.4]) == [0.1, 0.2, 0.3, 0.4]

    def test_dict_with_far_edge_semantics(self):
        # w/h already beyond the origin => they are x2/y2.
        assert A._coerce_bbox({"x": 0.13, "y": 0.07, "w": 0.36, "h": 0.12}) == [
            0.13,
            0.07,
            0.36,
            0.12,
        ]

    def test_dict_with_extent_semantics(self):
        # h smaller than y => it is a height, not a far edge.
        box = A._coerce_bbox({"x": 0.52, "y": 0.25, "w": 0.65, "h": 0.02})
        assert box is not None
        assert box[1] == 0.25
        assert box[3] == 0.27

    def test_rejects_pixel_coordinates(self):
        # qwen-vl-max answers in pixels; without page dims a box would be wrong.
        assert A._coerce_bbox([785, 170, 890, 185]) is None

    def test_rejects_degenerate_box(self):
        assert A._coerce_bbox([0.4, 0.4, 0.4, 0.5]) is None
        assert A._coerce_bbox([0.4, 0.4, 0.3, 0.5]) is None

    def test_rejects_malformed(self):
        assert A._coerce_bbox(None) is None
        assert A._coerce_bbox([0.1, 0.2]) is None
        assert A._coerce_bbox("0.1,0.2,0.3,0.4") is None
        assert A._coerce_bbox({"x": 0.1, "y": 0.2}) is None


class TestNormalisePayload:
    def test_top_level_dict_bboxes_survive_end_to_end(self):
        """The exact live shape that produced bbox_count=0."""
        payload = {
            "vendor_name": {
                "value": "Northwind Robotics Ltd.",
                "confidence": 0.98,
                "bbox": {"x": 0.13, "y": 0.07, "w": 0.36, "h": 0.12},
            },
            "vendor_phone": {
                "value": "(503) 555-0188",
                "confidence": 0.96,
                "bbox": {"x": 0.52, "y": 0.25, "w": 0.65, "h": 0.02},
            },
        }
        out = A._normalise_payload(payload)
        assert A._count_bboxes(out) == 2
        assert out["fields"]["vendor_name"]["bbox"] == [0.13, 0.07, 0.36, 0.12]

    def test_drops_bbox_when_value_is_null(self):
        payload = {"fields": {"a": {"value": None, "bbox": [0.1, 0.1, 0.2, 0.2]}}}
        out = A._normalise_payload(payload)
        assert out["fields"]["a"]["bbox"] is None
        assert A._count_bboxes(out) == 0

    def test_preserves_non_field_metadata(self):
        payload = {
            "page_number": 3,
            "fields": {"a": {"value": "1", "bbox": [0.1, 0.1, 0.2, 0.2]}},
        }
        out = A._normalise_payload(payload)
        assert out["page_number"] == 3
        assert A._count_bboxes(out) == 1

    def test_non_dict_payload(self):
        assert A._normalise_payload("nope") == {"fields": {}}

    def test_record_keys_are_preserved(self):
        payload = {"a": {"value": "1", "confidence": 0.7, "location": "top", "bbox": None}}
        out = A._normalise_payload(payload)
        assert out["fields"]["a"]["location"] == "top"
        assert out["fields"]["a"]["confidence"] == 0.7
