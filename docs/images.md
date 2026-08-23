# Candidate images — jsDelivr from a public assets repo

Images are plain URLs in a D1 column, not files this app stores. There is no R2 bucket, no `/img/:key`
proxy route and no upload script — that was decided deliberately (AGENTS.md §4). The app just renders
whatever absolute URL is in `candidates.image_url`.

Those URLs point at **jsDelivr**, backed by a separate **public** GitHub repo holding the photos.

## Why not raw.githubusercontent.com, and what jsDelivr actually changes

Serving images straight from `raw.githubusercontent.com` puts GitHub in the request path for every
viewer. GitHub rate-limits static content, recommends against hotlinking, and does not run that host
as a CDN — so the failure mode is an "Access Restricted — you have triggered a rate limit" page, at
exactly the moment your ballot gets traffic.

The mitigation is not a caching tweak layered on top of raw URLs. **jsDelivr removes the raw host
from the request path entirely.** It fetches the file from GitHub *once*, stores it permanently on
its own origin, and serves every subsequent request from its edge. Viewers never touch
`raw.githubusercontent.com`, so GitHub's rate limiting is no longer reachable — there is nothing left
to throttle. That is the whole of it.

### Translating a URL

Any of these point at the same file:

| From | To |
| --- | --- |
| `github.com/<user>/<repo>/blob/<ref>/<path>` | `cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>` |
| `raw.githubusercontent.com/<user>/<repo>/<ref>/<path>` | `cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>` |

The `<ref>` is where the care goes — see below.

## What you need to enable it

There is no signup, no API key and no dashboard. jsDelivr serves any public GitHub repo on demand.
What you have to get right:

1. **The repo must be public.** jsDelivr proxies public content only. A private repo returns 404, not
   a permission error — which reads like a wrong path and wastes an hour. This is the reason the
   images live in their own repo rather than in `anon-vote-sys`, which stays private.
2. **Give it a real identity.** §5 of the Terms lists a meaningful name, public documentation and an
   appropriate licence as the signals jsDelivr uses to judge whether a project is legitimate when
   that is not self-evident. A repo called `assets` with no README and no licence is the profile that
   gets questioned; one called `anon-vote-assets` with both is not.
3. **You must have the right to distribute the photos.** §1 requires content served through jsDelivr
   to comply with the terms of the origin — so GitHub's rules still apply, and jsDelivr does not
   launder a rights problem. Candidate photos need permission.
4. **Reference a tag, not a branch.** Covered below; this is the one that bites.

## Is this allowed?

Yes. From jsDelivr's [Terms of Use](https://github.com/jsdelivr/jsdelivr/blob/master/Terms%20of%20Use.md)
(effective 2026-05-30):

- Free for **personal and commercial** use, with **no limits on bandwidth or number of requests** (§1).
- §6.2 prohibits "running an image hosting website and using jsDelivr CDN as a storage for all
  uploaded images" — that is not this. The same clause explicitly allows "icons packs, apps, or games
  with a large number of assets", which is exactly what a fixed set of ballot photos is.
- Soft limit: 10,000 actively-accessed files per repo (hard soft-limit 100,000). A ballot has tens.
- Hard limit: **20 MB per file**.

Two constraints that do apply:

- **The repo must be public.** jsDelivr proxies public content only. This is why the images live in
  their own repo rather than in `anon-vote-sys`, which stays private.
- **§1: content must comply with the origin's terms.** jsDelivr does not launder a GitHub problem —
  you still need the right to distribute the candidate photos.

## Setting it up

1. Create a public repo, e.g. `anon-vote-assets`. Give it a real README and a licence — jsDelivr's
   §5 lists a meaningful name, public documentation and an appropriate licence as the signals it uses
   to judge whether a project is legitimate when that is not obvious.
2. Put the images under `candidates/`, named after the candidate ids used in
   `packages/db/seed/candidates.json` (`candidate-01.webp` and so on). Matching the ids makes a
   mismatch obvious at a glance.
3. Commit and **tag**:
   ```bash
   git tag v1 && git push --tags
   ```
4. Use the tagged URL in `candidates.json`:
   ```
   https://cdn.jsdelivr.net/gh/<user>/anon-vote-assets@v1/candidates/candidate-01.webp
   ```

## Always pin a tag or SHA, never a branch

This is the one rule that bites people.

| URL form | Cache behaviour |
| --- | --- |
| `@v1` (tag) | Cached ~1 year, stored permanently. |
| `@a1b2c3d` (commit SHA) | Same — permanent. |
| `@main` (branch) | Cached **12 hours**. |
| `@latest`, or no `@ref` at all | Resolved dynamically; documented cases of it disagreeing with the explicit-ref URL for the same file. Avoid. |

A branch URL is worse in both directions at once: it re-fetches from GitHub far more often, *and*
after you replace a photo the old one keeps being served for up to twelve hours with no way to purge
it. A tag is immutable, so there is never a stale-versus-fresh question — you publish a change by
pointing at a new tag.

### Corollary: never move or reuse a tag

Because tagged URLs are stored **permanently**, re-pointing an existing tag at a new commit does not
reliably publish anything. jsDelivr may keep serving the bytes it already stored for `@v1`,
indefinitely, while `git show v1` locally shows the new file. That is a genuinely confusing failure —
the repo and the CDN disagree and neither is wrong.

Always cut a **new** tag. Tags are free; a stale ballot photo you cannot flush is not.

### Why the purge API is not a fallback

There is a purge endpoint, and it does not rescue this:

- Access is granted **on request by email**, not open to everyone.
- It is rate-limited to roughly **3–4 calls per URL per hour**.
- It clears **edge** caches only — origin copies can persist behind it, so a purge can even appear to
  serve an *older* version.

It exists for `@latest` and branch URLs. Tag-per-change sidesteps the whole mechanism, which is why
that is the rule here rather than a preference.

## Changing a photo

```bash
# in the assets repo
git add candidates/candidate-03.webp && git commit -m "New photo for candidate 3"
git tag v2 && git push --tags
```

Then bump the tag in `packages/db/seed/candidates.json` (`@v1` → `@v2`) and re-seed:

```bash
cd packages/db && bun run seed:remote
```

No deploy needed — the ballot reads candidates from D1, and the cached copy expires within
`RESULTS_TTL_SECONDS` (600s).

## Preparing the files

The cards render square (`aspect-ratio: 1/1`, `object-fit: cover`) and the markup declares
`width="800" height="800"`, so:

- **Square crops**, or faces get cut off by the cover fit.
- **~800×800** is the sweet spot — the largest the grid ever displays.
- **WebP**, typically 40–80 KB each. Well under the 20 MB ceiling, and worth doing since the ballot
  loads every candidate image at once.
- The first five are marked `loading="eager"` / `fetchpriority="high"` by `CandidateCard.astro`;
  the rest lazy-load.
