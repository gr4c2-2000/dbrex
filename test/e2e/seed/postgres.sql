-- The same rows as seed/mysql.sql, for the same reason: a NULL, a string that
-- reads as the word NULL, a wide character, a value longer than any terminal.
-- Plus the two things only this provider has to get right — a schema that is
-- not `public`, and a materialized view, which `information_schema` does not
-- list at all.
CREATE TABLE events (
  day    DATE         NOT NULL,
  kind   VARCHAR(32),
  hits   BIGINT       NOT NULL,
  note   VARCHAR(300)
);

INSERT INTO events (day, kind, hits, note) VALUES
  ('2026-09-16', 'click',  84210, 'ordinary'),
  ('2026-09-15', 'view',  102993, NULL),
  ('2026-09-14', 'NULL',       7, '日本語のテキスト'),
  ('2026-09-13', 'scroll',     0, repeat('x', 300));

CREATE TABLE users (
  id    INT PRIMARY KEY,
  email VARCHAR(120) NOT NULL
);

INSERT INTO users (id, email) VALUES
  (1, 'someone@example.com'),
  (2, 'other@example.com');

CREATE SCHEMA reporting;

CREATE VIEW reporting.daily AS
  SELECT day, sum(hits) AS hits FROM events GROUP BY day;

CREATE MATERIALIZED VIEW reporting.totals AS
  SELECT kind, sum(hits) AS hits FROM events GROUP BY kind;
