import { clsx, type ClassValue } from "clsx";

/** Tiny conditional-className helper used across UI components. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
