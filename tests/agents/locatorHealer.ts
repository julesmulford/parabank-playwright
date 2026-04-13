/**
 * Locator Healing Agent
 *
 * When a test fails because a locator no longer matches, this agent:
 *  1. Reads the failing test and its page object
 *  2. Reads the live page HTML (via Playwright)
 *  3. Asks Claude to suggest a better locator following the project's priority order
 *  4. Shows the diff and (with --apply) writes the fix
 *
 * Usage:
 *   npx tsx tests/agents/locatorHealer.ts --page tests/pages/RegistrationPage.ts
 *   npx tsx tests/agents/locatorHealer.ts --page tests/pages/LoginPage.ts --apply
 */

import Anthropic from '@anthropic-ai/sdk';
import { chromium } from 'playwright';
import fs from 'fs';

const client = new Anthropic();

const LOCATOR_PRIORITY = `
Locator priority order (best → last resort):
1. getByRole('button', { name: '...' })  — most resilient
2. getByLabel('...')                      — form fields
3. getByTestId('...')                     — data-testid attributes
4. getByText('...') / getByPlaceholder('...')
5. locator('[id="..."]')                  — last resort

NEVER use XPath, CSS class selectors, or positional selectors.
`;

// ── helpers ────────────────────────────────────────────────────────────────

async function getPageHtml(url: string): Promise<string> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(url);
  const html = await page.content();
  await browser.close();
  return html;
}

// ── main ───────────────────────────────────────────────────────────────────

async function healLocators(pageObjectPath: string, apply: boolean) {
  if (!fs.existsSync(pageObjectPath)) {
    console.error(`Page object not found: ${pageObjectPath}`);
    process.exit(1);
  }

  const pageObjectSrc = fs.readFileSync(pageObjectPath, 'utf-8');

  // Extract the URL the page object targets from its class name
  // e.g. RegistrationPage → /parabank/register.htm
  const className = pageObjectPath
    .split(/[\\/]/)
    .pop()!
    .replace('.ts', '');
  const urlMap: Record<string, string> = {
    LoginPage: 'http://localhost:3000/parabank/login.htm',
    RegistrationPage: 'http://localhost:3000/parabank/register.htm',
  };
  const url =
    urlMap[className] ??
    `http://localhost:3000/parabank/${className.replace('Page', '').toLowerCase()}.htm`;

  console.log(`Fetching live HTML from ${url}...`);
  let html = '';
  try {
    html = await getPageHtml(url);
    // Trim to the body to keep token count manageable
    const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
    html = bodyMatch ? bodyMatch[0] : html.slice(0, 8000);
  } catch {
    console.warn('Could not fetch live HTML — Parabank may not be running. Proceeding without it.');
  }

  const prompt = `You are a Playwright locator expert. A page object may have broken locators.

${LOCATOR_PRIORITY}

## Current Page Object (${pageObjectPath})
\`\`\`typescript
${pageObjectSrc}
\`\`\`

${html ? `## Live Page HTML (trimmed)\n\`\`\`html\n${html.slice(0, 6000)}\n\`\`\`` : ''}

Review every locator in the page object. For each one that could be improved or is likely to break:
- Show the original line
- Show the replacement line
- Explain why the new locator is better

If all locators are already optimal, say so.

Then produce the COMPLETE updated TypeScript file with all improvements applied.
Wrap the final file in a \`\`\`typescript ... \`\`\` block.`;

  console.log('Asking Claude to heal locators...\n');

  const stream = await client.messages.stream({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });

  let fullText = '';
  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      process.stdout.write(event.delta.text);
      fullText += event.delta.text;
    }
  }

  console.log('\n');

  if (apply) {
    const match = fullText.match(/```typescript\n([\s\S]*?)```/);
    if (match) {
      fs.writeFileSync(pageObjectPath, match[1]);
      console.log(`Applied fixes to ${pageObjectPath}`);
    } else {
      console.warn('Could not extract updated file from response — no changes written.');
    }
  }
}

// ── entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const pageFlag = args.indexOf('--page');
const pageObjectPath = pageFlag !== -1 ? args[pageFlag + 1] : null;
const apply = args.includes('--apply');

if (!pageObjectPath) {
  console.error(
    'Usage: npx tsx tests/agents/locatorHealer.ts --page tests/pages/MyPage.ts [--apply]',
  );
  process.exit(1);
}

healLocators(pageObjectPath, apply);
