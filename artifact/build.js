// Builds the claude.ai version of Work Tracker into one HTML page:
//   node artifact/build.js   ->   artifact/dist/work-tracker.html
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const here = __dirname;
const out = path.join(here, 'dist', 'work-tracker.html');

const bundle = esbuild.buildSync({
  entryPoints: [path.join(here, 'src', 'js', 'app.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  write: false,
  legalComments: 'none',
}).outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = fs.readFileSync(path.join(here, 'src', 'styles.css'), 'utf8');
const shell = fs.readFileSync(path.join(here, 'src', 'shell.html'), 'utf8');

const html = `<title>Work Tracker</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&display=swap">
<style>
${css}
</style>
${shell}
<script>
${bundle}
</script>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${path.relative(process.cwd(), out)} (${Math.round(html.length / 1024)} KB)`);
