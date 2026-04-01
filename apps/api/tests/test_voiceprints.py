from __future__ import annotations

from sqlalchemy.orm import Session

from app.models import VoiceprintFeature
from app.services.voiceprints import blind_recognize_speaker, build_voiceprint_auth_preview


def _profile() -> dict:
    return {
        "id": "voice-stt",
        "app_id": "xfyun-app",
        "api_key": "xfyun-key",
        "api_secret": "xfyun-secret",
        "voiceprint": {
            "enabled": True,
            "provider_kind": "xfyun_isv",
            "api_base": "https://api.xf-yun.com",
            "group_id": "meeting_group",
            "score_threshold": 0.8,
            "top_k": 3,
        },
    }


def test_build_voiceprint_auth_preview_includes_expected_fields() -> None:
    preview = build_voiceprint_auth_preview(
        "https://api.xf-yun.com/v1/private/s782b4996",
        api_key="voiceprint-key",
        api_secret="voiceprint-secret",
        date_header="Fri, 23 Apr 2021 02:35:47 GMT",
    )
    assert preview["host"] == "api.xf-yun.com"
    assert preview["authorization"]
    assert "authorization=" in preview["signed_url"]


def test_blind_recognize_speaker_uses_registered_label_when_score_passes_threshold(
    session_factory,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.voiceprints.search_feature_remote",
        lambda config, pcm_s16le_base64, sample_rate, channel_count: {
            "scoreList": [{"featureId": "feature_alice", "featureInfo": "Alice remote", "score": 0.93}]
        },
    )

    with session_factory() as db:
        db: Session
        db.add(
            VoiceprintFeature(
                stt_profile_id="voice-stt",
                group_id="meeting_group",
                feature_id="feature_alice",
                speaker_label="Alice",
                feature_info="Alice local",
                status="active",
                remote_payload={},
            )
        )
        db.commit()

        result = blind_recognize_speaker(
            db,
            stt_profile_id="voice-stt",
            profile=_profile(),
            pcm_s16le_base64="AAA=",
            sample_rate=16000,
            channel_count=1,
            fallback_speaker="speaker",
        )

    assert result is not None
    assert result["matched"] is True
    assert result["speaker_label"] == "Alice"
    assert result["feature_id"] == "feature_alice"


def test_blind_recognize_speaker_falls_back_when_score_is_too_low(
    session_factory,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "app.services.voiceprints.search_feature_remote",
        lambda config, pcm_s16le_base64, sample_rate, channel_count: {
            "scoreList": [{"featureId": "feature_bob", "featureInfo": "Bob remote", "score": 0.41}]
        },
    )

    with session_factory() as db:
        result = blind_recognize_speaker(
            db,
            stt_profile_id="voice-stt",
            profile=_profile(),
            pcm_s16le_base64="AAA=",
            sample_rate=16000,
            channel_count=1,
            fallback_speaker="speaker",
        )

    assert result is not None
    assert result["matched"] is False
    assert result["speaker_label"] == "speaker"
