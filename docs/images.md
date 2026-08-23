# Candidate images — jsDelivr from a public assets repo

Images are plain URLs in a D1 column, not files this app stores. There is no R2 bucket, no `/img/:key`
proxy route and no upload script — that was decided deliberately (AGENTS.md §4). The app just renders
whatever absolute URL is in `candidates.image_url`.

Those URLs point at **jsDelivr**, backed by a separate **public** GitHub repo holding the photos.

---

## Start here — the whole thing, concretely

**There is nothing to install, sign up for, or configure.** jsDelivr is not a service you enable on
your account. It is a public URL prefix that will serve any file from any public GitHub repo, on
demand, the first time someone asks for it. "Using jsDelivr" means nothing more than *writing a
different URL in `candidates.json`*.

> One point of confusion worth clearing up: jsDelivr has **two** proxies. `cdn.jsdelivr.net/npm/…`
> serves npm packages — that is what a page like `jsdelivr.com/package/npm/bun` is showing you, and
> it has nothing to do with this. You want `cdn.jsdelivr.net/gh/…`, the **GitHub** proxy. Ignore
> everything on the site about npm packages.

Assume your GitHub username is `madiocre`. End to end:

**1. Create a public repo for the images.**

```bash
gh repo create anon-vote-assets --public --description "Candidate images for anon-vote-sys" --clone
```

**2. Add the photos.**

```bash
cd anon-vote-assets && mkdir -p candidates
```

Copy the images in, named after the candidate ids you use in `candidates.json`:

```
anon-vote-assets/
  README.md
  LICENSE
  candidates/
    candidate-01.webp
    candidate-02.webp
    candidate-03.webp
```

**3. Commit, and tag it.** The tag is what makes the URL stable — see the caching section below.

```bash
git add -A && git commit -m "Add candidate images" && git push
```

```bash
git tag v1 && git push --tags
```

**4. Work out the URL.** The pattern is:

```
https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/<path-in-repo>
```

so for the tree above:

```
https://cdn.jsdelivr.net/gh/madiocre/anon-vote-assets@v1/candidates/candidate-01.webp
```

**5. Check it actually serves before touching the seed.** Paste it into a browser, or:

```bash
curl -I "https://cdn.jsdelivr.net/gh/madiocre/anon-vote-assets@v1/candidates/candidate-01.webp"
```

`HTTP/2 200` with `content-type: image/webp` means you are done — the file is now cached at
jsDelivr's edge worldwide. A **404 almost always means the repo is private**, the tag was not pushed,
or the path is wrong. There is no error message distinguishing those, so check in that order.

**6. Point the seed at it.** The base URL lives once in `packages/db/seed/seed.ts`:

```ts
const IMAGE_BASE_URL = "https://cdn.jsdelivr.net/gh/Madiocre/vote-images/";
```

and `candidates.json` holds only the filename, which `seed.ts` appends:

```json
{ "id": "candidate-01", "name": "Real Name", "imageUrl": "candidate-01.svg", "sortOrder": 1 }
```

**7. Apply it.**

```bash
cd packages/db && bun run seed:staging
```

```bash
cd packages/db && bun run seed:remote
```

That is the entire integration. No deploy — the ballot reads image URLs from D1, and the cached copy
refreshes within `RESULTS_TTL_SECONDS`.

---

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

## What a "tag" is, and why jsDelivr cares

Worth being explicit, because "add a tag" sounds like something you do to the *repo* — it is not. The
repo is already fine. A tag is about **which commit** a URL points at.

A **git tag** is just a permanent name for one specific commit. Branches move: `main` today is a
different commit from `main` last week, because every push advances it. A tag does not — `v1` means
the exact commit you created it on, forever. It is the usual way to mark releases:

```bash
git tag v1          # names the current commit "v1"
git push --tags     # publishes that name to GitHub
```

Nothing else about the repo changes. No release, no branch, no settings. It is a label.

This matters here because of the part of a jsDelivr URL after the `@`:

```
https://cdn.jsdelivr.net/gh/<user>/<repo>@<THIS BIT>/<path>
```

That is jsDelivr asking *"which version of this file?"* — and it decides how long to cache based on
whether the answer can ever change:

| URL form | What it means | Cache behaviour |
| --- | --- | --- |
| `@v1` (tag) | One exact commit, permanently | Cached ~1 year, stored permanently |
| `@a1b2c3d` (commit SHA) | Same, by hash | Same — permanent |
| `@main` (branch) | "whatever is newest" — can change | Cached **12 hours** |
| no `@` at all | Default branch HEAD — same as above | Cached **12 hours** |

Because a tag can never point somewhere else, jsDelivr can cache it essentially forever and never be
wrong. A branch might change at any moment, so it has to re-check every 12 hours — and in between, it
serves whatever it last saw.

### What this means for your current setup

Your base URL has no `@` at all:

```
https://cdn.jsdelivr.net/gh/Madiocre/vote-images/
```

Checking what jsDelivr returns for it confirms the branch behaviour:

```
x-jsd-version: HEAD
x-jsd-version-type: branch
cache-control: public, max-age=604800, s-maxage=43200
```

`s-maxage=43200` is 12 hours. **This works, and there is nothing to fix while the images are not
changing.** The consequence only appears when you replace a photo: for up to 12 hours afterwards,
some visitors keep seeing the old one, and there is no reliable way to flush it (see the purge
section below). Different people in different regions may see different images during that window.

If image swaps ever become routine, the fix is to tag the assets repo and add `@v1` to
`IMAGE_BASE_URL` in `packages/db/seed/seed.ts`, bumping to `@v2` when you re-tag. Until then this is
a known trade, not a bug.

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

## How the URLs are assembled

`candidates.json` stores **bare filenames**, not full URLs:

```json
{ "id": "candidate-01", "name": "Candidate 01", "imageUrl": "candidate-01.svg", "sortOrder": 1 }
```

`seed.ts` prepends a single base constant when it generates the SQL:

```ts
const IMAGE_BASE_URL = "https://cdn.jsdelivr.net/gh/Madiocre/vote-images/";
```

The full URL is what lands in `candidates.image_url`, so nothing downstream changes — but moving the
CDN, the repo, or the tag is a one-line edit rather than a find-and-replace across every entry.

## Changing a photo

Commit the replacement to the assets repo and re-seed:

```bash
cd packages/db && bun run seed:staging && bun run seed:remote
```

Strictly, re-seeding is only needed if the *filename* changed — the URL in D1 is otherwise identical,
and jsDelivr will pick up the new bytes on its own once the 12-hour branch cache expires (see above).
No deploy either way: the ballot reads candidates from D1, and that cached copy expires within
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
