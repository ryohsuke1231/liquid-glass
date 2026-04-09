# Liquid Glass (GNOME Extension Prototype)

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)

A WebGL/Three.js prototype recreating Apple's "Liquid Glass" UI (introduced in iOS 26 / macOS Tahoe). 

I love the look of Apple's Liquid Glass, but since I don't own any Apple products (I use an Android smartphone and a Linux computer), I wanted a way to see it on my desktop every day. So, I decided to build a GNOME Shell Extension. 

This repository contains the WebGL/Three.js prototype where I perfected the math, shaders, and optical effects before porting it to GNOME.

![Liquid Glass Preview](image.png)

## ✨ Features

### Shader Processing & Optical Effects
* **Refraction via Snell's Law**: Calculates realistic light bending using the Index of Refraction (IOR). It projects the refracted view vector onto the background plane to determine spatial displacement.
* **Volume Profiling**: Computes interior depth using Superellipse cross-section formulas, allowing the capsule to simulate fluid-like thickness (`max_z`) and smooth height falloffs toward the edges.
* **Chromatic Aberration**: Displaces RGB color channels independently based on the refraction direction, simulating prismatic effects at the edges of the volume.
* **Adaptive Anti-Aliasing (Pseudo-MSAA)**: Implements dynamic multi-tap sampling. It adjusts the sampling radius based on the steepness of the surface normal, smoothing out jaggies caused by steep texture displacement.
* **Complex Lighting Model**: Combines directional rim lighting with fresnel falloff, specular highlights, and surface sheen matched to 3D surface normals rather than flat 2D gradients.

### Background & Blur Processing
* **Gaussian Blur Pipeline**: Uses a separate fragment shader (`gaussianBlur.frag`) to apply a multi-pass, kernel-based gaussian blur to the background texture before it is sampled by the main glass shader.
* **Stabilized UV Mapping**: Enforces edge clamping and smooth falloffs to prevent the refracted UV coordinates from sampling out-of-bounds pixels or wrapping artifacts.

### Interactive Configuration & UI
* **Real-time [Tuning] Panel**: Provides granular slider controls for tweaking all shader uniforms instantly. Parameters include Displacement Scale, IOR, Thickness, Chromatic strength, Shininess, Light Angle, Edge Feather, and Tinting.
* **Variable Stage Dimensions**: Allows users to dynamically change the width and height of the rendering area while recalculating limits and respecting fixed corner radii.
* **Background Image Replacement**: Supports uploading custom local images (PNG, JPG) to test the optical effects against different visual patterns and color spaces, instantly updating the underlying scene.

## 📖 The Story Behind the Math
Recreating the perfect "glass" look was a journey of trial and error. 

Initially, I tried using a raw SDF (Signed Distance Field) directly as the height map, but it resulted in a "hipped roof" shape with sharp ridges. I then tried combining straight lines and circular arcs, but the sudden change in curvature caused unnatural, sharp distortions in the light refraction. 

The breakthrough was implementing a **Superellipse** and properly defining the normal vectors (displacement field). This finally solved the distortion issues and gave the UI that perfect, melting surface tension.

## 🚀 How to Run the Prototype

This prototype is built with Three.js and Vite.

```bash
# Install dependencies
npm install

# Start the development server
npm run dev
```