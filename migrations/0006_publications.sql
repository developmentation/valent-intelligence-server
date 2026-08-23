-- 0006_publications: curated, shareable collections of existing sessions.
--
-- A publication is pure METADATA over sessions the server already holds: an ordered set of session ids,
-- a list of excluded media paths, a title/description, and a published flag. Nothing is copied. The
-- public viewer (/publish/:id) and its API (/api/pub/:id, /pub/:id/media/*) serve ONLY published
-- publications and ENFORCE the exclusions (an excluded file 404s even if its URL is guessed). Curation +
-- publish/unpublish are admin-only; the published view is open (password-free UUID link).

create table if not exists publications (
  id          text primary key,                 -- opaque UUID, used in the public URL
  title       text not null default 'Journey',
  description text not null default '',
  session_ids jsonb not null default '[]',       -- ordered array of session ids (the legs)
  excluded    jsonb not null default '[]',       -- array of media file paths to hide (enforced at the API)
  published   boolean not null default false,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  published_at  timestamptz,
  unpublished_at timestamptz
);

create index if not exists publications_published on publications (published);
create index if not exists publications_updated on publications (updated_at desc);
