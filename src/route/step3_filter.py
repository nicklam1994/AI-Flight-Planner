"""
Step 3: SID/STAR procedure filter based on route string key waypoints.

Extracts the SID exit waypoint and STAR entry waypoint from a route string,
then queries the PMDG .s3db to find matching procedures.

Route string format (from graph search output):
  Without SID/STAR names (v2 default):
    VHHH DCT OCEAN V3 SIKOU A1 ELATO DCT ZSSS
  With SID/STAR names (v1 legacy):
    VHHH BEKO3A BEKOL A461 SHL G471 PLT W19 NIDEG NIDE1B RJTT

Algorithm (token-by-token scan):
  - SID node: skip origin, skip procedure names, take first enroute waypoint
  - STAR node: backward scan, skip dest, skip procedure names, take last enroute waypoint
  - _is_procedure_name(): matches pattern like BEKO3A, OCE1A, NIDE1B
"""
import logging
import re

from src.db.connection import get_s3db
from src.db.sidstar import SID_RT, STAR_RT

logger = logging.getLogger(__name__)


def _is_procedure_name(token: str) -> bool:
    """
    Check if a token is a procedure name (SID/STAR/APPROACH).

    Procedure names are typically 3-5 letters + 1-2 digits + optional letter.
    Examples: BEKO3A, OCE1A, RAME1C, NIDE1B, KOS1B

    Args:
        token: A single token from the route string.

    Returns:
        True if the token matches a procedure name pattern.
    """
    return bool(re.match(r'^[A-Z]{3,5}\d[A-Z]?$', token))


def extract_filter_nodes(route_string: str, origin: str, dest: str) -> tuple:
    """
    Extract SID and STAR filter nodes from an ATS route string.

    Rules:
      - SID filter node = skip origin, skip procedure names + "DCT",
        take the first enroute waypoint
      - STAR filter node = backward scan, skip destination,
        skip procedure names, take the last enroute waypoint

    Examples:
        "VHHH DCT OCEAN V3 SIKOU A1 ELATO DCT ZSSS"
        → ("OCEAN", "ELATO")

        "VHHH BEKO3A BEKOL A461 SHL G471 PLT W19 NIDEG NIDE1B RJTT"
        → ("BEKOL", "NIDEG")  (skips BEKO3A=SID name, NIDE1B=STAR name)

    Args:
        route_string: ATS route string (e.g., "VHHH DCT OCEAN V3 ... ZSSS")
        origin: Origin airport ICAO
        dest: Destination airport ICAO

    Returns:
        (sid_filter_node, star_filter_node) — each a waypoint ident or None
    """
    tokens = route_string.strip().split()
    if not tokens:
        return None, None

    origin_upper = origin.upper()
    dest_upper = dest.upper()

    # --- SID filter node (forward scan) ---
    sid_node = None
    for i, tok in enumerate(tokens):
        tok_upper = tok.upper()

        if tok_upper == origin_upper:
            continue

        # Skip "DCT" keyword — take the next token as the waypoint
        if tok_upper == "DCT":
            if i + 1 < len(tokens):
                sid_node = tokens[i + 1]
            break

        # If it's a procedure name (SID), skip it and take the next token
        if _is_procedure_name(tok):
            if i + 1 < len(tokens):
                next_tok = tokens[i + 1]
                if next_tok.upper() != "DCT":
                    sid_node = next_tok
                elif i + 2 < len(tokens):
                    sid_node = tokens[i + 2]
            break

        # If it's a waypoint (not origin/dest, not keyword), treat as first enroute
        if tok_upper not in ("DCT", origin_upper, dest_upper):
            sid_node = tok
            break

    # --- STAR filter node (backward scan) ---
    star_node = None
    for i in range(len(tokens) - 1, -1, -1):
        tok = tokens[i]
        tok_upper = tok.upper()

        if tok_upper == dest_upper:
            continue

        # If we find a procedure name (STAR) from the back, the waypoint before it
        if _is_procedure_name(tok):
            if i > 0 and tokens[i - 1].upper() == "DCT" and i > 1:
                star_node = tokens[i - 2]
            elif i > 0:
                star_node = tokens[i - 1]
            break

        # "DCT" from the back — take the token before it
        if tok_upper == "DCT":
            if i > 0:
                star_node = tokens[i - 1]
            break

        # If it's a regular waypoint, take it
        if tok_upper not in (origin_upper, dest_upper):
            star_node = tok
            break

    logger.debug(
        f"extract_filter_nodes: sid={sid_node}, star={star_node} "
        f"from '{route_string}'"
    )
    return sid_node, star_node


def filter_sids(airport: str, waypoint: str) -> list[dict]:
    """
    Find SIDs at an airport that pass through a specific waypoint.

    Queries tbl_sids for procedures where any leg's waypoint_identifier
    matches the given waypoint.

    Args:
        airport: 4-letter ICAO airport code (e.g., "VHHH")
        waypoint: Waypoint identifier (e.g., "OCEAN")

    Returns:
        List of {name, runways} dicts for matching SIDs.
        Empty list if no .s3db available or no matches.
    """
    db = get_s3db()
    if db is None:
        return []

    rows = db.execute(
        "SELECT DISTINCT procedure_identifier, transition_identifier "
        "FROM tbl_sids "
        "WHERE airport_identifier = ? "
        f"AND route_type {SID_RT} "
        "AND waypoint_identifier = ? "
        "ORDER BY procedure_identifier, transition_identifier",
        (airport.upper(), waypoint.upper()),
    ).fetchall()

    return _group_by_procedure(rows)


def filter_stars(airport: str, waypoint: str) -> list[dict]:
    """
    Find STARs at an airport that pass through a specific waypoint.

    Queries tbl_stars for procedures where any leg's waypoint_identifier
    matches the given waypoint.

    Args:
        airport: 4-letter ICAO airport code (e.g., "ZSSS")
        waypoint: Waypoint identifier (e.g., "SASAN")

    Returns:
        List of {name, runways} dicts for matching STARs.
        Empty list if no .s3db available or no matches.
    """
    db = get_s3db()
    if db is None:
        return []

    rows = db.execute(
        "SELECT DISTINCT procedure_identifier, transition_identifier "
        "FROM tbl_stars "
        "WHERE airport_identifier = ? "
        f"AND route_type {STAR_RT} "
        "AND waypoint_identifier = ? "
        "ORDER BY procedure_identifier, transition_identifier",
        (airport.upper(), waypoint.upper()),
    ).fetchall()

    return _group_by_procedure(rows)


def _group_by_procedure(rows) -> list[dict]:
    """Group flat rows by procedure_identifier, collecting transition_identifiers."""
    result: dict[str, list[str]] = {}
    for r in rows:
        result.setdefault(r["procedure_identifier"], []).append(
            r["transition_identifier"]
        )
    return [{"name": name, "runways": rwys} for name, rwys in result.items()]


def filter_for_route(
    route_string: str,
    dep_icao: str,
    arr_icao: str,
) -> dict:
    """
    Filter SIDs at departure and STARs at arrival by key route waypoints.

    Extracts the SID exit and STAR entry waypoints from the route string,
    then queries the PMDG .s3db for matching procedures.

    Args:
        route_string: e.g. "VHHH DCT OCEAN V3 ... SASAN STAR ZSSS"
        dep_icao: Departure airport ICAO
        arr_icao: Arrival airport ICAO

    Returns:
        {"sids": [...], "stars": [...], "sid_node": ..., "star_node": ...}
    """
    sid_node, star_node = extract_filter_nodes(route_string, dep_icao, arr_icao)

    sids = filter_sids(dep_icao, sid_node) if sid_node else []
    stars = filter_stars(arr_icao, star_node) if star_node else []

    logger.info(
        f"Step3 filter_for_route: {dep_icao}→{arr_icao} "
        f"sid_node={sid_node}({len(sids)}) star_node={star_node}({len(stars)})"
    )

    return {
        "sids": sids,
        "stars": stars,
        "sid_node": sid_node,
        "star_node": star_node,
    }
