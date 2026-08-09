-- ---------------------------------------------------------------------------
-- A MARKET AREA THE APPRAISER WOULD RECOGNISE — drawn, not derived.
--
-- A radius is a bad model of a neighbourhood and every appraiser knows it. A
-- mile in one direction crosses a river, a rail line, a school-district boundary
-- or a town line; a mile in another is the same houses on the same streets. The
-- 1004MC form itself asks the appraiser to define the "neighbourhood" and then
-- report on it, so the boundary is a JUDGEMENT a person makes — and the only
-- honest way to capture a judgement is to let them draw it and record who did.
--
-- WHY jsonb AND NOT PostGIS. PostGIS is the right tool for a spatial database
-- and the wrong dependency for this one: it is an extension that has to be
-- installed on the server, and this app's whole deployment story is that it
-- needs `express` and `pg` and nothing native. The shapes here are a dozen
-- corners each and the search is "which of these few hundred properties is
-- inside" — a bounding box in SQL followed by an exact test in JavaScript
-- (`src/lib/research/market-area.js`, 68 assertions) answers it in microseconds.
-- If this ever needs to hold thousands of shapes and ask them all at once, that
-- is the moment to reach for PostGIS, and the ring stores cleanly either way.
--
-- THE BOX IS STORED ALONGSIDE THE RING because it is what makes the query fast
-- and it must never disagree with the ring it came from — so it is written by
-- the same code path that validates the ring, never typed in.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_areas (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  -- What kind of judgement this is: a neighbourhood an appraiser would name, or
  -- a working area somebody drew for one deal. Kept apart so a scratch shape is
  -- never presented as a considered boundary.
  kind          text NOT NULL DEFAULT 'neighborhood',
  state         text,
  city          text,
  -- The ring: [{lat, lng}, …], in the order it was drawn, NOT closed (the first
  -- point is not repeated at the end — `cleanRing` strips that).
  ring          jsonb NOT NULL,
  -- The bounding box, written from the ring by the same code that validated it.
  min_lat       numeric(9,6) NOT NULL,
  max_lat       numeric(9,6) NOT NULL,
  min_lng       numeric(9,6) NOT NULL,
  max_lng       numeric(9,6) NOT NULL,
  area_sq_mi    numeric(12,2),
  -- WHOSE judgement it is. A boundary with no author is a boundary nobody can
  -- ask about, and this one decides which comparables an officer is shown.
  created_by    uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,
  CONSTRAINT market_areas_kind_ck CHECK (kind IN ('neighborhood', 'working', 'exclusion')),
  CONSTRAINT market_areas_box_ck  CHECK (min_lat <= max_lat AND min_lng <= max_lng)
);

-- Two people drawing the same neighbourhood is normal and fine; two shapes with
-- the SAME NAME in the same town is a filing mistake nobody can untangle later.
CREATE UNIQUE INDEX IF NOT EXISTS market_areas_name_uk
  ON market_areas (lower(name), coalesce(lower(city), ''), coalesce(upper(state), ''))
  WHERE archived_at IS NULL;

-- The one query the search makes: the live areas in a market.
CREATE INDEX IF NOT EXISTS market_areas_where_idx
  ON market_areas (upper(state), lower(city)) WHERE archived_at IS NULL;
