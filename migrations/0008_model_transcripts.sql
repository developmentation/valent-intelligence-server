-- 0008_model_transcripts: the MODEL-COMPARISON system of record. One row per (session, model, variant),
-- the full per-word detail denormalized into a `words` jsonb block that keeps FULL fidelity (timing AND
-- confidence). This is the durable store the timeline `model_streams` are DERIVED from (table = truth,
-- blob = player cache), and the substrate for confidence/sensitivity-gated cloud escalation.
--
-- Open-ended by design: a new model or variant is just a new row — no schema change. Covers the sovereign
-- models (parakeet L/R/novad/vad, qwen, whisper, cohere, distil), our custom fusion, ElevenLabs
-- (is_cloud=true), and any future model. Distinct from `transcripts` (0007): that is the single canonical
-- on-device/production transcript (no variant, no per-word confidence); THIS is the multi-model lab store.
--
-- `words` items: {w, s, e, c} — w=word, s/e=seconds from session audio start (same coordinate as the
-- timeline + transcripts.words), c=per-word confidence (0..1, null if the model gives none). `first_wall`
-- snapshots sessions.first_wall at ingest so absolute wall-clock can be derived (base + s*1000) without a join.

create table if not exists model_transcripts (
  id            bigserial primary key,
  session_id    text not null,
  model         text not null,                       -- logical name: parakeet|whisper|cohere|distil|qwen|elevenlabs|fusion|...
  variant       text not null default 'mix',         -- audio/config lane: mix|left|right|novad|vad|dr|...
  model_id      text,                                -- exact version, e.g. nvidia/parakeet-tdt-0.6b-v2, CohereLabs/cohere-transcribe-03-2026
  runtime       text,                                -- nemo|hf|ct2|api|...
  is_cloud      boolean not null default false,      -- false = sovereign; true = cloud-escalation enhancement
  text          text,                                -- flat transcript, denormalized for quick display/search
  n_words       int,
  words         jsonb,                               -- [{w,s,e,c}] full-fidelity per-word block
  metrics       jsonb,                               -- {rtf, wer_vs_el, mean_conf, ...} open-ended
  meta          jsonb,                               -- {params, gate_decision, escalation_reason, ...} open-ended
  first_wall    bigint,                              -- sessions.first_wall snapshot (derive wall-clock = first_wall + s*1000)
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (session_id, model, variant)
);
create index if not exists model_transcripts_session on model_transcripts (session_id);
create index if not exists model_transcripts_model   on model_transcripts (session_id, model);
