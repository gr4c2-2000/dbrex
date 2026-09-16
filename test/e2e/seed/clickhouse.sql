CREATE TABLE IF NOT EXISTS analytics.events (
  day  Date,
  kind String,
  hits UInt64
) ENGINE = MergeTree ORDER BY day;

INSERT INTO analytics.events VALUES
  ('2026-09-16', 'click',  84210),
  ('2026-09-15', 'view',  102993),
  ('2026-09-14', 'scroll',      7);
