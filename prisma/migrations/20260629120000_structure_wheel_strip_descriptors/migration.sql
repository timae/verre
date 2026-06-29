-- Structure-wheel data migration — strip dropped flavour-descriptor keys.
--
-- Spec: docs/dev/proposals/structure-wheel.md §4.3 (the migration) + §8 (rollout:
-- expand → MIGRATE → contract). This is step 2 of the rollout; the Expand PR (#56)
-- is already deployed, the Contract PR (delete legacy FL_*/detectFL) is separate
-- and comes AFTER prod is verified clean by this migration.
--
-- WHAT IT DOES
--   Subtracts EXACTLY the 16 legacy descriptor keys from each ratings.flavors object
--   (the `-` operator over a text[] of keys), leaving every other key untouched with
--   its value verbatim. The 4 surviving structure keys (body/acid/tannin/sweet) and
--   any new structure keys (finish/aroma/flavour/bubbles) all carry over unchanged.
--   finish/aroma/flavour/bubbles are NOT fabricated on old rows: a migrated row is an
--   honest PARTIAL structure rating (absent key => not drawn, per §6d).
--
--   DENYLIST (subtract the 16), NOT allowlist (keep 4). This is deliberate: an
--   allowlist rebuild would silently DROP finish/aroma/flavour/bubbles from any row
--   that ALSO carries a descriptor key (a "mixed-vocabulary" row). Dry-run Q5 shows
--   zero such rows in prod today, but the denylist makes the migration self-protecting
--   and unconditionally safe to re-run later even if a mixed row ever appears — it only
--   ever removes the 16 named keys, never anything else.
--
-- WHY IT IS A PURE UPDATE (no DELETE, no S3, no feed_item cleanup)
--   Gated by the 2026-06-29 prod dry-run (§8a). Of 44 non-empty rows: 43 keep >=1
--   structure key, exactly 1 collapses to '{}', and that one still carries a
--   score/notes (it is an engaged rating, not a dead orphan). Dry-run counts:
--   fully-empty orphans = 0, lingering orphan session cards = 0, unexpected keys = 0.
--   So the §4.1 eager-reap path (rating_images + S3 reclaim + feed_item replication)
--   is MOOT and intentionally omitted. Redis: no live session at migration time
--   (Simon, 2026-06-29) => no parallel pass.
--
-- IDEMPOTENT
--   The WHERE limits the rewrite to rows that still contain >=1 of the 16 descriptor
--   keys, so a second run (or a row with no descriptor key) is a no-op. The `-` is
--   itself idempotent (subtracting an absent key is a no-op), so re-running is safe.
--
-- DEFENSIVE: the `jsonb_typeof(flavors) = 'object'` guard ensures the `-` operator
--   only ever sees an object. The column's app invariant is `{key:int}` and the
--   dry-run found zero malformed rows — but a non-object JSONB (array/scalar/null)
--   would behave wrongly or error under `-`/`?|`, so the guard makes such a row a
--   clean no-op instead of risking the deploy. Free insurance.

UPDATE ratings
SET flavors = flavors - array[
      'dark_fruit', 'red_fruit', 'dried_fruit', 'tree_fruit', 'tropical',
      'stone', 'citrus', 'floral', 'floral_herb', 'herbal', 'mineral',
      'oak', 'earth', 'spice', 'creamy', 'nutty'
    ]
WHERE jsonb_typeof(flavors) = 'object'
  AND flavors <> '{}'::jsonb
  AND (flavors ?| array[
        'dark_fruit', 'red_fruit', 'dried_fruit', 'tree_fruit', 'tropical',
        'stone', 'citrus', 'floral', 'floral_herb', 'herbal', 'mineral',
        'oak', 'earth', 'spice', 'creamy', 'nutty'
      ]);
