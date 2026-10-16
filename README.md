# Travis county modules (mirror of the kit branch `travis`)

The Travis County adapter lives on branch `travis` of a `soofi-xyz-team-kit` checkout pinned at
`99c7bff` (decisions.md section 3). This directory mirrors every Travis-specific file so a reviewer
can rebuild that branch from this repository:

- `kit-files.txt`: the mirrored paths (relative to the kit root).
- `kit/`: the files, at the same relative paths.
- `kit-core.patch`: the two-line kit changes (the `--county travis` registration in
  `bin/elephant-county.mjs` and the `data/` line in the runtime `.gitignore`).
- `KIT_COMMIT`: the kit commit the mirror was taken from.
- `refresh-from-kit.sh <kit>`: refresh the mirror from the kit checkout.
- `apply-to-kit.sh <kit>`: copy the mirror into a kit checkout at `99c7bff` and apply the patch.

Rerun from a clean clone:

```bash
git clone https://github.com/soofi-xyz/soofi-xyz-team-kit kit && git -C kit checkout 99c7bff
oracle/travis/apply-to-kit.sh ./kit
(cd kit/skills/use-oracle/runtime && npm ci && TZ=America/Chicago npm test)
(cd kit/skills/use-oracle/runtime && node bin/elephant-county.mjs replay --county travis --fixture fixtures/travis-replay --output "$(mktemp -d)")
```

Never mirrored: seed CSVs, captures, run directories, CARs, Parquet, `.env`.
