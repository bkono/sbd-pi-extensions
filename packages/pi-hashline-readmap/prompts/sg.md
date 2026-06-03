AST-aware structural code search. Use when text search is too broad or brittle and you need code shape, such as calls, imports, declarations, or JSX. Returns matches grouped by file with edit-ready hashline anchors.

## Parameters

- `pattern` — ast-grep pattern to match.
- `lang` — language hint such as `typescript`, `tsx`, `javascript`, `jsx`, `rust`, or `python`; set it when syntax is ambiguous.
- `path` — file or directory, default cwd.

## Pattern syntax

- `$NAME` matches one AST node.
- `$_` matches any one node.
- `$$$ARGS` matches zero or more nodes; use `$$$` for variable-length args, body statements, object fields, JSX children, etc.

## Examples

- `console.log($$$ARGS)` — calls.
- `import $NAME from '$SOURCE'` — default imports.
- `export function $NAME($$$PARAMS) { $$$BODY }` — exported functions.
- `$OBJ.$METHOD($$$ARGS)` — method calls.
- `<$TAG $$$ATTRS>$$$CHILDREN</$TAG>` — JSX/TSX elements.

## Tips

Patterns are parsed as code, not text: formatting is mostly ignored, but syntax must be valid for `lang`. Include semicolons in languages that require them. Use `grep` for plain text and `ast_search` for structure.
