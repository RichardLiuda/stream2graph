from __future__ import annotations

import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from app.config import get_settings
from app.db import Base, engine, session_scope
from app.models import AdminUser
from app.routers import auth, catalog, realtime, reports, runs, studies, voiceprints
from app.security import hash_password, verify_password
from app.services.catalog import sync_dataset_versions
from app.services.runs import process_next_queued_job

def _bootstrap_admin() -> None:
    settings = get_settings()
    with session_scope() as db:
        user = db.scalar(select(AdminUser).where(AdminUser.username == settings.admin_username))
        if user is None:
            db.add(
                AdminUser(
                    username=settings.admin_username,
                    password_hash=hash_password(settings.admin_password),
                    display_name=settings.admin_display_name,
                )
            )
        else:
            updated = False
            if not verify_password(settings.admin_password, user.password_hash):
                user.password_hash = hash_password(settings.admin_password)
                updated = True
            if user.display_name != settings.admin_display_name:
                user.display_name = settings.admin_display_name
                updated = True
            if updated:
                db.add(user)
        sync_dataset_versions(db)


def _inline_worker_loop() -> None:
    settings = get_settings()
    while True:
        try:
            process_next_queued_job()
        except Exception:
            pass
        time.sleep(settings.inline_worker_poll_interval)


def create_app(*, register_startup: bool = True) -> FastAPI:
    settings = get_settings()

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if register_startup:
            Base.metadata.create_all(bind=engine)
            _bootstrap_admin()
            if settings.inline_worker:
                thread = threading.Thread(target=_inline_worker_loop, daemon=True, name="s2g-inline-worker")
                thread.start()
        yield

    app = FastAPI(title=settings.app_name, version="0.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.cors_origin_regex or None,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health() -> dict[str, object]:
        return {
            "ok": True,
            "service": settings.app_name,
            "default_dataset_version": settings.default_dataset_version,
            "artifact_root": str(settings.artifact_root),
        }

    app.include_router(auth.router, prefix=settings.api_v1_prefix)
    app.include_router(catalog.router, prefix=settings.api_v1_prefix)
    app.include_router(realtime.router, prefix=settings.api_v1_prefix)
    app.include_router(voiceprints.router, prefix=settings.api_v1_prefix)
    app.include_router(runs.router, prefix=settings.api_v1_prefix)
    app.include_router(studies.router, prefix=settings.api_v1_prefix)
    app.include_router(reports.router, prefix=settings.api_v1_prefix)
    return app


app = create_app()
