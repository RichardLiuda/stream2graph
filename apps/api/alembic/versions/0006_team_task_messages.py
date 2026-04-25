"""bridge missing 0006_team_task_messages

This repository previously had a migration with revision id `0006_team_task_messages`,
and some developer databases may already be stamped to that revision.

If the revision file is missing, Alembic cannot resolve the current DB version and
all subsequent `upgrade head` operations fail.

This migration is a no-op bridge to restore a valid migration graph.
Future migrations should use this revision as their `down_revision`.
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "0006_team_task_messages"
down_revision = "0003_voiceprint_tables"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Intentionally no-op.
    pass


def downgrade() -> None:
    # Intentionally no-op.
    pass

