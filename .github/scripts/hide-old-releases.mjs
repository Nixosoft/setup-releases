// Hide every app's older versions on the release hub (Nixosoft/setup-releases).
//
// Hirad, 2026-11-23: "remove older versions … or at least not delete but do not allow
// for downloading older versions", then "do it for all release tags". Nothing is
// deleted: an older release becomes a draft, which the public cannot see or download
// from, and which can be published again from the Releases page.
//
// What stays public:
//   - every release whose tag is not `<app>-vX.Y.Z`: the rolling `<app>-latest` feeds,
//     `update-bridge` and anything else hand-made;
//   - the newest `<app>-vX.Y.Z` of each app (pre-releases count as their own line);
//   - the release that just triggered the run, and the hub's "latest" release;
//   - any release that a feed or manifest (.yml/.yaml/.json) on a public release links
//     to: dupligence-latest/latest.yml names the installer on dupligence-v<newest>.
//
// Source of truth: open-claw-projects/setup-releases-notifier/ (copied into the hub's
// .github/). Env: GH_TOKEN, REPO (owner/name), DRY_RUN=true to only print the plan,
// JUST_PUBLISHED (tag of the release that triggered the run).

const token = process.env.GH_TOKEN;
const repo = process.env.REPO || 'Nixosoft/setup-releases';
const dry = process.env.DRY_RUN === 'true';
const justPublished = process.env.JUST_PUBLISHED || '';
if (!token) throw new Error('GH_TOKEN is not set');

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const all = [];
for (let page = 1; ; page++) {
  const batch = await api(`/releases?per_page=100&page=${page}`);
  all.push(...batch);
  if (batch.length < 100) break;
}
const pub = all.filter((r) => !r.draft);

export const VERSIONED = /^(.+)-v(\d+)\.(\d+)\.(\d+)(?:[-+]([0-9A-Za-z.-]+))?$/;
const parse = (r) => {
  const m = VERSIONED.exec(r.tag_name);
  return m && { r, app: m[1] + (r.prerelease ? ' (pre-release)' : ''), v: [+m[2], +m[3], +m[4]], pre: m[5] || '' };
};
const newer = (a, b) => a.v[0] - b.v[0] || a.v[1] - b.v[1] || a.v[2] - b.v[2] || (a.pre === b.pre ? 0 : a.pre === '' ? 1 : b.pre === '' ? -1 : a.pre < b.pre ? -1 : 1);

const versioned = pub.map(parse).filter(Boolean);
const newest = new Map();
for (const e of versioned) {
  const cur = newest.get(e.app);
  if (!cur || newer(e, cur) > 0) newest.set(e.app, e);
}

const keep = new Map(); // tag -> why
for (const e of newest.values()) keep.set(e.r.tag_name, 'newest');
if (justPublished) keep.set(justPublished, 'just published');
try {
  keep.set((await api('/releases/latest')).tag_name, "the hub's latest release");
} catch { /* no latest release */ }

// Follow links from public feeds and manifests until nothing new turns up.
const read = new Set();
for (let grew = true; grew; ) {
  grew = false;
  for (const r of pub) {
    if (read.has(r.id) || (VERSIONED.test(r.tag_name) && !keep.has(r.tag_name))) continue;
    read.add(r.id);
    for (const a of r.assets) {
      if (!/\.(ya?ml|json)$/i.test(a.name) || a.size > 2_000_000) continue;
      const res = await fetch(a.browser_download_url);
      if (!res.ok) throw new Error(`${r.tag_name}/${a.name}: ${res.status}`);
      for (const m of (await res.text()).matchAll(/releases\/download\/([^/"'\s?#]+)\//g)) {
        const tag = decodeURIComponent(m[1]);
        if (tag !== r.tag_name && !keep.has(tag)) {
          keep.set(tag, `linked from ${r.tag_name}/${a.name}`);
          grew = true;
        }
      }
    }
  }
}

const hide = versioned.filter((e) => !keep.has(e.r.tag_name));
console.log(`${pub.length} public releases; ${versioned.length} versioned; hiding ${hide.length}${dry ? ' (dry run)' : ''}`);
for (const [tag, why] of [...keep].filter(([t]) => VERSIONED.test(t)).sort()) console.log(`keep  ${tag}  (${why})`);
for (const e of hide) {
  if (!dry) await api(`/releases/${e.r.id}`, { method: 'PATCH', body: JSON.stringify({ draft: true }) });
  console.log(`${dry ? 'would hide' : 'hid'}  ${e.r.tag_name}`);
}
