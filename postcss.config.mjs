/** @type {import('postcss').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
    "./compat/chrome-103/postcss.cjs": {},
  },
};

export default config;
