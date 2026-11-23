#!/usr/bin/env python3
"""Safely preview or explicitly delete the retired Supabase projects.

Dry-run is the default. To delete, set SUPABASE_ACCESS_TOKEN and pass
--confirm-delete; the script also requires an exact interactive confirmation.
Never pass access tokens as command-line arguments (they may be visible in
shell history and process listings).
"""
import argparse
import os
import sys
import urllib.error
import urllib.request

PROJECTS = (
    ("aurtflbwwvrcuauiwitr", "RMX3834's Project"),
    ("yhvfguhgbxinphcvbjax", "RMX3834's Projects"),
    ("drsfiidmwimxwseivfvj", "EXU CHAT"),
)
API_BASE = "https://api.supabase.com/v1/projects"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--confirm-delete",
        action="store_true",
        help="allow deletion after the required interactive confirmation",
    )
    args = parser.parse_args()

    print("Supabase projects selected:")
    for ref, name in PROJECTS:
        print(f"  - {name} ({ref})")

    if not args.confirm_delete:
        print("\nDry run only. Nothing was deleted.")
        print("To proceed, set SUPABASE_ACCESS_TOKEN and pass --confirm-delete.")
        return 0

    token = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
    if not token:
        print("ERROR: SUPABASE_ACCESS_TOKEN is not set.", file=sys.stderr)
        return 2

    expected = f"DELETE {len(PROJECTS)} SUPABASE PROJECTS"
    print("\nWARNING: Supabase project deletion is destructive and may be irreversible.")
    try:
        confirmation = input(f'Type exactly "{expected}" to continue: ').strip()
    except EOFError:
        print("\nNo interactive confirmation received; nothing was deleted.")
        return 2
    if confirmation != expected:
        print("Confirmation did not match; nothing was deleted.")
        return 2

    failed = False
    for ref, name in PROJECTS:
        request = urllib.request.Request(
            f"{API_BASE}/{ref}",
            method="DELETE",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                print(f"OK: {name} ({ref}) — HTTP {response.status}")
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")[:1000]
            print(f"FAILED: {name} ({ref}) — HTTP {error.code}: {details}", file=sys.stderr)
            failed = True
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            print(f"FAILED: {name} ({ref}) — {error}", file=sys.stderr)
            failed = True

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
