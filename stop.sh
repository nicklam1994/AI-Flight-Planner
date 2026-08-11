#!/bin/bash
# AI Flight Planner 停止腳本

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT=8080
PID_FILE="logs/server.pid"

# 先嘗試從 PID 文件停止
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo -e "${GREEN}終止進程 $PID (端口 $PORT)...${NC}"
        kill "$PID" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
        rm -f "$PID_FILE"
        echo -e "${GREEN}✓ 服務已停止${NC}"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# Fallback: 按端口查找
PID=$(lsof -ti:$PORT 2>/dev/null || true)
if [ -z "$PID" ]; then
    echo -e "${YELLOW}端口 $PORT 沒有運行的進程${NC}"
    exit 0
fi

echo -e "${GREEN}終止進程 $PID (端口 $PORT)...${NC}"
kill -9 "$PID" 2>/dev/null || true
echo -e "${GREEN}✓ 服務已停止${NC}"
