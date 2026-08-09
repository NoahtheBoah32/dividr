/** @type {import('tailwindcss').Config} */
// Reuse the desktop theme verbatim (same look), only widen `content` to scan
// the shared frontend under ../src plus this mobile shell.
import rootConfig from '../tailwind.config.js';

export default {
  ...rootConfig,
  content: [
    '../src/**/*.{ts,tsx}',
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
};
