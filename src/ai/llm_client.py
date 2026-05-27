"""
LLM abstraction layer — supports Ollama, OpenAI-compatible, and DeepSeek APIs.

Settings can come from:
  1. Environment variables (LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL, LLM_API_KEY)
  2. Per-request overrides from the frontend (llm_config dict)
"""
import json
import logging
from dataclasses import dataclass

import httpx

from src.config import config

logger = logging.getLogger(__name__)


@dataclass
class LLMConfig:
    """LLM connection settings."""
    provider: str = "ollama"
    base_url: str = "http://localhost:11434/v1"
    model: str = "qwen3.5:9b-agent"
    api_key: str = "ollama"
    temperature: float = 0.3
    max_tokens: int = 2000
    timeout: float = 30.0


def build_llm_config(request_config: dict | None = None) -> LLMConfig:
    """
    Build an LLMConfig from request overrides merged with server defaults.

    Priority: request_config > environment variables > hardcoded defaults.
    """
    rc = request_config or {}
    return LLMConfig(
        provider=rc.get("provider", config.llm_provider),
        base_url=rc.get("base_url", config.llm_base_url),
        model=rc.get("model", config.llm_model),
        api_key=rc.get("api_key", config.llm_api_key),
        temperature=float(rc.get("temperature", config.llm_temperature)),
        max_tokens=int(rc.get("max_tokens", config.llm_max_tokens)),
        timeout=float(rc.get("timeout", config.llm_timeout)),
    )


async def llm_chat(
    messages: list[dict[str, str]],
    llm_cfg: LLMConfig | None = None,
    request_config: dict | None = None,
) -> str:
    """
    Send a chat completion request to the LLM and return the response text.

    Args:
        messages: List of {"role": "system"|"user"|"assistant", "content": "..."}
        llm_cfg: Pre-built LLMConfig (takes precedence over request_config).
        request_config: Raw dict from frontend, used if llm_cfg is None.

    Returns:
        The assistant's response text.

    Raises:
        httpx.HTTPError: On network/API errors.
        json.JSONDecodeError: If the response is not valid JSON.
        KeyError: If the response structure is unexpected.
    """
    cfg = llm_cfg or build_llm_config(request_config)

    # Normalize the endpoint — Ollama and OpenAI-compatible both use /chat/completions
    base = cfg.base_url.rstrip("/")
    if not base.endswith("/chat/completions"):
        endpoint = f"{base}/chat/completions"
    else:
        endpoint = base

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg.api_key}",
    }

    payload = {
        "model": cfg.model,
        "messages": messages,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
    }

    logger.info(f"LLM request: {cfg.provider}/{cfg.model} @ {endpoint}")
    logger.debug(f"LLM messages: {json.dumps(messages, ensure_ascii=False)[:500]}")

    async with httpx.AsyncClient(timeout=cfg.timeout) as client:
        response = await client.post(endpoint, json=payload, headers=headers)
        response.raise_for_status()
        data = response.json()

    # Handle different response formats
    # OpenAI-compatible: {"choices": [{"message": {"content": "..."}}]}
    # Some providers: {"response": "..."} or {"content": "..."}
    if "choices" in data and len(data["choices"]) > 0:
        msg = data["choices"][0]["message"]
        content = msg.get("content", "")
        # Some models (e.g., qwen3.5:9b-agent) put response in "reasoning" field
        # while "content" is empty. Fall back to reasoning if content is empty.
        if not content and "reasoning" in msg and msg["reasoning"]:
            content = msg["reasoning"]
        return content
    elif "response" in data:
        return data["response"]
    elif "content" in data:
        return data["content"]
    else:
        raise KeyError(f"Unexpected LLM response structure: {list(data.keys())}")
