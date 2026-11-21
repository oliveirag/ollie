import type { FastifyInstance } from 'fastify';
import { PRIVACY_POLICY_TEXT } from '../../published/privacy.js';

/**
 * `GET /privacy`: the policy as a small readable page, for the App Store
 * listing and the link inside the app. Public, unversioned, and outside the
 * OpenAPI document because no client calls it; people read it.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Enough Markdown for this one document: headings, bullets, paragraphs. */
export function renderPolicyHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/);
  const body = blocks
    .map((block) => {
      const lines = block.split('\n');
      if (lines[0]!.startsWith('## ')) return `<h2>${escapeHtml(lines[0]!.slice(3))}</h2>`;
      if (lines[0]!.startsWith('# ')) return `<h1>${escapeHtml(lines[0]!.slice(2))}</h1>`;
      if (lines[0]!.startsWith('- ')) {
        // A bullet's soft-wrapped continuation lines are indented two spaces.
        const items = block
          .split(/\n(?=- )/)
          .map((item) => `<li>${escapeHtml(item.slice(2).replace(/\n\s*/g, ' '))}</li>`);
        return `<ul>${items.join('')}</ul>`;
      }
      return `<p>${escapeHtml(lines.join(' '))}</p>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ollie privacy policy</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 -apple-system, system-ui, sans-serif; max-width: 40rem; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.6rem; } h2 { font-size: 1.15rem; margin-top: 2rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function registerPrivacyRoute(app: FastifyInstance): void {
  const html = renderPolicyHtml(PRIVACY_POLICY_TEXT);
  app.get('/privacy', { schema: { hide: true } }, async (_request, reply) =>
    reply.type('text/html; charset=utf-8').send(html),
  );
}
