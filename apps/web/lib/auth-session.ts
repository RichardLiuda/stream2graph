"use client";

const AUTH_PENDING_KEY = "s2g:auth-pending-at";
const AUTH_PENDING_TTL_MS = 12_000;

function now() {
  return Date.now();
}

export function markAuthPending() {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(AUTH_PENDING_KEY, String(now()));
}

export function clearAuthPending() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(AUTH_PENDING_KEY);
}

export function getAuthPendingAgeMs() {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(AUTH_PENDING_KEY);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    clearAuthPending();
    return null;
  }
  const age = now() - value;
  if (age > AUTH_PENDING_TTL_MS) {
    clearAuthPending();
    return null;
  }
  return age;
}

export function hasRecentAuthPending() {
  return getAuthPendingAgeMs() !== null;
}
