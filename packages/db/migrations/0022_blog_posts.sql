BEGIN;
-- Blog archive: learner issues and Rapi-written guides. A post goes public only
-- after an owner decision; the static blog is built from the merged MDX file.
CREATE TABLE blog_posts (
 id uuid PRIMARY KEY,
 slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 kind text NOT NULL CHECK (kind IN ('issue','guide')),
 status text NOT NULL CHECK (status IN ('draft','approved','published','withdrawn')),
 origin text NOT NULL CHECK (origin IN ('issue','owner','weekly')),
 title text NOT NULL,
 description text NOT NULL DEFAULT '',
 mdx text NOT NULL,
 topic text,
 source_issue_id uuid UNIQUE REFERENCES learner_issues(id),
 revision integer NOT NULL DEFAULT 1,
 pr_url text,
 pr_branch text,
 remove_pr_url text,
 remove_pr_branch text,
 decided_by text,
 decided_at timestamptz,
 published_at timestamptz,
 withdrawn_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX blog_posts_status_idx ON blog_posts(status, published_at DESC);
INSERT INTO schema_migrations(name) VALUES('0022_blog_posts.sql');
COMMIT;
