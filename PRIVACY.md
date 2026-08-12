# FilmLab privacy statement

FilmLab is a local-first desktop application. The current application has no
account system, advertising, analytics, telemetry, cloud synchronization,
automatic crash upload, update check, or runtime network API. Production CSP
sets `connect-src 'none'`, and Electron denies permission requests and external
navigation. Development builds allow only loopback HTTP/WebSocket connections
for Vite hot reload.

## Data processed and stored locally

- Imported RAW/TIFF files remain in the locations selected by the user.
- `.filmlab` project directories contain recipes, source identity metadata,
  project backups and calibration snapshots. They do not contain source
  absolute paths or imported photographs.
- The application user-data directory contains recent project locations,
  verified source locations and locally imported calibration profiles. These
  machine-private indexes may contain absolute paths and therefore may reveal
  user names or directory structure.
- The session/cache directory contains decoded preview caches and temporary
  processing data. Exports are written only to user-selected destinations.
- Console output may contain error messages and local paths. No persistent
  diagnostic log or crash dump is automatically uploaded by FilmLab.

Typical storage roots are `%APPDATA%\FilmLab` on Windows,
`~/Library/Application Support/FilmLab` on macOS, and `~/.config/FilmLab` on
Linux. Electron may keep session/cache data in its platform-specific cache
location. See `docs/diagnostics.md` before collecting or sharing anything.

## User control and deletion

Projects and source images are ordinary user-owned files and can be moved,
backed up or deleted with normal filesystem tools while FilmLab is closed.
Uninstall intentionally preserves user data to support upgrades. To erase
local FilmLab state, close the application, back up any wanted project or
calibration data, then remove the FilmLab user-data and cache directories.
This cannot delete copies already included in backups or shared manually.

Support is opt-in: nothing is transmitted until the user deliberately sends
an issue, report or archive. Before sharing, remove photographs, exported
masters, project packages, calibration profiles, user names, absolute paths,
EXIF location/identity metadata and signing credentials unless the recipient
and transfer method are explicitly trusted.
