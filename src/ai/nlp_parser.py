"""
NLP Parser — converts natural language routing requests into structured parameters.

Uses the LLM to extract origin/destination airports, airway preferences,
waypoint/airspace avoidance, and cruise altitude from free-text input.
"""
import json
import logging

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
            confidence=float(parsed.get("confidence", 0.0)),
        )

    except Exception as e:
        logger.warning(f"LLM parsing failed ({e}), falling back to regex")
        return _fallback_parse(user_input)


def _extract_json(text: str) -> dict:
    """
    Extract a JSON object from LLM output, handling markdown code blocks.
    """
    text = text.strip()

    # Remove markdown code fences
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first line (```json or ```) and last line (```)
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    # Find the first { and last }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]

    return json.loads(text)


def _fallback_parse(user_input: str) -> ParsedIntent:
    """
    Basic regex-based fallback parser when the LLM is unavailable.

    Extracts origin/destination by looking for ICAO-like patterns (4 uppercase letters)
    and common keywords.
    """
    import re

    intent = ParsedIntent(confidence=0.3)

    # Look for ICAO codes (4 uppercase letters)
    icao_pattern = re.findall(r'\b([A-Z]{4})\b', user_input.upper())
    if len(icao_pattern) >= 2:
        intent.origin = icao_pattern[0]
        intent.destination = icao_pattern[1]
    elif len(icao_pattern) == 1:
        intent.origin = icao_pattern[0]

    # Detect airway type preference
    upper = user_input.upper()
    if any(kw in upper for kw in ["HIGH", "UPPER", "JET", "高空", "高層"]):
        intent.airway_type = "J"
    elif any(kw in upper for kw in ["LOW", "LOWER", "VICTOR", "低空", "低層"]):
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

    if intent.origin and intent.destination:
        intent.confidence = 0.5

    return intent
