#!/usr/bin/env python3
"""Delete all old Supabase projects at once.
Usage: python3 delete_all_old_projects.py <personal_access_token>
"""
import sys, urllib.request, json

if len(sys.argv) < 2:
    print("Usage: python3 delete_all_old_projects.py <personal_access_token>")
    print("\nGet your PAT from: https://supabase.com/dashboard/account/tokens")
    sys.exit(1)

pat = sys.argv[1]
projects = [
    ("aurtflbwwvrcuauiwitr", "RMX3834's Project"),
    ("yhvfguhgbxinphcvbjax", "RMX3834's Projects"),
    ("drsfiidmwimxwseivfvj", "EXU CHAT"),
]

for ref, name in projects:
    req = urllib.request.Request(
        f"https://api.supabase.com/v1/projects/{ref}",
        method="DELETE",
        headers={"Authorization": f"Bearer {pat}", "Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"✅ {name} ({ref}) — deleted successfully")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"❌ {name} ({ref}) — {e.code}: {body}")
