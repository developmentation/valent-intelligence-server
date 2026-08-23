-- 0007_transcripts: high-fidelity, word-timestamped transcripts (ENRICHES; does not replace the
-- on-device `speech` records, which stay as the live/low-latency layer).
--
-- Produced offline on GPU (Parakeet-TDT-0.6B-v2, full 100% coverage — see ../gpu-stt). One row per
-- utterance/segment; the word-level detail lives in `words` jsonb. Every segment is anchored two ways:
--   * absolute WALL-CLOCK (start_ms/end_ms, epoch ms UTC) — computed at ingest as session.first_wall +
--     audio_offset*1000; the audio chunks are contiguous 60 s so this is drift-free.
--   * AUDIO-RELATIVE seconds from the session's audio start (audio_start_s/audio_end_s) — the exact
--     offset into the recording, independent of clock.
-- This lets a transcript segment be joined to media / location / motion by wall time, or seeked in the
-- audio by offset. A (session_id, model) pair is one full transcript; re-ingesting replaces it by seq.

create table if not exists transcripts (
  id            bigserial primary key,
  session_id    text not null,
  seq           int  not null,                          -- order within (session_id, model)
  start_ms      bigint not null,                        -- absolute wall-clock, epoch ms UTC
  end_ms        bigint not null,
  audio_start_s double precision not null,              -- seconds from session audio start
  audio_end_s   double precision not null,
  text          text not null,
  words         jsonb,                                  -- [{w, s, e}] — s/e = seconds from session start
  model         text not null default 'parakeet-tdt-0.6b-v2',
  vad           boolean not null default false,         -- was VAD gating used to produce it
  created_at    timestamptz default now(),
  unique (session_id, model, seq)
);
create index if not exists transcripts_session_time on transcripts (session_id, start_ms);
create index if not exists transcripts_time on transcripts (start_ms);
