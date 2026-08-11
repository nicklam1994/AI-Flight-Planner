#!/bin/bash
# AI Flight Planner 重啟腳本

set -e

# 顏色定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${YELLOW}停止服務...${NC}"
./stop.sh

echo -e "${YELLOW}等待 1 秒...${NC}"
sleep 1

echo -e "${GREEN}啟動服務...${NC}"
./start.sh
