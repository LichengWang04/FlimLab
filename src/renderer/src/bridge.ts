import type { FilmLabApi } from "../../shared/contracts.ts";
import { createWebDemoApi } from "./web-demo.ts";

export function getFilmLabApi(): FilmLabApi {
  if (typeof window.filmlab !== "undefined") {
    return window.filmlab;
  }

  const search = new URLSearchParams(window.location.search);
  const webDemoRequested = (window.location.protocol === "http:" && search.has("web-demo"))
    || (window.location.protocol === "file:" && search.has("acceptance-web-demo"));
  if (webDemoRequested) {
    return createWebDemoApi();
  }

  throw new Error("FilmLab preload bridge is unavailable.");
}
