"""NLP Parser — converts natural language routing requests into structured parameters.

Uses the LLM to extract origin/destination airports, airway preferences,
waypoint/airspace avoidance, and cruise altitude from free-text input.
"""
import json
import logging
import re

from src.ai.llm_client import llm_chat, build_llm_config
from src.ai.prompt_templates import build_nlp_parser_prompt
from src.route.models import ParsedIntent

logger = logging.getLogger(__name__)


async def parse_intent(
    user_input: str,
    llm_config: dict | None = None,
) -> ParsedIntent:
    """
    Parse a natural language routing request into a ParsedIntent.

    Calls the LLM with the NLP parser system prompt. Falls back to a
    basic regex-based parser if the LLM is unavailable.

    Args:
        user_input: Natural language input (e.g., "VHHH to RJTT, high altitude").
        llm_config: Optional LLM configuration override from frontend.

    Returns:
        ParsedIntent with structured fields.
    """
    cfg = build_llm_config(llm_config)
    messages = build_nlp_parser_prompt(user_input)

    try:
        raw_response = await llm_chat(messages, llm_cfg=cfg)
        logger.debug(f"NLP parser raw response: {raw_response}")

        # Try to extract JSON from the response (LLMs sometimes wrap in markdown)
        parsed = _extract_json(raw_response)

        return ParsedIntent(
            origin=parsed.get("origin"),
            destination=parsed.get("destination"),
            airway_type=parsed.get("airway_type"),
            avoid_waypoints=parsed.get("avoid_waypoints", []),
            avoid_airspaces=parsed.get("avoid_airspaces", []),
            prefer_sid=parsed.get("prefer_sid"),
            prefer_star=parsed.get("prefer_star"),
            cruise_altitude=parsed.get("cruise_altitude"),
            cruise_altitude_min=parsed.get("cruise_altitude_min"),
            cruise_altitude_max=parsed.get("cruise_altitude_max"),
            confidence=float(parsed.get("confidence", 0.0)),
            context=parsed.get("context") or parsed.get("reasoning"),
            aircraft_type=parsed.get("aircraft_type"),
            fuel_unit=parsed.get("fuel_unit"),
        )

    except Exception as e:
        logger.warning(f"LLM parsing failed ({e}), falling back to regex")
        return _fallback_parse(user_input)


def _extract_json(text: str) -> dict:
    """
    Extract a JSON object from LLM output, handling markdown code blocks
    and chain-of-thought text (where the actual JSON appears near the end).
    """
    text = text.strip()

    # Remove markdown code fences
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    # Find the last complete JSON object (model thinks out loud first)
    end = text.rfind("}")
    if end == -1:
        raise json.JSONDecodeError("No closing brace found", text, 0)

    depth = 0
    start = end
    for i in range(end, -1, -1):
        if text[i] == "}":
            depth += 1
        elif text[i] == "{":
            depth -= 1
            if depth == 0:
                start = i
                break

    if depth != 0:
        raise json.JSONDecodeError("Unmatched braces", text, 0)

    text = text[start:end + 1]
    return json.loads(text)


def _fallback_parse(user_input: str) -> ParsedIntent:
    """
    Basic regex-based fallback parser when the LLM is unavailable.

    Extracts origin/destination by looking for ICAO-like patterns (4 uppercase letters)
    and common keywords. Also detects SID/STAR procedure mentions.
    """
    intent = ParsedIntent(confidence=0.3)
    upper = user_input.upper()

    # Look for ICAO codes (4 uppercase letters)
    icao_pattern = re.findall(r'\b([A-Z]{4})\b', upper)
    if len(icao_pattern) >= 2:
        intent.origin = icao_pattern[0]
        intent.destination = icao_pattern[1]
    elif len(icao_pattern) == 1:
        intent.origin = icao_pattern[0]

    # Detect airway type preference
    if any(kw in upper for kw in ["HIGH", "UPPER", "JET"]):
        intent.airway_type = "J"
    elif any(kw in upper for kw in ["LOW", "LOWER", "VICTOR"]):
        intent.airway_type = "V"

    # Detect avoidance
    avoid_match = re.findall(r'avoid\s+(\w+)', user_input.lower())
    if avoid_match:
        intent.avoid_waypoints = [w.upper() for w in avoid_match if len(w) >= 3]

    # Detect cruise altitude (FLxxx or xxxxx feet)
    alt_match = re.search(r'(?:FL|flight level)\s*(\d{3})', upper)
    if alt_match:
        intent.cruise_altitude = int(alt_match.group(1)) * 100
    else:
        alt_match = re.search(r'(\d{5})\s*(?:ft|feet)', upper)
        if alt_match:
            intent.cruise_altitude = int(alt_match.group(1))

    # --- SID/STAR procedure detection ---
    # Procedure names: 3-4 letters + 1 digit + optional letter (e.g., RAME1C, BEKO3A)
    # Pattern: keyword (SID/STAR/departure/arrival) near a procedure name
    PROC_NAME = r'([A-Z]{3,4}\d[A-Z]?)'

    # Forward patterns: keyword BEFORE name (e.g., "SID RAME1C", "departure OCE1A")
    _detect_sid_forward(intent, upper, PROC_NAME)
    # Reverse patterns: name BEFORE keyword (e.g., "RAME1C SID", "OCE1A departure")
    _detect_sid_reverse(intent, upper, PROC_NAME)
    # Via patterns: "via PROC_NAME" in departure context
    _detect_via_proc(intent, upper, PROC_NAME)

    _detect_star_forward(intent, upper, PROC_NAME)
    _detect_star_reverse(intent, upper, PROC_NAME)

    if intent.origin and intent.destination:
        intent.confidence = 0.5

    return intent


def _detect_sid_forward(intent: ParsedIntent, upper: str, proc_pat: str):
    """Detect SID: keyword BEFORE name (e.g., 'SID RAME1C', 'departure BEKO3A', '離場走 RAME1C')."""
    m = re.search(r'(?:SID|DEPART(?:URE)?|離場(?:走)?)\s*(?:VIA\s+)?' + proc_pat, upper)
    if m:
        intent.prefer_sid = m.group(1)


def _detect_sid_reverse(intent: ParsedIntent, upper: str, proc_pat: str):
    """Detect SID: name BEFORE keyword (e.g., 'RAME1C SID', 'OCE1A departure')."""
    if intent.prefer_sid:
        return
    m = re.search(proc_pat + r'\s*(?:DEPARTURE|SID|離場)', upper)
    if m:
        intent.prefer_sid = m.group(1)


def _detect_via_proc(intent: ParsedIntent, upper: str, proc_pat: str):
    """Detect procedure via 'via PROC_NAME' in departure/arrival context."""
    for m in re.finditer(r'VIA\s+' + proc_pat, upper):
        proc_name = m.group(1)
        pos = m.start()
        before = upper[:pos]

        # Find the closest departure/arrival keyword before this via
        dep_keywords = ['DEPART', 'SID', 'TAKEOFF', '離場', '出發']
        arr_keywords = ['ARRIVE', 'STAR', 'LAND', '進場', '进场', '到達']

        # Find last positions of departure and arrival keywords in 'before'
        last_dep_pos = -1
        for kw in dep_keywords:
            idx = before.rfind(kw)
            if idx > last_dep_pos:
                last_dep_pos = idx

        last_arr_pos = -1
        for kw in arr_keywords:
            idx = before.rfind(kw)
            if idx > last_arr_pos:
                last_arr_pos = idx

        # Closest keyword determines the procedure type
        if last_dep_pos > last_arr_pos and last_dep_pos >= 0:
            if not intent.prefer_sid:
                intent.prefer_sid = proc_name
        elif last_arr_pos > last_dep_pos and last_arr_pos >= 0:
            if not intent.prefer_star:
                if not intent.prefer_sid or proc_name != intent.prefer_sid:
                    intent.prefer_star = proc_name


def _detect_star_forward(intent: ParsedIntent, upper: str, proc_pat: str):
    """Detect STAR: keyword BEFORE name (e.g., 'STAR SIER7A', 'arrival ABEY3A', '進場走 SIER7A')."""
    m = re.search(r'(?:STAR|ARRIV(?:AL|E)?|進場(?:走)?)\s*(?:VIA\s+)?' + proc_pat, upper)
    if not m:
        return
    name = m.group(1)
    if not intent.prefer_sid or name != intent.prefer_sid:
        intent.prefer_star = name


def _detect_star_reverse(intent: ParsedIntent, upper: str, proc_pat: str):
    """Detect STAR: name BEFORE keyword (e.g., 'SIER7A STAR', 'ABEY3A arrival')."""
    if intent.prefer_star:
        return
    m = re.search(proc_pat + r'\s*(?:ARRIVAL|STAR|進場|进场)', upper)
    if not m:
        return
    name = m.group(1)
    if not intent.prefer_sid or name != intent.prefer_sid:
        intent.prefer_star = name
