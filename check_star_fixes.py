from src.db.connection import get_db
from src.db.graph_builder import build_airway_graph

# Build graph
print("Building graph...")
G, wp_map = build_airway_graph()
print(f"Graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges")

# ZGGG STAR fixes
star_fixes = ['ENVIP', 'D012Y', 'D197Q', 'D023M', 'GYA', 'IDUMA', 'LUPVU', 'IKAVO', 'IRTAT', 'OLPAB']

print("\nChecking STAR fixes in graph:")
for fix in star_fixes:
    # Find waypoint_id
    found = False
    for wp_id, wp in wp_map.items():
        if wp.ident.upper() == fix:
            found = True
            in_graph = wp_id in G.nodes()
            if in_graph:
                successors = list(G.successors(wp_id))
                predecessors = list(G.predecessors(wp_id))
                print(f"  ✓ {fix:10s} → in graph, {len(successors)} out, {len(predecessors)} in")
            else:
                print(f"  ✗ {fix:10s} → NOT in graph (no airway connections)")
            break
    if not found:
        print(f"  ✗ {fix:10s} → NOT in waypoint table")
