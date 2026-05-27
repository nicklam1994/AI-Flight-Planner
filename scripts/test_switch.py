#!/usr/bin/env python3
"""Debug cycle switching."""
import asyncio
import sys
sys.path.insert(0, ".")

from src.config import config, resolve_db_path
from src.db.connection import get_db, reconnect_db
from src.db.graph_builder import build_airway_graph

async def test_switch():
    print(f"Current: {config.current_cycle}")
    print(f"DB: {config.db_path}")

    # Test switch to 2602
    db_path = resolve_db_path("2602")
    print(f"New DB path: {db_path}")

    config.db_path = db_path
    print("Reconnecting...")
    reconnect_db(db_path)
    print("Building graph...")
    G, wp = build_airway_graph(airway_type=None)
    print(f"Loaded: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

    config.current_cycle = "2602"
    print("✅ Switch successful!")

asyncio.run(test_switch())
