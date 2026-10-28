import { useSyncExternalStore } from "react";
import ko from "./ko.json";
import en from "./en.json";

export type Locale = "en" | "ko";
export const LOCALE_STORAGE_KEY = "cygnus.locale";
const listeners = new Set<() => void>();

export function resolveLocale(saved: string | null, languages: readonly string[] = []): Locale {
  if (saved === "en" || saved === "ko") return saved;
  return languages[0]?.toLowerCase().startsWith("ko") ? "ko" : "en";
}
function readLocale(): Locale {
  try { return resolveLocale(localStorage.getItem(LOCALE_STORAGE_KEY), navigator.languages); }
  catch { return "en"; }
}
let locale = readLocale();
function publish(next: Locale) {
  locale = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
if (typeof window !== "undefined") {
  document.documentElement.lang = locale;
  window.addEventListener("storage", (event) => {
    if (event.key === LOCALE_STORAGE_KEY || event.key === null) publish(readLocale());
  });
}
export function setLocale(next: Locale) {
  // Persist before publishing so a storage failure can be shown in Settings.
  localStorage.setItem(LOCALE_STORAGE_KEY, next);
  publish(next);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getLocale = () => locale;
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}
export function translate(message: string, language: Locale, values?: Record<string, string | number>): string {
  const dictionary: Record<string, string> = language === "ko" ? ko : en;
  const translated = dictionary[message] ?? message;
  return translated.replace(/\{(\w+)\}/g, (match, key: string) =>
    values?.[key] === undefined ? match : String(values[key]));
}
/** Only pass authored UI messages; never translate server output or user data. */
export function t(message: string, values?: Record<string, string | number>) {
  return translate(message, locale, values);
}
