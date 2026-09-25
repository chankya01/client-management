import { appConfig } from "./config.js";
import { createClient } from "@supabase/supabase-js";

const savedConfig = typeof window === "undefined"
  ? {}
  : JSON.parse(localStorage.getItem("requestManagementConfig") || "{}");
const supabaseUrl = savedConfig.supabaseUrl || appConfig.supabaseUrl;
const supabaseAnonKey = savedConfig.supabaseAnonKey || appConfig.supabaseAnonKey;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey && !appConfig.demoMode);

export const supabase = isSupabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null;

export function saveSupabaseConfig({ url, anonKey }) {
  localStorage.setItem("requestManagementConfig", JSON.stringify({
    supabaseUrl: url,
    supabaseAnonKey: anonKey
  }));
  window.location.reload();
}
