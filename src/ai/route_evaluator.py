"""
Route Evaluator — uses LLM to rank K candidate routes by quality.

Given K shortest-path candidates and user preferences, the LLM scores
each route 1-10 and returns the best index.
"""
import json
import logging

from src.ai.llm_client import llm_chat, build_llm_config
from src.ai.prompt_templates import build_evaluator_prompt
from src.route.models import RouteCandidate

logger = logging.getLogger(__name__)


async def evaluate_routes(
    origin: str,
    destination: str,
    candidates: list[RouteCandidate],
    user_preferences: str = "",
    llm_config: dict | None = None,
) -> tuple[int | None, list[dict]]:
    """
    Ask the LLM to rank K candidate routes and return the best one.

    Args:
        origin: Origin airport ICAO.
        destination: Destination airport ICAO.
        candidates: List of RouteCandidate objects from the search engine.
        user_preferences: Natural language user constraints/preferences.
        llm_config: Optional LLM configuration override.

    Returns:
        (best_index, rankings) where best_index is the index of the top-ranked
        route (or None if evaluation fails), and rankings is the full list of
        {index, score, reason} dicts.
    """
    if not candidates:
        return None, []

    # Build candidate summaries for the prompt
    summaries = []
    for c in candidates:
        summaries.append({
            "index": c.index,
            "route_string": c.route_string,
            "distance_nm": c.total_distance_nm,
            "segment_count": len(c.segments),
        })

    cfg = build_llm_config(llm_config)
    messages = build_evaluator_prompt(
        origin=origin,
        destination=destination,
        candidates=summaries,
        user_preferences=user_preferences,
    )

    try:
        raw_response = await llm_chat(messages, llm_cfg=cfg)
        logger.debug(f"Evaluator raw response: {raw_response}")

        parsed = _extract_json(raw_response)
        rankings = parsed.get("rankings", [])
        best_index = parsed.get("best_index", 0)

        # Validate best_index
        if not isinstance(best_index, int) or best_index < 0 or best_index >= len(candidates):
            best_index = 0

        # Apply scores to candidates
        for ranking in rankings:
            idx = ranking.get("index", 0)
            score = ranking.get("score")
            reason = ranking.get("reason", "")
            if 0 <= idx < len(candidates):
                candidates[idx].score = score
                candidates[idx].eval_reason = reason

        return best_index, rankings

    except Exception as e:
        logger.warning(f"Route evaluation failed ({e}), returning unsorted candidates")
        # Fallback: return candidates as-is (they're already sorted by distance)
        return 0, [
            {"index": c.index, "score": None, "reason": "Evaluation unavailable — routes sorted by distance"}
            for c in candidates
        ]


def _extract_json(text: str) -> dict:
    """Extract a JSON object from LLM output, handling markdown wrapping."""
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]

    return json.loads(text)
