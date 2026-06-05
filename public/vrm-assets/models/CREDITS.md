# Model credits

## Bundled models

The bundled avatars (`Aera`, `Dhahlia`, `Lara Lightland`, `Onyx`, `Velara`) come
from the
[VRM-Assets-Pack-For-Silly-Tavern](https://github.com/test157t/VRM-Assets-Pack-For-Silly-Tavern),
and `Seed-san` is the VRM Consortium official sample (VRM 1.0) from
[vrm-c/vrm-specification](https://github.com/vrm-c/vrm-specification).

All bundled models are **VRM 1.0**. The earlier VRM 0.0 sample avatars were
removed in favour of the Open Source Avatars catalog below.

## Open Source Avatars (loaded dynamically)

The bulk of the model picker is the
[Open Source Avatars](https://github.com/ToxSam/open-source-avatars) registry —
4000+ **CC0** avatars curated by ToxSam and contributors (100Avatars, VIPE
Heroes, Grifters, Halloween Rising, Xmas Chibis, NeonGlitch86, and more).

These are **not** committed to this repo. Only a lightweight index
(`public/vrm-assets/osa-avatars.json`, regenerated with `npm run fetch-osa`) is
stored; each `.vrm` streams directly from its Arweave URL at runtime (Arweave
serves `Access-Control-Allow-Origin: *`). Most are VRM 0.0, which the BVH
retargeting handles. Per-collection licensing is documented at the source.
