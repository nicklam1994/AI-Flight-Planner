#!/usr/bin/env python3
"""Quick smoke test for AI Flight Planner imports."""
from src.config import config, list_cycles, resolve_db_path

print("=== Config ===")
print(f"default_cycle={config.default_cycle}")
print(f"db_path={config.db_path}")
print(f"cycles_dir={config.cycles_dir}")

print("\n=== Cycles ===")
cycles = list_cycles()
for c in cycles:
    print(f"  {c['id']}: {c['label']}")

print("\n=== DB Path Resolution ===")
path = resolve_db_path("2604")
print(f"2604 -> {path}")

print("\n=== DB Connection ===")
from src.db.connection import get_db
db = get_db()
tables = db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
).fetchall()
print(f"Tables: {', '.join(r['name'] for r in tables)}")

print("\n=== Graph Builder ===")
from src.db.graph_builder import build_airway_graph
G, wp = build_airway_graph(airway_type=None)
print(f"Nodes: {G.number_of_nodes()}")
print(f"Edges: {G.number_of_edges()}")

print("\n✅ All imports and basic operations successful!")
