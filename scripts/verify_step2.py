#!/usr/bin/env python3
"""Step 2 verification: route search engine test."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ['DB_PATH'] = '/home/nicklam-ai/workspace/AI Flight Planner/lnm_2604/little_navmap_navigraph.sqlite'

from src.db.graph_builder import build_airway_graph
from src.route.graph_search import find_routes

print("Building airway graph (ALL types)...")
G, wp_map = build_airway_graph(airway_type=None)
print(f"Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

print("\nSearching VHHH → RJTT...")
try:
    routes = find_routes('VHHH', 'RJTT', G, wp_map, k=3)
    for r in routes:
        print(f"#{r.index}: {r.total_distance_nm:.0f} NM — {r.route_string[:200]}")
    print(f"\nFound {len(routes)} routes")
    print("Step 2: PASS")
except Exception as e:
    print(f"Step 2: FAIL — {e}")
    import traceback
    traceback.print_exc()
