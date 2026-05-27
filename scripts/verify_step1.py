#!/usr/bin/env python3
"""Verify step 1: config and cycle resolution."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from src.config import config, list_cycles, resolve_db_path, list_cycle_ids

print("=== Config ===")
print(f"cycles_dir: {config.cycles_dir}")
print(f"default_cycle: {config.default_cycle}")
print(f"Available cycles: {list_cycle_ids()}")
print()
for c in list_cycles():
    print(f"  {c['id']}: {c['label']}")
print()
print(f"Resolved DB (2604): {resolve_db_path('2604')}")
print(f"Resolved DB (2602): {resolve_db_path('2602')}")

# Check files exist
from pathlib import Path
for cid in ['2602', '2604']:
    p = Path(resolve_db_path(cid))
    print(f"  {cid} DB: {p.exists()} ({p.stat().st_size/1024/1024:.0f} MB)")

print("\nStep 1: PASS")
