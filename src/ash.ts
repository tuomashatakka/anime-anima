import * as THREE from 'three'


/**
 * Drifting ash that rains down around the stage. Particles fill a tall cylinder
 * but fade out toward the centre, so the middle (where the avatar is) stays
 * clear while the periphery gets thick with falling embers — denser the closer
 * to the edge. Entirely GPU-driven: only a `time` uniform is updated per frame.
 */
export class AshParticles {
  readonly points:           THREE.Points
  private readonly material: THREE.ShaderMaterial

  constructor (count = 14000, radius = 16, height = 16) {
    const positions = new Float32Array(count * 3)
    const rand      = new Float32Array(count)
    const speed     = new Float32Array(count)
    const size      = new Float32Array(count)

    for (let i = 0; i < count; i++) {
      // Bias the radial distribution outward (sqrt would be uniform-area; the
      // squared term pushes more particles toward the rim).
      const r              = radius * (0.35 + 0.65 * Math.pow(pseudo(i * 1.7), 0.7))
      const angle          = pseudo(i * 3.1) * Math.PI * 2
      positions[i * 3]     = Math.cos(angle) * r
      positions[i * 3 + 1] = pseudo(i * 5.3) * height
      positions[i * 3 + 2] = Math.sin(angle) * r
      rand[i]              = pseudo(i * 7.9)
      speed[i]             = 0.4 + pseudo(i * 11.3) * 1.1
      size[i]              = 1.5 + pseudo(i * 13.7) * 3.5
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 1))
    geometry.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1))
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1))

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite:  false,
      blending:    THREE.NormalBlending,
      uniforms:    {
        uTime:   { value: 0 },
        uHeight: { value: height },
        uColor:  { value: new THREE.Color(0xb9b2a6) },
      },
      vertexShader: /* glsl */`
        attribute float aRand;
        attribute float aSpeed;
        attribute float aSize;
        uniform float uTime;
        uniform float uHeight;
        varying float vAlpha;

        void main() {
          vec3 p = position;
          float fall = uTime * aSpeed + aRand * 100.0;
          p.y = mod(position.y - fall, uHeight);
          p.x += sin(uTime * 0.4 + aRand * 6.2831) * 0.45;
          p.z += cos(uTime * 0.33 + aRand * 6.2831) * 0.45;

          float radial = length(p.xz);
          // Sparse/clear in the middle, intensifying toward the edge.
          vAlpha = smoothstep(3.5, 14.0, radial);
          // Fade in/out at the top/bottom of the column.
          vAlpha *= smoothstep(0.0, 2.0, p.y) * smoothstep(uHeight, uHeight - 3.0, p.y);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = aSize * (260.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vAlpha;

        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float soft = smoothstep(0.5, 0.08, length(d));
          gl_FragColor = vec4(uColor, soft * vAlpha * 0.7);
        }
      `,
    })

    this.points               = new THREE.Points(geometry, this.material)
    this.points.frustumCulled = false
    this.points.renderOrder   = 2
  }

  update (elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed
  }
}

/** Deterministic pseudo-random in [0,1) (no Math.random — banned in this repo). */
function pseudo (n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}
