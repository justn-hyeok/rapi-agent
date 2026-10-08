BEGIN;
-- One calendar: the owner's own entries and collected deadlines (contests,
-- hackathons, CFPs). Collected rows have no owner and are keyed by source.
CREATE TABLE events (
 id uuid PRIMARY KEY,
 owner_id text,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
 starts_at timestamptz NOT NULL,
 all_day boolean NOT NULL DEFAULT false,
 kind text NOT NULL CHECK (kind IN ('personal','deadline','event')),
 source text NOT NULL CHECK (source IN ('manual','dev-event','devpost','cfp')),
 external_key text UNIQUE,
 url text,
 note text,
 hidden boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((source = 'manual') = (owner_id IS NOT NULL)),
 CHECK ((source = 'manual') = (external_key IS NULL))
);
CREATE INDEX events_upcoming_idx ON events(starts_at) WHERE NOT hidden;
INSERT INTO schema_migrations(name) VALUES('0016_events.sql');
COMMIT;
