#!/bin/bash
#
# Rows chosen to exercise the renderer and the limit rewrite, not to look real:
# a NULL, a string that reads as the word NULL, a wide character, and numbers of
# different lengths so a right-aligned column has something to align.
#
# Batches are separated by GO and fed on stdin rather than passed with -Q,
# because T-SQL requires CREATE SCHEMA and CREATE VIEW to be the first statement
# in their batch — one -Q with both is a syntax error, which is how this was
# found.
set -eu

SQL=/opt/mssql-tools18/bin/sqlcmd
PASSWORD="${MSSQL_SA_PASSWORD:?}"

# -C trusts the self-signed certificate the container generated for itself.
for _ in $(seq 1 60); do
  if "$SQL" -S localhost -U sa -P "$PASSWORD" -C -Q 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 2
done

"$SQL" -S localhost -U sa -P "$PASSWORD" -C -b <<'BATCHES'
-- Idempotent, so a rerun against a container that is still up works. The
-- harness keeps no volumes, so in a clean run there is nothing to drop.
IF DB_ID('analytics') IS NOT NULL
BEGIN
  ALTER DATABASE analytics SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
  DROP DATABASE analytics;
END
GO
CREATE DATABASE analytics;
GO
USE analytics;
GO
CREATE SCHEMA reporting;
GO
CREATE TABLE dbo.events (
  day   DATE          NOT NULL,
  kind  NVARCHAR(32)  NULL,
  hits  BIGINT        NOT NULL,
  note  NVARCHAR(300) NULL
);
CREATE TABLE reporting.users (
  id    INT           NOT NULL PRIMARY KEY,
  email NVARCHAR(120) NOT NULL
);
INSERT INTO dbo.events (day, kind, hits, note) VALUES
  ('2026-09-16', N'click',   84210, N'ordinary'),
  ('2026-09-15', N'view',   102993, NULL),
  ('2026-09-14', N'NULL',        7, N'日本語のテキスト'),
  ('2026-09-13', N'scroll',      0, REPLICATE(N'x', 300));
INSERT INTO reporting.users (id, email) VALUES
  (1, N'someone@example.com'),
  (2, N'other@example.com');
GO
CREATE VIEW dbo.busy AS SELECT day, hits FROM dbo.events WHERE hits > 100;
GO
BATCHES

echo "seeded"
