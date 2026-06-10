"""add notes column to reports

Revision ID: 0008_report_notes
Revises: 0007_realtime_session_annotations
Create Date: 2026-06-09

"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0008_report_notes"
down_revision = "0007_session_annotations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("reports", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("reports", "notes")
