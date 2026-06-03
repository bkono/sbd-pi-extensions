List one directory. Shows directories first with `/`, then files, sorted alphabetically; dotfiles are included.

## Parameters

- `path` — directory to list, default cwd.
- `limit` — max entries, default 500; must be positive.
- `glob` — optional entry-name filter such as `*.ts` or `.env*`.

## Usage

Output is one entry per line. Use `ls` to inspect a single directory, `find` for recursive discovery, and `read` for file contents. If output exceeds `limit` or 50 KB, it says so.
