# anime·anima

A minimal three.js viewer for **VRM** avatars with switchable animations. A model
stands on a ground plane; two toolbar popovers let you swap the VRM model and the
playing animation, and animation changes are crossfade-tweened.

![toolbar: Model · Animation popovers over a VRM avatar on a ground plane]

## Features

- **VRM loading** via [`@pixiv/three-vrm`](https://github.com/pixiv/three-vrm)
  (`GLTFLoader` + `VRMLoaderPlugin`). Ships a dozen models — the original
  SillyTavern pack plus VRM Consortium / VRoid sample avatars (see
  `public/vrm-assets/models/CREDITS.md`).
- **Dramatic stage lighting** (warm key + cool rim + magenta kicker, ACES tone
  mapping) over a **reflective floor** (`Reflector` planar reflections).
- **Two animation formats**, both compiled to clips that drive the VRM's
  *normalized* humanoid bones so a single `AnimationMixer` handles them:
  - `.vrma` — via `@pixiv/three-vrm-animation` (`createVRMAnimationClip`).
  - `.bvh` — via three.js `BVHLoader`, retargeted onto the VRM humanoid. The
    [VRM-Assets-Pack-For-Silly-Tavern](https://github.com/test157t/VRM-Assets-Pack-For-Silly-Tavern)
    BVH files already use VRM humanoid bone names and a T-pose rest, so rotations
    transfer directly and only the hips translation is rescaled to each model.
- **Crossfaded transitions** between animations (`AnimationAction.crossFadeFrom`).
- **Toolbar popovers** with live filtering — one for models, one for animations.
- **Click/tap to move** — tap the ground and the model turns and walks there,
  then returns to the selected animation / idle. Tapping again while moving
  escalates the gait (walk → jog → run); in a low stance it crawls. Root motion
  is driven in code with the locomotion clip's horizontal hips translation zeroed
  so the legs cycle in place.
- **Pose state machine** — every animation is classified into a stance
  (standing / crouching / sitting / lying) by `scripts/classify-animations.mts`.
  Switching to an animation in a different stance inserts the correct transition
  clip when one exists (e.g. `crouch` for stand→crouch, `standup` for
  sit→stand). Non-looping clips (transitions, one-shot gestures) automatically
  settle into their ending stance afterwards.
- **Auto-idle** — with the animation deselected ("None" in the toolbar) the
  model plays random idle clips for its current stance, on a rotating timer.

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
bun install
bun run download-assets   # populate public/vrm-assets (only needed once)
bun run dev               # vite dev server
bun run build             # type-check + production build
bun run lint              # eslint (@tuomashatakka/eslint-config)
```

## How it works

| Concern            | File                          |
| ------------------ | ----------------------------- |
| Scene / VRM / mixer / retargeting | `src/viewer.ts`  |
| Toolbar + popovers | `src/ui.ts`                   |
| Manifest → catalog | `src/manifest.ts`             |
| Stance / transition / idle queries | `src/library.ts` |
| Bootstrap          | `src/main.ts`                 |
| Asset downloader   | `scripts/download-vrm-assets.mts` |
| Animation classifier | `scripts/classify-animations.mts` → `public/vrm-assets/classification.json` |
