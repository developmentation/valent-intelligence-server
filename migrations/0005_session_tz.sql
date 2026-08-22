-- 0005_session_tz: capture the device's UTC offset per session so the live view can render times in the
-- SUBJECT's local time while storage stays UTC (all wall fields are epoch ms). Minutes east of UTC.
-- Parsed from the manifest session_open `tzOffsetMin` field (see ingest.js). Nullable; older sessions
-- simply have no offset and fall back to UTC display.

alter table sessions add column if not exists tz_offset_min int;
