"""Regression test — validate_field must not crash on a FieldDefinition.

The dual-VLM validation path called ``validate_field(value, field_def)``,
passing a whole (unhashable) ``FieldDefinition`` where a ``FieldType`` was
expected. ``field_type in validators`` then raised
``TypeError: unhashable type: 'FieldDefinition'``, which the validator
wrapped as "Validation failed", tanking every dual-VLM extraction to
success=False / confidence 0.35. These tests lock the fix.
"""

from __future__ import annotations

from src.schemas.field_types import FieldDefinition, FieldType
from src.schemas.validators import ValidationResult, validate_field


def _fd(field_type: FieldType, required: bool = True) -> FieldDefinition:
    return FieldDefinition(
        name="total_due",
        display_name="Total Due",
        field_type=field_type,
        description="invoice total",
        required=required,
    )


def test_validate_field_accepts_a_field_definition_without_crashing():
    # Passing a FieldDefinition (not a FieldType) used to raise
    # "unhashable type: 'FieldDefinition'".
    info = validate_field("$10,004.47", _fd(FieldType.CURRENCY))
    assert info.result in (ValidationResult.VALID, ValidationResult.INVALID)


def test_validate_field_unwraps_definition_to_same_result_as_type():
    by_def = validate_field("2026-05-01", _fd(FieldType.DATE))
    by_type = validate_field("2026-05-01", FieldType.DATE, required=True)
    assert by_def.result == by_type.result


def test_validator_step3_runs_on_a_real_schema_without_hashing_error():
    from src.agents.validator import ValidatorAgent
    from src.schemas.base import DocumentSchema

    schema = DocumentSchema(
        name="mini",
        display_name="Mini",
        document_type="invoice",
        fields=[_fd(FieldType.CURRENCY)],
    )
    agent = ValidatorAgent()
    result = agent._validate_extraction(
        extraction={"total_due": {"value": "$10,004.47", "confidence": 0.9}},
        field_metadata={},
        schema=schema,
        document_type="invoice",
        retry_count=0,
    )
    # The point: it completes and none of the errors are the hashing crash.
    assert not any("unhashable" in str(e) for e in result.errors)
