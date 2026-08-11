#!/usr/bin/env python3
"""Verify the exact public GitHub Pages candidate commit."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import unicodedata
from typing import Any


class VerificationFailure(Exception):
    """A stable, redacted verifier failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class StrictArgumentParser(argparse.ArgumentParser):
    """Prevent argparse from printing paths or implementation details."""

    def error(self, _message: str) -> None:
        raise VerificationFailure("ARGUMENTS_INVALID")


ARGUMENTS = (
    ("--repo", "repo"),
    ("--operation-id", "operation_id"),
    ("--source-main-sha", "source_main_sha"),
    ("--workflow-sha", "workflow_sha"),
    ("--expected-gh-pages-sha", "expected_gh_pages_sha"),
    ("--site-commit", "site_commit"),
    ("--site-sha256", "site_sha256"),
    ("--route-inventory-sha256", "route_inventory_sha256"),
    ("--public-projection-sha256", "public_projection_sha256"),
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_git(repo: str, args: list[str]) -> bytes:
    try:
        result = subprocess.run(
            ["git", "-C", repo, *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    except OSError as error:
        raise VerificationFailure("GIT_UNAVAILABLE") from error
    if result.returncode != 0:
        raise VerificationFailure("GIT_COMMAND_FAILED")
    return result.stdout


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = StrictArgumentParser(add_help=False)
    for flag, destination in ARGUMENTS:
        parser.add_argument(flag, dest=destination, required=True)
    return parser.parse_args(argv)


def require_hex(value: Any, length: int, code: str) -> str:
    if not isinstance(value, str) or re.fullmatch(rf"[0-9a-f]{{{length}}}", value) is None or set(value) == {"0"}:
        raise VerificationFailure(code)
    return value


def parse_tree(repo: str, commit: str) -> list[dict[str, str]]:
    output = run_git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit])
    entries: list[dict[str, str]] = []
    for record in output.split(b"\0"):
        if not record:
            continue
        try:
            metadata, path_bytes = record.split(b"\t", 1)
            mode, kind, object_id = metadata.decode("ascii").split(" ")
            relative_path = path_bytes.decode("utf-8")
        except (UnicodeDecodeError, ValueError) as error:
            raise VerificationFailure("TREE_INVALID") from error
        entries.append({"mode": mode, "type": kind, "oid": object_id, "path": relative_path})
    return entries


def canonical_json(value: Any) -> bytes:
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError) as error:
        raise VerificationFailure("JSON_INVALID") from error


def verify(args: argparse.Namespace) -> dict[str, Any]:
    operation_id = require_hex(args.operation_id, 32, "OPERATION_ID_INVALID")
    source_main_sha = require_hex(args.source_main_sha, 40, "SOURCE_MAIN_SHA_INVALID")
    workflow_sha = require_hex(args.workflow_sha, 40, "WORKFLOW_SHA_INVALID")
    expected_gh_pages_sha = require_hex(args.expected_gh_pages_sha, 40, "EXPECTED_GH_PAGES_SHA_INVALID")
    site_commit = require_hex(args.site_commit, 40, "SITE_COMMIT_INVALID")
    expected_site_sha = require_hex(args.site_sha256, 64, "SITE_SHA256_INVALID")
    expected_route_sha = require_hex(args.route_inventory_sha256, 64, "ROUTE_INVENTORY_SHA256_INVALID")
    expected_projection_sha = require_hex(args.public_projection_sha256, 64, "PUBLIC_PROJECTION_SHA256_INVALID")

    if run_git(args.repo, ["rev-parse", "--is-inside-work-tree"]).strip() != b"true":
        raise VerificationFailure("REPO_NOT_GIT_WORKTREE")
    if run_git(args.repo, ["rev-parse", "--verify", "HEAD^{commit}"]).strip().decode("ascii") != site_commit:
        raise VerificationFailure("HEAD_MISMATCH")
    remote_head = run_git(args.repo, ["rev-parse", "--verify", "refs/remotes/origin/gh-pages^{commit}"]).strip().decode("ascii")
    if remote_head != site_commit:
        raise VerificationFailure("REMOTE_GH_PAGES_MISMATCH")

    parent_line = run_git(args.repo, ["rev-list", "--parents", "-n", "1", site_commit]).strip().split()
    if len(parent_line) != 2 or parent_line[1].decode("ascii") != expected_gh_pages_sha:
        raise VerificationFailure("SITE_PARENT_MISMATCH")
    for commit in (source_main_sha, workflow_sha):
        if run_git(args.repo, ["cat-file", "-t", f"{commit}^{{commit}}"]).strip() != b"commit":
            raise VerificationFailure("COMMIT_OBJECT_MISSING")

    entries = parse_tree(args.repo, site_commit)
    if len(entries) > 10_000:
        raise VerificationFailure("TREE_FILE_LIMIT_EXCEEDED")
    casefold_paths: set[str] = set()
    for entry in entries:
        if (
            unicodedata.normalize("NFC", entry["path"]) != entry["path"]
            or "\\" in entry["path"]
            or any(unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in entry["path"])
        ):
            raise VerificationFailure("TREE_PATH_INVALID")
        casefold_path = entry["path"].casefold()
        if casefold_path in casefold_paths:
            raise VerificationFailure("TREE_PATH_COLLISION")
        casefold_paths.add(casefold_path)
        if entry["path"].startswith("site/"):
            if entry["type"] != "blob" or entry["mode"] not in {"100644", "100755"}:
                raise VerificationFailure("TREE_NON_REGULAR")
        elif entry["path"] == ".t13/routes.json":
            if entry["type"] != "blob" or entry["mode"] != "100644":
                raise VerificationFailure("TREE_NON_REGULAR")
        else:
            raise VerificationFailure("TREE_PATH_NOT_ALLOWED")
    site_entries = [entry for entry in entries if entry["path"].startswith("site/")]
    route_entries = [entry for entry in entries if entry["path"] == ".t13/routes.json"]
    if not site_entries:
        raise VerificationFailure("TREE_INVALID")
    site_paths = {entry["path"] for entry in site_entries}
    if not {"site/index.html", "site/404.html", "site/.nojekyll"}.issubset(site_paths):
        raise VerificationFailure("SITE_REQUIRED_FILE_MISSING")
    if not route_entries:
        raise VerificationFailure("ROUTE_MANIFEST_MISSING")
    if len(route_entries) != 1:
        raise VerificationFailure("ROUTE_MANIFEST_INVALID")

    total_blob_size = 0
    for entry in entries:
        try:
            blob_size = int(run_git(args.repo, ["cat-file", "-s", entry["oid"]]).strip())
        except ValueError as error:
            raise VerificationFailure("GIT_OBJECT_INVALID") from error
        if blob_size > 10 * 1024 * 1024:
            raise VerificationFailure("TREE_BLOB_LIMIT_EXCEEDED")
        total_blob_size += blob_size
        if total_blob_size > 100 * 1024 * 1024:
            raise VerificationFailure("TREE_TOTAL_LIMIT_EXCEEDED")

    blobs: dict[str, bytes] = {}
    for entry in entries:
        blobs[entry["path"]] = run_git(args.repo, ["cat-file", "blob", entry["oid"]])
    if blobs["site/.nojekyll"] != b"":
        raise VerificationFailure("NOJEKYLL_INVALID")

    site_lines = []
    for entry in site_entries:
        relative_path = entry["path"][len("site/"):]
        content = blobs[entry["path"]]
        site_lines.append(f"{relative_path}\0{entry['mode']}\0{sha256(content)}\0{len(content)}\n")
    site_sha = sha256("".join(sorted(site_lines)).encode("utf-8"))
    if site_sha != expected_site_sha:
        raise VerificationFailure("SITE_SHA256_MISMATCH")

    route_bytes = blobs[route_entries[0]["path"]]
    try:
        routes = json.loads(route_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VerificationFailure("ROUTE_MANIFEST_INVALID") from error
    canonical_route_bytes = canonical_json(routes)
    if route_bytes != canonical_route_bytes:
        raise VerificationFailure("ROUTE_MANIFEST_NOT_CANONICAL")
    if (
        not isinstance(routes, list)
        or not routes
        or any(not isinstance(route, str) for route in routes)
        or len(set(routes)) != len(routes)
    ):
        raise VerificationFailure("ROUTE_MANIFEST_INVALID")
    if len(routes) > 10_000:
        raise VerificationFailure("ROUTE_MANIFEST_LIMIT_EXCEEDED")
    for route in routes:
        if (
            not route.startswith("/")
            or len(route.encode("utf-8")) > 512
            or "\\" in route
            or unicodedata.normalize("NFC", route) != route
            or any(unicodedata.category(character) in {"Cc", "Cf", "Cs"} for character in route)
        ):
            raise VerificationFailure("ROUTE_MANIFEST_INVALID")
    route_sha = sha256(canonical_route_bytes)
    if route_sha != expected_route_sha:
        raise VerificationFailure("ROUTE_INVENTORY_SHA256_MISMATCH")

    projection = {
        "schema_version": 1,
        "operation_id": operation_id,
        "state_code": "published",
        "source_main_sha": source_main_sha,
        "site_commit": site_commit,
        "site_sha256": site_sha,
        "route_inventory_sha256": route_sha,
        "workflow_sha": workflow_sha,
    }
    projection_sha = sha256(canonical_json(projection))
    if projection_sha != expected_projection_sha:
        raise VerificationFailure("PUBLIC_PROJECTION_SHA256_MISMATCH")

    return {
        **projection,
        "expected_gh_pages_sha": expected_gh_pages_sha,
        "public_projection_sha256": projection_sha,
    }


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        result = verify(args)
        sys.stdout.buffer.write((json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
        return 0
    except VerificationFailure as error:
        sys.stderr.buffer.write(f"{error.code}\n".encode("ascii"))
        return 1
    except Exception:
        sys.stderr.buffer.write(b"VERIFIER_FAILED\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
