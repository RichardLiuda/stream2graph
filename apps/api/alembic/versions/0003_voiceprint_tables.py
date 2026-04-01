"""add voiceprint persistence tables

Revision ID: 0003_voiceprint_tables
Revises: 0002_platform_settings
Create Date: 2026-03-30 12:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0003_voiceprint_tables"
down_revision = "0002_platform_settings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "voiceprint_groups",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("stt_profile_id", sa.String(length=64), nullable=False, unique=True),
        sa.Column("group_id", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=255), nullable=False),
        sa.Column("provider_kind", sa.String(length=64), nullable=False, server_default="xfyun_isv"),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("remote_payload", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_voiceprint_groups_group_id", "voiceprint_groups", ["group_id"])

    op.create_table(
        "voiceprint_features",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("stt_profile_id", sa.String(length=64), nullable=False),
        sa.Column("group_id", sa.String(length=64), nullable=False),
        sa.Column("feature_id", sa.String(length=64), nullable=False),
        sa.Column("speaker_label", sa.String(length=255), nullable=False),
        sa.Column("feature_info", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="active"),
        sa.Column("remote_payload", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("stt_profile_id", "feature_id", name="uq_voiceprint_features_profile_feature"),
    )
    op.create_index("ix_voiceprint_features_profile", "voiceprint_features", ["stt_profile_id"])
    op.create_index("ix_voiceprint_features_group", "voiceprint_features", ["group_id"])
    op.create_index("ix_voiceprint_features_feature", "voiceprint_features", ["feature_id"])


def downgrade() -> None:
    op.drop_index("ix_voiceprint_features_feature", table_name="voiceprint_features")
    op.drop_index("ix_voiceprint_features_group", table_name="voiceprint_features")
    op.drop_index("ix_voiceprint_features_profile", table_name="voiceprint_features")
    op.drop_table("voiceprint_features")
    op.drop_index("ix_voiceprint_groups_group_id", table_name="voiceprint_groups")
    op.drop_table("voiceprint_groups")
