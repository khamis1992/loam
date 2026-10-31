import type { Config } from 'tailwindcss';

const v = (name: string) => `var(--${name})`;

export default {
  darkMode: 'class',
  content: ['./src/app/**/*.{ts,tsx}', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontSize: Object.fromEntries(
        ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'].map((k) => [
          k,
          [v(`ui-font-size-${k}`), { lineHeight: v(`ui-line-height-${k}`) }],
        ]),
      ),
      borderRadius: { row: '10px', control: '8px', card: '12px', composer: '22px' },
      fontFamily: { serif: ['Georgia', 'Times New Roman', 'Times', 'serif'] },
      colors: {
        bg: { main: v('background-gray-main'), menu: v('background-menu-white'), nav: v('background-nav'), login: v('background-gray-login') },
        text: {
          primary: v('text-primary'), secondary: v('text-secondary'),
          tertiary: v('text-tertiary'), disable: v('text-disable'), onblack: v('text-onblack'),
        },
        border: { main: v('border-main'), light: v('border-light'), dark: v('border-dark'), composer: v('border-composer') },
        fill: { tsp: v('fill-tsp-white-main'), hover: v('fill-tsp-gray-main') },
        func: { error: v('function-error'), success: v('function-success'), warning: v('function-warning') },
        // icon-blue was used at 55 call sites but never registered — every
        // text-icon-blue / bg-icon-blue/15 class generated nothing. RGB channel
        // vars + <alpha-value> make the /15-style modifiers actually work.
        icon: { blue: 'rgb(var(--icon-blue-rgb) / <alpha-value>)' },
        status: { active: 'rgb(var(--icon-blue-rgb) / <alpha-value>)' },
      },
      spacing: {
        titlebar: '48px', row: '36px', 'row-sm': '32px', control: '40px',
        // semantic scale (xs 4 / sm 8 / md 16 / lg 24 / xl 32) alongside the sizes above
        xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px',
      },
      transitionDuration: {
        fast: 'var(--motion-fast)', medium: 'var(--motion-medium)', slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        'loam-out': 'var(--motion-ease-out)', 'loam-in-out': 'var(--motion-ease-in-out)',
      },
    },
  },
  plugins: [],
} satisfies Config;
