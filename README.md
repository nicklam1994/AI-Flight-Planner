# AI Flight Planner

Natural language flight route planning powered by LLM + real Navigraph data.

**AI Flight Planner** takes a free-text routing request (e.g., "VHHH to RJTT, high altitude airways") and returns ATS route strings using:

- **K-shortest paths** (NetworkX Yen's algorithm) through real airway data
- **Dual LLM calls**: NLP parsing (NL → structured intent) + route evaluation (ranking candidates)
- **LNM Navigraph SQLite** database for real-world waypoints, airways, and airports

## Quick Start

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Set up database
# Place your Little Navmap Navigraph databases under data/cycles/:
#   data/cycles/2602/little_navmap_navigraph.sqlite
#   data/cycles/2604/little_navmap_navigraph.sqlite
# Or set DB_PATH in .env to point directly to a .sqlite file.

# 3. Configure LLM (optional — can be set from the web UI)
cp .env.example .env
# Edit .env if you need to customize defaults.

# 4. Start the server
python -m uvicorn src.api.app:app --host 0.0.0.0 --port 8000

# 5. Open http://localhost:8000
```

## Project Structure

```
src/
├── config.py              # Configuration (env vars, AIRAC cycles)
├── api/
│   ├── app.py             # FastAPI app, graph lifecycle
│   ├── routes.py          # REST endpoints (/api/plan, /api/cycles, etc.)
│   └── schemas.py         # Pydantic request/response models
├── db/
│   ├── connection.py      # SQLite connection manager
│   ├── airport.py         # Airport queries (ICAO/IATA/name search)
│   └── graph_builder.py   # NetworkX airway graph builder
├── route/
│   ├── models.py          # Route data models
│   ├── graph_search.py    # K-shortest paths (Yen's algorithm)
│   └── airport_connector.py  # Airport → nearest airway node connector
├── ai/
│   ├── llm_client.py      # LLM abstraction (Ollama/OpenAI/DeepSeek)
│   ├── nlp_parser.py      # NL → structured intent (LLM + regex fallback)
│   ├── route_evaluator.py # Route ranking via LLM
│   └── prompt_templates.py # System prompts for LLM calls
static/
├── index.html             # Single-page frontend
├── css/style.css           # Dark theme styles
└── js/
    ├── app.js             # Main app logic
    ├── api.js             # Backend API client
    └── settings.js        # LLM settings (localStorage)
data/cycles/               # AIRAC cycle databases
├── 2602/                  # Cycle 2602 (valid FEB–MAR 2026)
└── 2604/                  # Cycle 2604 (valid APR–MAY 2026)
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service health, graph stats, AIRAC cycle |
| GET | `/api/cycles` | List available AIRAC cycles |
| POST | `/api/plan` | Plan a flight route (NL input → ATS route) |
| GET | `/api/airports?q=...` | Airport autocomplete |
| GET | `/api/waypoints?q=...` | Waypoint autocomplete |

## LLM Configuration

The frontend includes a settings panel (⚙️) where you can configure:

- **Provider**: Ollama, OpenAI, DeepSeek, or custom OpenAI-compatible
- **Base URL** + **Model** + **API Key**
- **Temperature** (0.0–1.0)

Settings persist in browser localStorage. Defaults:

```
Provider:  ollama
Base URL:  http://localhost:11434/v1
Model:     qwen3.5:9b-agent
API Key:   ollama
```

## License

MIT
