#!/bin/bash
# AI Flight Planner 停止腳本

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

PORT=8080
PID=$(lsof -ti:$PORT 2>/dev/null || true)

if [ -z "$PID" ]; then
    echo -e "${YELLOW}端口 $PORT 沒有運行的進程${NC}"
    exit 0
fi

echo -e "${GREEN}終止進程 $PID (端口 $PORT)...${NC}"
kill -9 $PID 2>/dev/null || true
echo -e "${GREEN}服務已停止${NC}"
