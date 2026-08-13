# Luu Code — notes for coding agents

## House style

**Comments are short.** One or two lines. They explain **why** — the constraint
that made the obvious approach wrong, the failure being defended against — and
only where the next person would otherwise undo the code. Do not argue a case, do
not compare the approach to the one not taken, do not narrate what the next line
plainly does. A paragraph justifying a decision is a paragraph nobody reads.
Match the density of the file you are editing.

**User-facing text is shorter.** Labels, descriptions, tooltips, and errors say
what the thing is or what to do next. They never explain a reason, a trade-off,
or how anything works underneath. "Always on — this is how an agent reports what
is wrong" is already at the limit; anything longer belongs nowhere.

**Documentation describes what is, not what was considered.** No rationale for
picking a library, no defence of an architecture, no history. Say how the thing
behaves and what will break if you change it.

- Fail clearly. Every Roblox-facing failure carries a code an agent can act on and,
  where possible, a hint naming what to try instead.
- Never report a partial success as a success.
- Do not guess at a target. Ambiguity is an error, not a coin flip.
- Probe capabilities rather than assuming them; Studio differs by version, platform,
  and run state.
- Prefer a structured Studio API over desktop automation when both would work.
- Keep the surface small. The product is the Studio connection, not a general local
  coding environment.
