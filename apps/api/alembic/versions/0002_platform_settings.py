"""add platform settings table

Revision ID: 0002_platform_settings
Revises: 0001_initial_platform
Create Date: 2026-03-26 11:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "0002_platform_settings"
down_revision = "0001_initial_platform"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "platform_settings",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("setting_key", sa.String(length=128), nullable=False, unique=True),
        sa.Column("value_json", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("platform_settings")
