# anime·anima

A minimal three.js viewer for **VRM** avatars with switchable animations. A model
stands on a ground plane; two toolbar popovers let you swap the VRM model and the
playing animation, and animation changes are crossfade-tweened.

![toolbar: Model · Animation popovers over a VRM avatar on a ground plane]

## Features

- **VRM loading** via [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm)
  (`GLTFLoader` + `VRMLoaderPlugin`).
- **Two animation formats**, both compiled to clips that drive the VRM's
  *normalized* humanoid bones so a single `AnimationMixer` handles them:
  - `.vrma` — via `@pixiv/three-vrm-animation` (`createVRMAnimationClip`).
  - `.bvh` — via three.js `BVHLoader`, retargeted onto the VRM humanoid. The
    [VRM-Assets-Pack-For-Silly-Tavern](https://github.com/test157t/VRM-Assets-Pack-For-Silly-Tavern)
    BVH files already use VRM humanoid bone names and a T-pose rest, so rotations
    transfer directly and only the hips translation is rescaled to each model.
- **Crossfaded transitions** between animations (`AnimationAction.crossFadeFrom`).
- **Toolbar popovers** with live filtering — one for models, one for animations.
- **Click/tap to move** — tap the ground and the model turns and walks (or
  jogs/crawls, whichever locomotion clip the pack provides) to that spot, then
  returns to the selected animation. Root motion is driven in code with the
  locomotion clip's horizontal hips translation zeroed so the legs cycle in
  place.

## Assets

Models and animations come from
[test157t/VRM-Assets-Pack-For-Silly-Tavern](https://github.com/test157t/VRM-Assets-Pack-For-Silly-Tavern)
and live under `public/vrm-assets/` with a generated `manifest.json`. Re-fetch
them with:

```bash
npm run download-assets            # everything (~215 MB)
node scripts/download-vrm-assets.mts --dry-run
node scripts/download-vrm-assets.mts --only vrm
```

## Development

```bash
npm install
npm run download-assets   # populate public/vrm-assets (only needed once)
npm run dev               # vite dev server
npm run build             # type-check + production build
```

## How it works

| Concern            | File                          |
| ------------------ | ----------------------------- |
| Scene / VRM / mixer / retargeting | `src/viewer.ts`  |
| Toolbar + popovers | `src/ui.ts`                   |
| Manifest → catalog | `src/manifest.ts`             |
| Bootstrap          | `src/main.ts`                 |
| Asset downloader   | `scripts/download-vrm-assets.mts` |
