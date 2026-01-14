/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // UI Colors from spec
        background: '#1a1a2e',
        panel: '#16213e',
        border: '#0f3460',
        'text-primary': '#f5f5f5',
        'text-secondary': '#a0a0a0',
        accent: '#4ecdc4',
        warning: '#ffcb77',
        error: '#ff6b6b',
        success: '#95e1d3',
        // Section palette colors
        'section-teal': '#4ecdc4',
        'section-coral': '#ff6b6b',
        'section-mint': '#95e1d3',
        'section-salmon': '#f38181',
        'section-lavender': '#aa96da',
        'section-pink': '#fcbad3',
        'section-sky': '#a8d8ea',
        'section-peach': '#ffcb77',
        // Map colors
        grid: '#333366',
        'zero-datum': '#ffd700',
        'virtual-shot': 'rgba(255, 255, 255, 0.25)',
        'loop-closure': '#ffcb77',
      },
    },
  },
  plugins: [],
};
