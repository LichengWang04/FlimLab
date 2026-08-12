import type { FilmLabApi } from "../../shared/contracts.ts";
import { createWebDemoApi } from "./web-demo.ts";

export function getFilmLabApi(): FilmLabApi {
  if (typeof window.filmlab !== "undefined") {
    return window.filmlab;
  }

  const webDemoRequested = window.location.protocol === "http:"
    && new URLSearchParams(window.location.search).has("web-demo");
  if (webDemoRequested) {
    return createWebDemoApi();
  }

  throw new Error("FilmLab preload bridge is unavailable.");
}
