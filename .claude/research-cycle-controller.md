# Managed Research-Cycle Controller

This controller combines a research mission with SkillWiki's mandatory
typed-page publication transaction. The mission defines what to research; it
cannot override the publication rules below.

## Required inputs

- A mission file path supplied by the invoking session or scheduler.
- A repository checkout containing this controller.
- A vault resolvable by `skillwiki --human path`.

## Start gate

1. Read this controller fresh at the start of every cycle.
2. Read the supplied mission file fresh; stop if it is missing.
3. Resolve `VAULT` with `skillwiki --human path`.
4. Run `skillwiki page publish --help`. If unavailable, stop without writing a
   typed page and report that the SkillWiki CLI/plugin must be upgraded.
5. Run the mission's research and planning steps.

## Typed-page publication

For every query, concept, comparison, entity, meta page, or cycle report:

1. Finish the entire page, including final tags, at a temporary path outside
   the vault. Do not create or edit the final vault target.
2. Freeze the draft bytes, target path, and single-line log note.
3. Run:

   `skillwiki page publish <draft.md> "$VAULT" --target <typed/target.md> --log-note "<note>"`

4. Inspect the dry-run. If it reports an error, retain the draft and stop that
   publication.
5. Run the identical command with `--write`.
6. If the write returns nonzero, retain the draft and operation ID, do not edit
   SCHEMA.md/page/index.md/log.md manually, and report the retry-safe stage.
7. Remove the temporary draft only after complete success.

Use named variables for the executable write command:

```bash
skillwiki page publish "$DRAFT" "$VAULT" \
  --target "$TARGET" \
  --log-note "$LOG_NOTE" \
  --write
```

## Direct-write prohibitions

- Never directly write a final typed-page path.
- Never directly add typed-page tags to SCHEMA.md.
- Never directly add the page to index.md.
- Never directly append the page's structural entry to log.md.
- Never bypass lint or lint-delta.

Non-typed mission artifacts keep their documented workflow, but they must not
be used to smuggle typed-page publication around this controller.
