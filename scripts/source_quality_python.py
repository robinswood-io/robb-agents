"""Inspect Python type annotations without importing maintained application code."""

from __future__ import annotations

import ast
import json
import sys
from typing import Literal, TypedDict, cast


class SourceEntry(TypedDict):
    file: str
    content: str


class SourceIssue(TypedDict):
    file: str
    rule: Literal["no-explicit-any"]
    line: int
    actual: int


def inspect_entry(entry: SourceEntry) -> list[SourceIssue]:
    tree = ast.parse(entry["content"], filename=entry["file"], type_comments=True)
    aliases: set[str] = set()
    typing_modules = {"typing", "typing_extensions"}
    literal_names = {"Literal"}
    annotated_names = {"Annotated"}
    type_alias_names = {"TypeAlias"}
    imports: list[tuple[str, int]] = []
    used_aliases: set[str] = set()
    locations: set[tuple[int, int]] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name in {"typing", "typing_extensions"}:
                    typing_modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module in {"typing", "typing_extensions"}:
            for alias in node.names:
                name = alias.asname or alias.name
                if alias.name == "Any":
                    aliases.add(name)
                    imports.append((name, node.lineno))
                elif alias.name == "*":
                    aliases.add("Any")
                elif alias.name == "Literal":
                    literal_names.add(name)
                elif alias.name == "Annotated":
                    annotated_names.add(name)
                elif alias.name == "TypeAlias":
                    type_alias_names.add(name)

    def record(node: ast.AST, base_line: int = 0, annotation: bool = False) -> None:
        if isinstance(node, ast.Name) and (node.id in aliases or annotation and node.id == "Any"):
            locations.add((base_line + node.lineno, node.col_offset))
            used_aliases.add(node.id)
        elif (isinstance(node, ast.Attribute) and node.attr == "Any"
              and isinstance(node.value, ast.Name) and node.value.id in typing_modules):
            locations.add((base_line + node.lineno, node.col_offset))

    def annotation_name(node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id in typing_modules:
            return node.attr
        return ""

    def forward_refs(node: ast.AST | None, base_line: int = 0) -> None:
        if node is None:
            return
        record(node, base_line, annotation=True)
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            try:
                parsed = ast.parse(node.value, mode="eval")
            except SyntaxError:
                return
            forward_refs(parsed.body, base_line + node.lineno - 1)
            return
        if isinstance(node, ast.Subscript):
            name = annotation_name(node.value)
            forward_refs(node.value, base_line)
            if name in literal_names:
                return
            if name in annotated_names and isinstance(node.slice, ast.Tuple):
                forward_refs(node.slice.elts[0], base_line)
                return
            forward_refs(node.slice, base_line)
            return
        for child in ast.iter_child_nodes(node):
            forward_refs(child, base_line)

    type_alias_class = getattr(ast, "TypeAlias", ())
    for node in ast.walk(tree):
        record(node)
        if isinstance(node, ast.arg):
            forward_refs(node.annotation)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            forward_refs(node.returns)
        elif isinstance(node, ast.AnnAssign):
            forward_refs(node.annotation)
            if annotation_name(node.annotation) in type_alias_names:
                forward_refs(node.value)
        elif isinstance(node, type_alias_class):
            forward_refs(getattr(node, "value", None))

    # Removing annotations must also remove an obsolete opaque import.
    locations.update((line, 0) for alias, line in imports if alias not in used_aliases)
    return [{"file": entry["file"], "rule": "no-explicit-any", "line": line, "actual": 1}
            for line, _column in sorted(locations)]


def main() -> None:
    payload = cast(object, json.load(sys.stdin))
    if not isinstance(payload, list):
        raise TypeError("Source entries must be a list")
    entries: list[SourceEntry] = []
    for item in cast(list[object], payload):
        if not isinstance(item, dict):
            raise TypeError("Source entry must be an object")
        fields = cast(dict[str, object], item)
        file, content = fields.get("file"), fields.get("content")
        if not isinstance(file, str) or not isinstance(content, str):
            raise TypeError("Source file and content must be strings")
        entries.append({"file": file, "content": content})
    issues = [issue for entry in entries for issue in inspect_entry(entry)]
    json.dump(issues, sys.stdout)
    _ = sys.stdout.write("\n")


if __name__ == "__main__":
    try:
        main()
    except SyntaxError as error:
        print(f"{error.filename}:{error.lineno}: Python source could not be parsed", file=sys.stderr)
        raise SystemExit(2) from None
