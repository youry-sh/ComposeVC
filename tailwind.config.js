/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          0: "var(--ink-0)",
          50: "var(--ink-50)",
          100: "var(--ink-100)",
          150: "var(--ink-150)",
          200: "var(--ink-200)",
          250: "var(--ink-250)",
          300: "var(--ink-300)",
          400: "var(--ink-400)",
          500: "var(--ink-500)",
          600: "var(--ink-600)",
          700: "var(--ink-700)",
          800: "var(--ink-800)",
          900: "var(--ink-900)",
          950: "var(--ink-950)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          // Soft link/focus only — not a brand fill. Prefer ink primaries for CTAs.
          blue: "var(--accent-soft)",
          fg: "var(--accent-fg)",
          hover: "var(--accent-hover)",
          muted: "var(--accent-muted)",
        },
        panel: {
          DEFAULT: "var(--panel-bg)",
          border: "var(--panel-border)",
          header: "var(--panel-header-bg)",
        },
        // Muted semantic status — themeable
        status: {
          ok: "var(--ok)",
          "ok-bg": "var(--ok-bg)",
          "ok-border": "var(--ok-border)",
          warn: "var(--warn)",
          "warn-bg": "var(--warn-bg)",
          "warn-border": "var(--warn-border)",
          err: "var(--danger)",
          "err-bg": "var(--danger-bg)",
          "err-border": "var(--danger-border)",
        },
      },
      boxShadow: {
        modal: "var(--shadow-modal)",
        menu: "var(--shadow-menu)",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        "fade-in": "fadeIn 0.15s ease-out",
        "slide-in-left": "slideInLeft 0.18s ease-out",
        "logo-pop": "logoPop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)",
        "logo-glow": "logoGlow 1.3s ease-out",
        "logo-rays": "logoRays 1.3s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideInLeft: {
          "0%": { opacity: "0", transform: "translateX(-12px)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
        logoPop: {
          "0%": { transform: "scale(1)" },
          "35%": { transform: "scale(1.22)" },
          "60%": { transform: "scale(0.94)" },
          "100%": { transform: "scale(1)" },
        },
        logoGlow: {
          "0%": { opacity: "0", transform: "scale(0.5)" },
          "35%": { opacity: "0.9", transform: "scale(1.15)" },
          "100%": { opacity: "0", transform: "scale(1.9)" },
        },
        logoRays: {
          "0%": { opacity: "0", transform: "scale(0.4) rotate(0deg)" },
          "25%": { opacity: "1" },
          "100%": { opacity: "0", transform: "scale(1.7) rotate(50deg)" },
        },
      },
    },
  },
  plugins: [],
};
