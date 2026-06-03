# Integration surfaces

`pi-hashline-readmap` exposes its registered tool executors for downstream pi integrations that want to call the same enhanced tools programmatically.

## EventBus executor announcement

When the extension loads, it emits the tool executor map on pi's EventBus:

```ts
pi.events.emit("hashline:tool-executors", toolExecutors);
```

Consumers can listen for the `hashline:tool-executors` event to discover the active executor map.

## Global executor map

The extension also assigns the executor map to `globalThis`:

```ts
(globalThis as any).__hashlineToolExecutors = toolExecutors;
```

This is intended for local integration with pi tooling that cannot subscribe to the EventBus directly.

## Available executors

The map includes these keys when the corresponding tool is registered:

| Key | Notes |
|---|---|
| `read` | Enhanced hashlined read tool. |
| `edit` | Hash-anchored mutating edit tool. |
| `grep` | Hashlined text search. |
| `ast_search` | Structural search wrapper; usefulness depends on local `ast-grep` availability. |
| `write` | File creation/full-write tool with hashlined output. |
| `ls` | Single-directory listing. |
| `find` | Recursive file discovery. |
| `context_hygiene_report` | Present only when `PI_CONTEXT_HYGIENE_DEBUG=1`. |

## Recommended consumer behavior

- Prefer the exported PTC policy in [structured-output.md](structured-output.md) when deciding which tools are safe to expose by default.
- Treat `edit` and `write` as mutating operations even if an executor is present.
- Use `details.ptcValue` for structured results instead of parsing rendered output when possible.
- Be prepared for optional executors such as `context_hygiene_report` to be absent.
- Do not rely on hot reload. Restart the pi session after changing this extension's source.

## Related docs

- [structured-output.md](structured-output.md) for `details.ptcValue` and PTC policy.
- [context-hygiene.md](context-hygiene.md) for stale-context metadata attached to tool results.
- [bash-output.md](bash-output.md) for Bash result post-processing and recovery behavior.
