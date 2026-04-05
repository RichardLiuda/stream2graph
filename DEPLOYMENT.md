# Stream2Graph 部署指南

## 服务器要求

- Debian/Ubuntu 系统
- Docker 和 Docker Compose 已安装
- 至少 2GB RAM
- 至少 10GB 磁盘空间

## 快速部署步骤

### 1. 准备服务器

确保 Docker 和 Docker Compose 已安装：

```bash
docker --version
docker compose version
```

### 2. 上传代码到服务器

```bash
# 在本地打包代码
cd /Users/richardliu/Documents/Coding/Stream2Graph/stream2graph
tar -czf stream2graph.tar.gz \
  --exclude=node_modules \
  --exclude=.next \
  --exclude=.venv-platform \
  --exclude=var \
  --exclude=versions \
  .

# 上传到服务器
scp stream2graph.tar.gz user@your-server:/opt/

# 在服务器上解压
ssh user@your-server
cd /opt
tar -xzf stream2graph.tar.gz
mv stream2graph stream2graph-app
cd stream2graph-app
```

### 3. 配置环境变量

```bash
# 复制并编辑生产环境配置
cp .env.production .env

# 编辑 .env 文件，修改以下关键配置：
nano .env
```

必须修改的配置项：
- `POSTGRES_PASSWORD`: 设置强密码
- `S2G_SESSION_SECRET`: 生成随机字符串（可用 `openssl rand -hex 32`）
- `S2G_ADMIN_PASSWORD`: 设置管理员密码
- `S2G_CORS_ORIGINS`: 设置你的域名
- `NEXT_PUBLIC_API_BASE_URL`: 设置你的 API 地址
- `NEXT_PUBLIC_AUDIO_HELPER_BASE_URL`: 设置你的 Audio Helper 地址

### 4. 构建并启动服务

```bash
# 构建镜像
docker compose build

# 启动所有服务
docker compose up -d

# 查看服务状态
docker compose ps

# 查看日志
docker compose logs -f
```

### 5. 验证部署

```bash
# 检查 PostgreSQL
docker compose exec postgres psql -U stream2graph -c "SELECT version();"

# 检查 API
curl http://localhost:8000/health

# 检查 Web
curl http://localhost:3000
```

## 服务管理

### 启动服务
```bash
docker compose up -d
```

### 停止服务
```bash
docker compose down
```

### 重启服务
```bash
docker compose restart
```

### 查看日志
```bash
# 所有服务
docker compose logs -f

# 特定服务
docker compose logs -f api
docker compose logs -f web
docker compose logs -f postgres
```

### 更新代码
```bash
# 拉取最新代码
git pull  # 或重新上传

# 重新构建并重启
docker compose down
docker compose build
docker compose up -d
```

## 数据库管理

### 备份数据库
```bash
docker compose exec postgres pg_dump -U stream2graph stream2graph > backup.sql
```

### 恢复数据库
```bash
docker compose exec -T postgres psql -U stream2graph stream2graph < backup.sql
```

### 运行数据库迁移
```bash
docker compose exec api alembic upgrade head
```

## 使用 Nginx 反向代理（推荐）

创建 `/etc/nginx/sites-available/stream2graph`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Web 前端
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # API 后端
    location /api/ {
        proxy_pass http://localhost:8000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Audio Helper
    location /audio/ {
        proxy_pass http://localhost:8765/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

启用配置：
```bash
sudo ln -s /etc/nginx/sites-available/stream2graph /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 使用 HTTPS（推荐）

使用 Let's Encrypt 免费证书：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## 故障排查

### 服务无法启动
```bash
# 查看详细日志
docker compose logs

# 检查端口占用
sudo netstat -tlnp | grep -E '3000|8000|8765|5432'
```

### 数据库连接失败
```bash
# 检查 PostgreSQL 是否健康
docker compose exec postgres pg_isready -U stream2graph

# 查看数据库日志
docker compose logs postgres
```

### API 无法访问
```bash
# 检查 API 容器状态
docker compose ps api

# 进入容器调试
docker compose exec api sh
```

## 性能优化

### 生产环境建议

1. 使用外部 PostgreSQL（如 RDS）以获得更好的性能和备份
2. 配置 Redis 用于会话存储和缓存
3. 使用 CDN 加速静态资源
4. 配置日志轮转避免磁盘占满
5. 设置监控和告警（如 Prometheus + Grafana）

### 资源限制

在 `docker-compose.yml` 中添加资源限制：

```yaml
services:
  api:
    deploy:
      resources:
        limits:
          cpus: '1'
          memory: 1G
```

## 安全建议

1. 修改所有默认密码
2. 使用强随机 SESSION_SECRET
3. 启用 HTTPS
4. 配置防火墙只开放必要端口
5. 定期更新 Docker 镜像
6. 定期备份数据库
7. 使用环境变量管理敏感信息，不要提交到 Git
