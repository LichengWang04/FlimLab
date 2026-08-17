export function FilmCanisterIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect className="film-icon-shell" x="13" y="13" width="34" height="40" rx="7" />
      <path className="film-icon-cap" d="M18 9h24l3 6H15l3-6Z" />
      <rect className="film-icon-label" x="19" y="22" width="22" height="17" rx="3" />
      <circle className="film-icon-spool" cx="30" cy="30.5" r="5.5" />
      <path className="film-icon-film" d="M47 27h5.5c3 0 5.5 2.5 5.5 5.5V48l-6-3.5V34h-5V27Z" />
      <path className="film-icon-highlight" d="M20 17h20" />
    </svg>
  );
}
