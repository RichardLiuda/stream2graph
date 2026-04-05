#!/bin/bash
set -e

echo "等待 PostgreSQL 启动..."
until pg_isready -h postgres -U ${POSTGRES_USER:-stream2graph}; do
  echo "PostgreSQL 未就绪 - 等待中..."
  sleep 2
done

echo "PostgreSQL 已就绪！"

echo "运行数据库迁移..."
alembic upgrade head

echo "启动 API 服务..."
exec uvicorn app.main:app --host 0.0.0.0 --port 8000
