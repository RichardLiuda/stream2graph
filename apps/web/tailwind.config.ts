import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "../../packages/ui/src/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-body)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-body)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 16px 48px rgba(15, 23, 42, 0.08)",
      },
      colors: {
        accent: "var(--accent)",
        "accent-strong": "var(--accent-strong)",
      },
    },
  },
  plugins: [
    function themeVariants({ addVariant }: { addVariant: (name: string, def: string) => void }) {
      addVariant("theme-dark", '[data-theme="dark"] &');
      addVariant("theme-light", '[data-theme="light"] &');
    },
  ],
};

export default config;
