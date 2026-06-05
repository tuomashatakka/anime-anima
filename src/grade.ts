import * as THREE from 'three'


export interface ColorGrade {
  brightness: number
  contrast:   number
  gamma:      number
  saturation: number
}

/** Neutral-ish, slightly dim + punchy defaults for the dramatic look. */
export const DEFAULT_GRADE: ColorGrade = {
  brightness: 0.92,
  contrast:   1.12,
  gamma:      1.05,
  saturation: 1.1,
}

/**
 * A full-screen colour-grading pass: brightness, contrast (about mid-grey),
 * gamma and saturation, all live-adjustable from the settings dialog.
 */
export const ColorGradeShader = {
  name:     'ColorGradeShader',
  uniforms: {
    tDiffuse:   { value: null as THREE.Texture | null },
    brightness: { value: DEFAULT_GRADE.brightness },
    contrast:   { value: DEFAULT_GRADE.contrast },
    gamma:      { value: DEFAULT_GRADE.gamma },
    saturation: { value: DEFAULT_GRADE.saturation },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform float brightness;
    uniform float contrast;
    uniform float gamma;
    uniform float saturation;

    void main() {
      vec4 tex = texture2D( tDiffuse, vUv );
      vec3 c = tex.rgb;

      c *= brightness;
      c = ( c - 0.5 ) * contrast + 0.5;
      c = pow( max( c, 0.0 ), vec3( 1.0 / max( gamma, 0.001 ) ) );

      float luma = dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
      c = mix( vec3( luma ), c, saturation );

      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), tex.a );
    }
  `,
}
