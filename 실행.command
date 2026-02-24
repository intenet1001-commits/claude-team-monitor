#!/bin/bash
# Claude Team Monitor — 실행 스크립트
# 더블클릭으로 실행하세요

# 스크립트 위치로 이동
cd "$(dirname "$0")"

echo "========================================="
echo "  Claude Team Monitor"
echo "========================================="
echo ""

# node 설치 확인
if ! command -v node &> /dev/null; then
  echo "[오류] Node.js가 설치되어 있지 않습니다."
  echo "  → https://nodejs.org 에서 설치 후 다시 실행해주세요."
  echo ""
  read -p "엔터를 누르면 종료합니다..."
  exit 1
fi

# node_modules 없으면 npm install
if [ ! -d "node_modules" ]; then
  echo "[설치] 의존성 패키지를 설치합니다 (최초 1회)..."
  npm install
  echo ""
fi

# 포트 9099 이미 사용 중인지 확인
if lsof -ti:9099 &> /dev/null; then
  echo "[경고] 9099 포트가 이미 사용 중입니다."
  echo "  → 기존 프로세스를 종료하고 재시작합니다..."
  lsof -ti:9099 | xargs kill -9 2>/dev/null
  sleep 1
fi

echo "[시작] 서버를 시작합니다..."
echo ""
echo "  URL: http://localhost:9099"
echo ""
echo "  종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요."
echo "========================================="
echo ""

# 브라우저 자동 오픈 (1초 후)
sleep 1 && open "http://localhost:9099" &

# 서버 실행
PORT=9099 node server.js
