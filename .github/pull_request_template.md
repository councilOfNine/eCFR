<!--
Thanks for contributing. Delete any section that does not apply — a short, honest PR
description beats a fully filled-in template.

Fork PRs: CI builds everything but will not produce a preview URL. That is by design; see
CONTRIBUTING.md.
-->

## What and why

<!-- What changes, and what problem it solves. Link the issue if there is one: Closes #123 -->

## Does this change a published number?

<!--
Answer even if the answer is "no". This project's entire value is that its figures can be
trusted, so a change to how anything is counted, attributed, rolled up, or deduplicated gets
read differently from a change to a button.
-->

- [ ] No — this does not affect any measurement, count, attribution, or total.
- [ ] Yes — and I have described below what changes, by how much, and why the new value is the
      correct one.

<!-- If yes: which figures move, in which direction, and what evidence says the new one is
     right? "The dedup total drops 0.4% because 22 CFR XIV was being double-counted" is the
     kind of answer that lets a reviewer agree with you. -->

## Checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm format:check` all pass locally.
- [ ] Every number this code can produce came from a measurement. Nothing is estimated,
      defaulted, or inferred; where a value could not be measured it is `unavailable()` with a
      reason, not `0` and not `null` on its own.
- [ ] No regular expression is used to extract structure from XML.
- [ ] No user input reaches `new RegExp`.
- [ ] No user-facing route makes an outbound request to ecfr.gov. (`/diff` may, and memoises to
      R2 permanently.)
- [ ] Any new write path is insert-then-prune: upsert with `last_seen_run_id = :run`, delete
      `WHERE last_seen_run_id < :run` only after the unit succeeded.
- [ ] No `any` without a comment justifying it; no `@ts-ignore`.
- [ ] Comments explain _why_, particularly anywhere a measured fact or an upstream eCFR quirk
      drove the decision.

## Page-count impact

<!-- Skip unless you touched routing or page generation in apps/web. -->

- [ ] This does not change how many pages the site prerenders.
- [ ] It does — the new count is `____` and CI's 18,000-file assertion still passes.

<!-- Reminder: the free-plan cap is 20,000 files and title 40 alone has 24,614 sections, so
     a page-per-section change blows through it in a single commit. -->

## Anything a reviewer should know

<!-- Trade-offs you made, things you were unsure about, follow-ups you left deliberately. -->
