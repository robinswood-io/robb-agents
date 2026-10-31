from __future__ import annotations

from typing import TypeGuard

from pydantic import JsonValue, TypeAdapter

JSON_VALUE_ADAPTER = TypeAdapter(JsonValue)


def _is_json_object(value: JsonValue) -> TypeGuard[dict[str, JsonValue]]:
    return isinstance(value, dict)

def _is_json_array(value: JsonValue) -> TypeGuard[list[JsonValue]]:
    return isinstance(value, list)

def _is_string_array(value: JsonValue) -> TypeGuard[list[str]]:
    return isinstance(value, list) and all(isinstance(item, str) for item in value)

def _optional_string(value: JsonValue) -> str | None:
    if value is None or isinstance(value, str):
        return value
    raise ValueError("expected a string or null in catalog data")

def _optional_bool(value: JsonValue) -> bool | None:
    if value is None or isinstance(value, bool):
        return value
    raise ValueError("expected a boolean or null in policy data")

def _json_array_or_raise(value: JsonValue) -> list[JsonValue]:
    if _is_json_array(value):
        return value
    raise ValueError("expected an array in catalog data")


def _integer(value: JsonValue) -> int:
    if isinstance(value, (str, int, float, bool)):
        return int(value)
    raise TypeError("expected an integer-compatible catalog value")

def _to_json_value(raw_json: str) -> JsonValue:
    return JSON_VALUE_ADAPTER.validate_json(raw_json)

def _to_json_object(raw_json: str) -> dict[str, JsonValue]:
    value = JSON_VALUE_ADAPTER.validate_json(raw_json)
    if _is_json_object(value):
        return value
    raise TypeError("expected a JSON object")

__all__ = [
    "JSON_VALUE_ADAPTER",
    "_integer",
    "_is_json_array",
    "_is_json_object",
    "_is_string_array",
    "_json_array_or_raise",
    "_optional_bool",
    "_optional_string",
    "_to_json_object",
    "_to_json_value",
]
