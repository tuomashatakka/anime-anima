/**
 * Procedural, asset-free lighting sprites and meshes for the viewer: lens-flare
 * element textures (drawn on a canvas) and the visible volumetric light cone.
 * Kept out of viewer.ts so the viewer stays focused on scene orchestration.
 */
import * as THREE from 'three'


type FlareCanvasReturnType = { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, half: number }

function flareCanvas (size: number): FlareCanvasReturnType {
  const canvas  = document.createElement('canvas')
  canvas.width  = size
  canvas.height = size
  return { canvas, ctx: canvas.getContext('2d')!, half: size / 2 }
}

function flareTexture (canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture      = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** The main burst: a tight white core, warm halo, faint starburst + anamorphic streak. */
export function makeFlareMain (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const glow                  = ctx.createRadialGradient(half, half, 0, half, half, half)
  glow.addColorStop(0, 'rgba(255,255,255,1)')
  glow.addColorStop(0.05, 'rgba(255,249,233,0.95)')
  glow.addColorStop(0.16, 'rgba(255,228,188,0.30)')
  glow.addColorStop(0.45, 'rgba(255,216,170,0.05)')
  glow.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  ctx.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 12; i++) {
    const angle     = i / 12 * Math.PI * 2
    ctx.strokeStyle = `rgba(255,246,226,${i % 3 === 0 ? 0.3 : 0.14})`
    ctx.lineWidth   = i % 3 === 0 ? 2 : 1
    ctx.beginPath()
    ctx.moveTo(half, half)
    ctx.lineTo(half + Math.cos(angle) * half * 0.96, half + Math.sin(angle) * half * 0.96)
    ctx.stroke()
  }

  const streak = ctx.createLinearGradient(0, half, size, half)
  streak.addColorStop(0, 'rgba(150,190,255,0)')
  streak.addColorStop(0.5, 'rgba(170,205,255,0.5)')
  streak.addColorStop(1, 'rgba(150,190,255,0)')
  ctx.fillStyle = streak
  ctx.fillRect(0, half - size * 0.012, size, size * 0.024)

  return flareTexture(canvas)
}

/** A thin halo ring (anamorphic / aperture diffraction halo). */
export function makeFlareRing (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const ring                  = ctx.createRadialGradient(half, half, half * 0.62, half, half, half * 0.96)
  ring.addColorStop(0, 'rgba(255,255,255,0)')
  ring.addColorStop(0.5, 'rgba(190,215,255,0.5)')
  ring.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = ring
  ctx.fillRect(0, 0, size, size)
  return flareTexture(canvas)
}

/** A soft hexagonal aperture ghost. */
export function makeFlareGhost (size: number): THREE.CanvasTexture {
  const { canvas, ctx, half } = flareCanvas(size)
  const r                     = half * 0.72
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 6 + i * Math.PI / 3
    const x     = half + Math.cos(angle) * r
    const y     = half + Math.sin(angle) * r
    if (i === 0)
      ctx.moveTo(x, y)
    else
      ctx.lineTo(x, y)
  }
  ctx.closePath()
  ctx.clip()

  const fill = ctx.createRadialGradient(half, half, 0, half, half, r)
  fill.addColorStop(0, 'rgba(255,255,255,0.5)')
  fill.addColorStop(0.7, 'rgba(255,255,255,0.16)')
  fill.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = fill
  ctx.fillRect(0, 0, size, size)
  return flareTexture(canvas)
}

/**
 * A visible volumetric light cone (additive) from `from` to `to`: bright near
 * the apex, soft silhouette via a view-angle rim term. Double-sided so the
 * overlapping front/back faces read as a soft shaft of light.
 */
export function makeLightCone (from: THREE.Vector3, to: THREE.Vector3): THREE.Mesh {
  const height   = from.distanceTo(to)
  const radius   = height * 0.16
  const geometry = new THREE.ConeGeometry(radius, height, 40, 1, true)
  geometry.translate(0, -height / 2, 0)

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite:  false,
    blending:    THREE.AdditiveBlending,
    side:        THREE.DoubleSide,
    uniforms:    {
      uColor:  { value: new THREE.Color(0xffffff) },
      uHeight: { value: height },
    },
    vertexShader: /* glsl */`
      varying float vT;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      uniform float uHeight;
      void main() {
        vT = -position.y / uHeight;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormalV = normalize(normalMatrix * normal);
        vViewDir = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vT;
      varying vec3 vNormalV;
      varying vec3 vViewDir;
      uniform vec3 uColor;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewDir))), 1.5);
        float vertical = pow(1.0 - clamp(vT, 0.0, 1.0), 1.15);
        // Additive: keep alpha = 1 and put all brightness in rgb (avoids an a^2 falloff).
        float a = vertical * (0.16 + 0.6 * rim);
        gl_FragColor = vec4(uColor * a * 1.7, 1.0);
      }
    `,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.copy(from)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), to.clone().sub(from)
    .normalize())
  mesh.renderOrder   = 3
  mesh.frustumCulled = false
  return mesh
}
