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
      colors: {
        bg: { main: v('background-gray-main'), menu: v('background-menu-white'), nav: v('background-nav'), login: v('background-gray-login') },
        text: {
          primary: v('text-primary'), secondary: v('text-secondary'),
          tertiary: v('text-tertiary'), disable: v('text-disable'), onblack: v('text-onblack'),
        },
        border: { main: v('border-main'), light: v('border-light'), dark: v('border-dark') },
        fill: { tsp: v('fill-tsp-white-main'), hover: v('fill-tsp-gray-main') },
        func: { error: v('function-error'), success: v('function-success'), warning: v('function-warning') },
      },
      spacing: { titlebar: '48px', row: '36px', 'row-sm': '32px', control: '40px' },
    },
  },
  plugins: [],
} satisfies Config;
