# `pi-hashline-readmap` assessment

Date: 2026-04-18

## Goal

Assess whether `coctostan/pi-hashline-readmap` is a good short-term fit for a local search/edit workflow that wants:

- `fd` integration when available
- grep/search defaults centered on ripgrep and ideally `ast-grep`
- safer editing/replacement
- a clear understanding of what its bash compression actually does
- reasonable usefulness for Obsidian-style PKM, docs, and other non-code workflows

## Short verdict

This extension looks like a **strong short-term fit for code-first anchored read/edit/search workflows** and a **partial fit for docs/PKM workflows**.

It is especially attractive if the main pain points are:

- finding files quickly
- getting more structured reads than plain file dumps
- making edits more robust against line drift
- reducing noisy bash output in day-to-day development work

It is **not** the same thing as a full “smart local knowledge workflow” layer. The biggest gaps are:

- `ast-grep` is available via a separate `ast_search` tool, but it is **not** the default universal search router
- PKM/docs support is mostly structural and lexical, not note-aware or vault-aware
- bash compression is **post-processing of output**, not execution acceleration or deeper shell intelligence

## What it appears to support well

### File discovery

- `find` uses `fd` when available and falls back when it is not
- that makes it a good fit for your “use `fd` if present” preference

### Search

- `grep` builds on pi’s built-in grep behavior, which already leans on ripgrep
- the extension adds more structure around results, including hash anchors and contextual navigation
- `ast_search` exists for structural search via local `sg` / `ast-grep`

### Reading and navigation

- `read` supports structural maps and symbol-oriented access
- structural maps cover many programming and config formats
- Markdown is included, with heading and code-block-aware mapping
- that makes it meaningfully better than plain file reads for mixed code + docs repos

### Editing

- `edit` is deliberately safety-oriented
- it expects fresh anchors from `read` / `grep` / `ast_search` / `write`
- it validates hash anchors before applying changes
- it can relocate edits within a nearby window when line numbers drift
- it has diagnostics for stale or fuzzy matches

This is the strongest part of the extension for your use case. If your main goal is “make local edits safer and less line-number fragile,” this is a real improvement over naive text replacement.

### Bash output handling

- bash compression happens after command execution
- it strips ANSI noise and runs command-specific compressors over output
- this is aimed at making terminal output easier to consume, not making commands run faster

So the value is readability and context preservation, not performance.

## Where it only partially matches your desired workflow

### `ast-grep` is not the default search brain

The extension includes `ast_search`, but it does **not** seem to automatically route ordinary search requests through `ast-grep` first and fall back to ripgrep second.

Practical meaning:

- good if you are happy to explicitly choose structural search when needed
- less good if you want one smart search surface that automatically picks the right engine

### Docs / PKM support is useful but shallow

Markdown support is real and helpful, but it is mostly:

- heading-aware structure
- code-block-aware structure
- lexical search
- safer anchored edits

It does **not** appear to add vault-native behaviors such as:

- backlink awareness
- wikilink semantics
- frontmatter-aware querying or edits
- note graph semantics
- embedding/transclusion awareness
- higher-level “knowledge base” operations

That means it can help you work *inside* docs and notes, but it does not turn pi into an Obsidian-aware assistant.

## Specific downsides / negative impacts to watch for during a trial

## 1. It may create false confidence about “smart search”

Because the extension adds structure and exposes `ast_search`, it can feel like search has become semantically smart by default.

But the practical reality is closer to:

- default search remains lexical/ripgrep-oriented
- structural search is opt-in

Potential impact for your workflow:

- you may assume a search miss means “not present,” when it may only mean “not lexically matched the way I expected”
- you may still need deliberate habits around when to switch to `ast-grep`

This is not dangerous, but it can distort learnings if you are trying to evaluate a future smarter search UX.

## 2. Compressed bash output may hide details you actually want while learning

The bash compression layer is useful for noisy dev commands, but it can be a downside during exploration.

Potential impact:

- raw command output may be summarized instead of shown verbatim
- exact ordering, repeated lines, or full listings may be less visible
- for docs/PKM/non-code browsing, the “compression” may be less helpful than it is for build/lint output

If part of your trial is “learn from raw local behavior,” this could occasionally get in the way.

## 3. Test command handling may be less polished than the README implies

The command-specific bash compression seems most tuned for common developer noise like git, build, package-manager, Docker, transfer, and listing output.

The observed behavior suggests test commands may not get equally smart summarization.

Potential impact:

- a mismatch between what you expect from the README and what you actually see
- less value from the compression layer on some commands you care about

This is more of an expectation-management problem than a blocker.

## 4. Fuzzy relocation is powerful, but repetitive prose/docs are a trickier fit than code

The edit system’s willingness to relocate within a nearby window is useful when code shifts.

But docs and notes often contain:

- repeated headings
- repeated checklist items
- repeated templates
- similar paragraphs across files or sections

Potential impact:

- in repetitive Markdown/prose, “nearby similar text” can be less uniquely identifying than in code
- you may want to reread targets before accepting important edits, especially in highly templated notes

This does not look recklessly unsafe; it is more that the safety model is optimized for structured text where anchors are distinctive.

## 5. It is not optimized for vault-level note workflows

For Obsidian-style usage, the likely gap is not “it fails,” but “it does not reason in the same units you do.”

Your likely unit of work may be:

- notes linked by wikilinks
- topic clusters
- frontmatter-driven sets
- backlinks and references
- refactors spanning many related notes

Its likely unit of work is still more like:

- files
- sections
- lexical matches
- structural fragments

Potential impact:

- good for operating on individual note files
- less good for cross-note knowledge operations
- less likely to surface note relationships that matter to your PKM flow

## 6. Behavior may vary depending on local tools being installed

Some of the appeal depends on optional local executables:

- `fd`
- `sg` / `ast-grep`

Potential impact:

- results and ergonomics may differ across environments
- learnings from one machine may not transfer perfectly to another unless tool availability is kept consistent

## 7. It replaces core tool behavior, which can subtly change expectations

Because it is a drop-in replacement layer for key file/search/edit tools, it may alter how prompts, habits, or future extensions interact with pi.

Potential impact:

- prompts or workflows tuned for stock tool behavior may no longer behave the same way
- output shape differences can affect how you mentally model the system
- if you later remove it, some habits may not carry back cleanly

This is probably acceptable for a trial, but it is worth remembering that you would be evaluating both the extension and its altered tool contract.

## Net risk assessment for a short trial

I do **not** see major destructive risk from using it for a while, especially if your goal is to learn.

The main risks look like **workflow-fit risks**, not “this will damage your setup” risks:

- overestimating how smart default search is
- occasionally losing raw detail to output compression
- getting less value in PKM/docs than in code
- needing extra caution when editing repetitive prose/templates

So my current view is:

- **low risk** to try for a while
- **high chance of useful learnings** for code-centric local workflows
- **only partial signal** for the more note-graph / PKM-specific workflows you care about

## Recommendation

If you want learnings quickly, this seems worth trying as-is for a short period **provided you treat it as**:

- a better anchored code/doc tooling layer
- not yet a fully smart search router
- not yet a vault-aware PKM layer

The cleanest evaluation questions for a trial would be:

1. Does anchored read/edit materially reduce failed or brittle edits?
2. Does the `fd` + ripgrep + optional `ast_search` mix feel fast enough in practice?
3. Does bash output compression help more often than it hides useful detail?
4. Does Markdown structure support feel “good enough,” or do you quickly miss backlink/frontmatter/wikilink semantics?

## Bottom line

If you use it for a little while, the biggest downside is probably **not harm** but **misleading optimization**:

- it is likely to improve code-first navigation and editing enough to feel promising
- but it may not tell you much about the harder PKM edge cases unless you explicitly test those

So yes: good candidate for a learning trial, with the main caution that some of your most interesting edge cases are exactly where it looks least specialized.
