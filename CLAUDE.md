# CLAUDE.md

## Git and publishing
- Commit or push only when explicitly asked.
- Upload, publish or post to external platforms (YouTube, itch.io, Steam, X, Reddit, etc.) only when explicitly asked.
- Until the public Steam store page is ready, don't use "Coming to Steam", "Wishlist on Steam", a Steam call to action, the Steam logo or a Steam link in public-facing copy. Revisit Steam messaging and links only once a real store page URL exists and the developer explicitly approves. Never invent a Steam URL.

## Promo assets
- Keep `promo/` git-ignored. Its videos, masters and capture tooling never go into the repository.
- To re-cut the trailer, re-assemble from the lossless masters in `promo/trailer/work/`. Don't re-encode the delivered MP4s, since each re-encode loses quality.

## Environment
- This is Windows with Git Bash and PowerShell. Shell quoting, backticks and heredocs can silently mangle injected code, so edit files with the file-editing tools rather than shell one-liners.
- Run tests from PowerShell when Git Bash causes Windows-specific execution issues.

## Finishing work
- Before calling implementation work done, run the existing tests and build checks that cover the changed area, and report the results.
