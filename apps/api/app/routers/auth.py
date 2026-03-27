from __future__ import annotations

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.config import get_settings
from app.models import AdminUser
from app.schemas import AdminIdentity, AdminLoginRequest
from app.security import decode_session, encode_session, verify_password


COOKIE_NAME = "s2g_admin_session"
router = APIRouter(prefix="/auth", tags=["auth"])


def _request_scheme(request: Request) -> str:
    forwarded_proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    if forwarded_proto:
        return forwarded_proto
    return request.url.scheme.lower()


def _request_host(request: Request) -> str:
    forwarded_host = request.headers.get("x-forwarded-host", "").split(",")[0].strip().lower()
    host = forwarded_host or request.headers.get("host", "")
    return host.split(":")[0].strip().lower()


def _is_local_host(host: str) -> bool:
    return host in {"127.0.0.1", "localhost"} or host.endswith(".local")


def _cookie_options(request: Request) -> dict[str, object]:
    settings = get_settings()
    host = _request_host(request)
    scheme = _request_scheme(request)
    is_local = _is_local_host(host)
    secure = bool(settings.cookie_secure and scheme == "https" and not is_local)
    domain = settings.cookie_domain or None
    if is_local:
        domain = None
    return {
        "httponly": True,
        "samesite": settings.cookie_samesite,
        "secure": secure,
        "domain": domain,
        "max_age": 60 * 60 * 12,
        "path": "/",
    }


def get_current_admin(
    db: Session = Depends(get_db),
    session_token: str | None = Cookie(default=None, alias=COOKIE_NAME),
) -> AdminUser:
    if not session_token:
        raise HTTPException(status_code=401, detail="not authenticated")
    payload = decode_session(session_token)
    if payload is None:
        raise HTTPException(status_code=401, detail="invalid session")
    user = db.scalar(select(AdminUser).where(AdminUser.username == payload.get("username")))
    if user is None:
        raise HTTPException(status_code=401, detail="admin user not found")
    return user


@router.post("/login", response_model=AdminIdentity)
def login(
    payload: AdminLoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> AdminIdentity:
    user = db.scalar(select(AdminUser).where(AdminUser.username == payload.username))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    token = encode_session({"username": user.username})
    response.set_cookie(COOKIE_NAME, token, **_cookie_options(request))
    return AdminIdentity(username=user.username, display_name=user.display_name)


@router.post("/logout")
def logout(request: Request, response: Response) -> dict[str, bool]:
    cookie_options = _cookie_options(request)
    response.delete_cookie(
        COOKIE_NAME,
        domain=cookie_options["domain"],
        path="/",
        secure=bool(cookie_options["secure"]),
        httponly=True,
        samesite=str(cookie_options["samesite"]),
    )
    return {"ok": True}


@router.get("/me", response_model=AdminIdentity)
def me(
    db: Session = Depends(get_db),
    session_token: str | None = Cookie(default=None, alias=COOKIE_NAME),
) -> AdminIdentity:
    user = get_current_admin(db=db, session_token=session_token)
    return AdminIdentity(username=user.username, display_name=user.display_name)
