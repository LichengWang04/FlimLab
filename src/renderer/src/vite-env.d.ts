import type { FilmLabApi } from "../../shared/contracts.ts";

declare global {
  interface Window {
    filmlab: FilmLabApi;
  }
}

export {};
