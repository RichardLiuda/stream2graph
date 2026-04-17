"""add realtime session annotations

Revision ID: 0007_session_annotations
Revises: 0006_team_task_messages
Create Date: 2026-04-16
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_session_annotations"
down_revision = "0006_team_task_messages"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "realtime_session_annotations",
        sa.Column("id", sa.String(length=32), primary_key=True, nullable=False),
        sa.Column("session_id", sa.String(length=32), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("payload_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'::json")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["session_id"], ["realtime_sessions.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("session_id", name="uq_realtime_session_annotations_session_id"),
    )
    op.create_index(
        "ix_realtime_session_annotations_session_id",
        "realtime_session_annotations",
        ["session_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_realtime_session_annotations_session_id", table_name="realtime_session_annotations")
    op.drop_table("realtime_session_annotations")

