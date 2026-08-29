import logoUrl from "./assets/logo.png";

export function FilmCanisterIcon({ className = "" }: { className?: string }) {
  return (
    <img
      aria-hidden="true"
      alt=""
      className={className}
      draggable={false}
      src={logoUrl}
    />
  );
}
