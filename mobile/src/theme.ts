// src/theme.ts — the Ember design tokens, mobile edition (mirrors desktop)
export type ThemeName = 'paper' | 'carbon' | 'phosphor'
export const THEMES: Record<ThemeName, any> = {
  paper: {
    canvas: '#e9e7e2', paper: '#ffffff', panel: '#f2f0eb',
    ink: '#000000', muted: '#605c55', soft: '#6e6a62',
    inv: '#ffffff', line: '#000000', accent: '#c85a19', shadow: 'rgba(0,0,0,0.14)'
  },
  carbon: {
    canvas: '#131311', paper: '#1c1c19', panel: '#262622',
    ink: '#e8e5dc', muted: '#a9a599', soft: '#8f8b7e',
    inv: '#131311', line: '#c9c5b8', accent: '#e8a54b', shadow: 'rgba(0,0,0,0.5)'
  },
  phosphor: {
    canvas: '#0c110d', paper: '#121813', panel: '#1a231c',
    ink: '#dae3d7', muted: '#9cb098', soft: '#87a083',
    inv: '#0c110d', line: '#a8bfa3', accent: '#86e07f', shadow: 'rgba(0,0,0,0.55)'
  }
}
export const MONO = 'monospace'    // Android: 'monospace' maps to Roboto Mono-ish
export const SANS = 'sans-serif'
