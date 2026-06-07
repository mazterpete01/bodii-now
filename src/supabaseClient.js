import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://rxzutgoibgyoiunlssog.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ4enV0Z29pYmd5b2l1bmxzc29nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAxNzA1MTksImV4cCI6MjA5NTc0NjUxOX0.ptrAL17Lycf2cTBwLb3flvENZIfkXfTaSxjIYRBRQqs";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
