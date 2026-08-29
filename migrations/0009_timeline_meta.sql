-- 0009_timeline_meta: the AUDIO-SCAFFOLD system of record — one row per session holding the audio-derived
-- timeline parts (waveform peaks, acoustic lane windows, duration, stereo, noise floor). Paired with
-- model_transcripts (0008 = the transcript lanes), these let the FULL timeline be assembled entirely from the
-- DB, so the served _derived/<sid>/timeline.json is a derived cache, not a pipeline-built artifact. "DB = truth"
-- for the whole timeline, not just the lanes.
--
-- peaks stored as raw int8 bytea (not base64) to avoid ~33% bloat; the server base64-encodes on read to match
-- the client's b64i8 decoder. tags is the acoustic-lane window array [{t,coh,snr,srmr,ov,sp,c50?,bsnr?,bvad?}].
-- segs (per-segment source rows) also live here (meta) since they are pipeline fusion output, not per-model words.

create table if not exists timeline_meta (
  session_id     text primary key,
  dur            double precision,          -- seconds
  stereo         boolean,
  noise_floor_db double precision,
  peaks_rate     int  default 100,
  peaks_min      bytea,                      -- int8 waveform minima (raw bytes)
  peaks_max      bytea,                      -- int8 waveform maxima
  tags           jsonb,                      -- acoustic lane windows
  segs           jsonb,                      -- per-segment fusion rows {t0,t1,winner,conf,nsrc,text,el?,el_agree?}
  variants       text,                       -- descriptive label
  meta           jsonb,                      -- open-ended (pipeline version, chunk_seconds, first_wall, ...)
  updated_at     timestamptz default now()
);
