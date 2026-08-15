import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export const LINKS = {
  download: "https://github.com/luumenlabs/code/releases/latest",
  releases: "https://github.com/luumenlabs/code/releases",
  repo: "https://github.com/luumenlabs/code",
  contributing: "https://github.com/luumenlabs/code/blob/main/CONTRIBUTING.md",
  luumen: "https://luumen.dev",
} as const;
