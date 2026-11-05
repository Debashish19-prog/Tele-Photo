const VERTEX = `#version 300 es
out vec2 position;

// One triangle big enough to cover the canvas, so there is no vertex buffer to manage.
void main() {
  vec2 corner = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  position = corner;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;

uniform float time;
in vec2 position;
out vec4 fragColor;

// The app's accent, washed out, so the metal belongs to the page without looking painted.
const vec3 TINT = vec3(0.70, 0.79, 1.0);
const float CHANNEL_SPLIT = 0.07;

// The height of the liquid: layered waves, each bending the space the next one is drawn in.
float surface(vec2 p) {
  float height = 0.0;
  float weight = 1.0;
  for (int i = 0; i < 4; i++) {
    float layer = float(i);
    p += 0.5 * vec2(sin(p.y * 1.7 + layer * 1.9 + time), cos(p.x * 1.5 - layer * 2.4 - time * 0.7));
    height += weight * sin(p.x * 1.3 + p.y * 0.9 + layer);
    weight *= 0.62;
  }
  return height;
}

vec3 normalAt(vec2 p) {
  const float e = 0.01;
  vec2 slope = vec2(
    surface(p + vec2(e, 0.0)) - surface(p - vec2(e, 0.0)),
    surface(p + vec2(0.0, e)) - surface(p - vec2(0.0, e))
  ) / (2.0 * e);
  return normalize(vec3(-slope * 0.6, 1.0));
}

// Polished metal mostly shows what it reflects: a bright sky, a hard dark horizon, then lit ground.
float chrome(float y) {
  float sky = mix(0.42, 1.0, sqrt(clamp(y, 0.0, 1.0)));
  float ground = mix(0.05, 0.6, sqrt(clamp(-y, 0.0, 1.0)));
  return mix(ground, sky, smoothstep(-0.02, 0.02, y));
}

void main() {
  vec3 normal = normalAt(position * 4.5);
  float reflected = normal.y * 1.6 + normal.x * 0.5;
  // Each colour bends by a slightly different amount, which is what fringes the horizon lines.
  vec3 light = vec3(
    chrome(reflected - CHANNEL_SPLIT),
    chrome(reflected),
    chrome(reflected + CHANNEL_SPLIT)
  );
  float fresnel = pow(1.0 - normal.z, 1.8);
  fragColor = vec4(light * mix(vec3(1.0), TINT, 0.7) + fresnel * 0.3, 1.0);
}`;

/** Twice the 180px square the ring turns in, which keeps the metal sharp on a high-density screen. */
const SIZE = 360;

interface Renderer {
  canvas: HTMLCanvasElement;
  draw: (time: number) => void;
}

function createRenderer(): Renderer | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
  if (!gl) return null;

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vertex || !fragment) return null;

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  gl.viewport(0, 0, SIZE, SIZE);
  const time = gl.getUniformLocation(program, 'time');
  // The next draw builds a new one. Until then, every ring keeps the last frame it copied.
  canvas.addEventListener('webglcontextlost', () => {
    shared = undefined;
  });

  return {
    canvas,
    draw: (now) => {
      gl.uniform1f(time, now);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** One WebGL context for every ring on screen. Each context is costly, and browsers cap how many a page may hold. */
let shared: Renderer | null | undefined;
const renderer = () => (shared === undefined ? (shared = createRenderer()) : shared);

export type DrawMetal = (time: number) => void;

/** Returns null when WebGL2 is missing or the shader will not build, so the caller can use its fallback. */
export function createMetal(canvas: HTMLCanvasElement): DrawMetal | null {
  // In this order, because an opaque 2D canvas is black from the moment it exists, which would hide the fallback.
  if (!renderer()) return null;
  const target = canvas.getContext('2d', { alpha: false });
  if (!target) return null;
  canvas.width = canvas.height = SIZE;

  return (time) => {
    const source = renderer();
    if (!source) return;
    source.draw(time);
    target.drawImage(source.canvas, 0, 0);
  };
}
