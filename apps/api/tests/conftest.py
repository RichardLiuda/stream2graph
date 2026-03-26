from __future__ import annotations

from collections.abc import Generator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import Settings
from app.db import Base, get_db
from app.main import create_app
from app.models import AdminUser
from app.security import hash_password


def _build_test_client(session_factory: sessionmaker[Session]) -> TestClient:
    app = create_app(register_startup=False)

    def override_get_db() -> Generator[Session, None, None]:
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app, base_url="https://testserver")


@pytest.fixture()
def artifact_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "artifacts"
    monkeypatch.setattr(Settings, "artifact_root", property(lambda self: path), raising=False)
    return path


@pytest.fixture()
def session_factory(
    artifact_root: Path,
) -> Generator[sessionmaker[Session], None, None]:
    engine = create_engine(
        "sqlite://",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    testing_session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    Base.metadata.create_all(bind=engine)

    with testing_session_factory() as db:
        db.add(
            AdminUser(
                username="admin",
                password_hash=hash_password("admin123456"),
                display_name="Test Admin",
            )
        )
        db.commit()

    try:
        yield testing_session_factory
    finally:
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


@pytest.fixture()
def client(session_factory: sessionmaker[Session]) -> Generator[TestClient, None, None]:
    with _build_test_client(session_factory) as test_client:
        yield test_client


@pytest.fixture()
def admin_client(session_factory: sessionmaker[Session]) -> Generator[TestClient, None, None]:
    with _build_test_client(session_factory) as test_client:
        response = test_client.post(
            "/api/v1/auth/login",
            json={"username": "admin", "password": "admin123456"},
        )
        assert response.status_code == 200
        yield test_client
