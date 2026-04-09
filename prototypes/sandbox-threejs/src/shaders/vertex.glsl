// ============================================================================
// Shader: vertex.glsl
// Purpose: A basic pass-through vertex shader.
// Description:
//   This shader simply passes the UV coordinates to the fragment shader
//   and sets the 2D clip space position for a full-screen or plane quad.
// ============================================================================

// Texture coordinates to be passed to the fragment shader.
varying vec2 vUv;

void main() {
    // Pass the standard Three.js UV coordinates directly to the fragment shader.
    vUv = uv;
    
    // Set the final clip space position.
    gl_Position = vec4(position, 1.0);
}
